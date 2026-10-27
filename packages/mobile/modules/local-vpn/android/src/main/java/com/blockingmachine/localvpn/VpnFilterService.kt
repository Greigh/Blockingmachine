package com.blockingmachine.localvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.blockingmachine.localvpn.tcp.DirectUpstream
import com.blockingmachine.localvpn.tcp.HubUpstream
import com.blockingmachine.localvpn.tcp.Packet
import com.blockingmachine.localvpn.tcp.TcpDispatcher
import com.blockingmachine.localvpn.tcp.TcpStats
import com.blockingmachine.localvpn.tcp.UdpDispatcher
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Local-VPN filter, in two postures:
 *
 *  - DNS-only (default): advertises a virtual resolver address as the device's
 *    DNS server and routes only that address into the TUN fd. Blocked domains
 *    get NXDOMAIN; allowed ones relay upstream over a `protect()`ed socket.
 *    Everything else never touches us.
 *
 *  - Hub capture (`EXTRA_HUB_HOST`): additionally routes ALL traffic so the
 *    userspace TCP stack can impersonate flows aimed at TCP :80/:443 and
 *    splice them to the hub engine — a `protect()`ed `Socket(hub, 9294)` with
 *    a PROXY-v2 header carrying the app's real 5-tuple. Every other TCP port
 *    gets a `protect()`ed pass-through relay to the original destination so
 *    non-web connectivity is unchanged. UDP gets a [UdpDispatcher] relay —
 *    one `protect()`ed DatagramSocket per (src,dst) pair — because the broad
 *    routes pull EVERY datagram into the tun and without a relay NTP/STUN/
 *    WireGuard would black-hole. Two exceptions keep their posture: UDP/443
 *    (QUIC) is counted and dropped so HTTP/3 falls back into the TCP path,
 *    and UDP/53 stays with the DNS path (DnsPacket claims it first — the
 *    filter still answers). Multicast/broadcast UDP can't pass a connected
 *    unicast socket, and ICMP has no relay — those still drop.
 *
 * `protect()` on every upstream dial is the loop-prevention guarantee that
 * lets the broad routes coexist with the hub dial — those sockets can never
 * re-enter the fd. Extras are sticky across ACTION_START: a re-START (e.g.
 * enabling capture on a running DNS filter) changes only what it carries.
 * The tun's single writer serializes every emit path on one lock around a
 * blocking `output.write` — a wedged fd stalls all senders at once (a global
 * head-of-line stall, inherent to the single-fd design).
 */
class VpnFilterService : VpnService() {

  companion object {
    const val ACTION_START = "com.blockingmachine.localvpn.START"
    const val ACTION_STOP = "com.blockingmachine.localvpn.STOP"
    const val ACTION_STOP_CAPTURE = "com.blockingmachine.localvpn.STOP_CAPTURE"
    const val EXTRA_RULES_PATH = "rulesPath"
    const val EXTRA_UPSTREAM = "upstreamDns"
    const val EXTRA_LABEL = "label"
    const val EXTRA_HUB_HOST = "hubHost"

    /** Virtual resolver advertised to apps; routed into the tunnel. */
    const val VIRTUAL_DNS = "10.0.0.53"

    /** The hub engine's PROXY-v2 data listener — fixed convention. */
    const val HUB_DATA_PORT = 9294

    /** The tun's own virtual addresses — read by the module's hub-host guard. */
    const val TUN_ADDR = "10.0.0.2"
    const val TUN_ADDR6 = "fd00::2"
    private const val CHANNEL_ID = "blockingmachine_vpn"
    private const val NOTIF_ID = 42
    private const val TAG = "BmVpnFilter"

    /** Session housekeeping cadence — drives retransmit-lite + the idle reaper. */
    private const val TICK_MS = 100L

    val running = AtomicBoolean(false)
    val blockedCount = AtomicLong(0)
    val forwardedCount = AtomicLong(0)
    val quicDropped = AtomicLong(0)
    val captureRunning = AtomicBoolean(false)

    /** Live capture-flow counters while capture is armed — the module's status read. */
    @Volatile
    var captureStats: TcpStats? = null
      private set
  }

  private val scope = CoroutineScope(Dispatchers.IO + Job())
  private var tun: ParcelFileDescriptor? = null
  private var readerJob: Job? = null
  private var blocklist: Blocklist? = null
  private var upstream: InetAddress = InetAddress.getByName("8.8.8.8")
  private var rulesPath: String? = null
  private var label: String = "Blockingmachine"

  @Volatile private var hubHost: String? = null
  @Volatile private var captureDispatcher: TcpDispatcher? = null
  @Volatile private var relayDispatcher: TcpDispatcher? = null
  @Volatile private var udpDispatcher: UdpDispatcher? = null
  @Volatile private var ticker: Thread? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
      ACTION_STOP_CAPTURE -> { stopCapture(); return START_NOT_STICKY }
      ACTION_START -> {
        intent.getStringExtra(EXTRA_UPSTREAM)
          ?.let { runCatching { InetAddress.getByName(it) }.getOrNull() }
          ?.let { upstream = it }
        intent.getStringExtra(EXTRA_RULES_PATH)?.let { rulesPath = it }
        intent.getStringExtra(EXTRA_LABEL)?.let { label = it }
        // hasExtra distinguishes "not carried" (keep current) from an explicit
        // empty host (clear capture) — the extra is sticky, not a one-shot.
        if (intent.hasExtra(EXTRA_HUB_HOST)) {
          hubHost = intent.getStringExtra(EXTRA_HUB_HOST)?.trim()?.takeIf { it.isNotEmpty() }
        }
        blocklist = rulesPath?.let {
          runCatching { Blocklist.load(it) }
            .onFailure { e -> Log.w(TAG, "ruleset load failed for $it: $e") }
            .getOrNull()
        }
        if (blocklist == null) {
          if (rulesPath != null) Log.w(TAG, "no ruleset at $rulesPath — VPN will forward unfiltered")
          else Log.i(TAG, "no ruleset configured — VPN will forward unfiltered")
          blocklist = Blocklist.EMPTY
        } else {
          Log.i(TAG, "ruleset loaded: ${blocklist!!.size} rules")
        }
        startTunnel(label)
        return START_STICKY
      }
    }
    return START_NOT_STICKY
  }

  private fun startTunnel(label: String) {
    // A re-START replaces the fd — tear the previous tunnel down first so the
    // old reader can't keep feeding packets into stale dispatchers.
    teardownTunnel()
    startForegroundServiceCompat(label)

    val builder = Builder()
      .setSession("Blockingmachine")
      .addAddress(TUN_ADDR, 32)
      .addDnsServer(VIRTUAL_DNS)
      .setMtu(1500)
      .setBlocking(true)

    if (hubHost != null) {
      // Capture posture: route everything so TCP :80/:443 can be dispatched
      // to the hub and the rest relayed. The hub IP needs no route exclusion —
      // protect() on every upstream dial is the loop exemption by construction.
      builder.addAddress(TUN_ADDR6, 128)
        .addRoute("0.0.0.0", 0)
        .addRoute("::", 0)
    } else {
      // Route only the virtual resolver — real traffic stays off the tunnel.
      builder.addRoute(VIRTUAL_DNS, 32)
    }

    val pfd = builder.establish() ?: run {
      Log.e(TAG, "VpnService.Builder.establish() returned null — VPN permission?")
      shutdown()
      return
    }
    tun = pfd
    running.set(true)
    updateNotification(
      if (hubHost != null) "$label · filtering DNS + HTTPS capture" else "$label · filtering DNS"
    )
    readerJob = scope.launch { readLoop(pfd, this) }
  }

  private fun readLoop(pfd: ParcelFileDescriptor, cs: CoroutineScope) {
    val input = FileInputStream(pfd.fileDescriptor)
    val output = FileOutputStream(pfd.fileDescriptor)
    // The fd's single writer — dispatcher emits (this thread, per-session
    // upstream readers, the ticker) and DNS responses all serialize here.
    val emitLock = Any()
    val emit: (ByteArray) -> Unit = { pkt ->
      synchronized(emitLock) { runCatching { output.write(pkt) } }
    }
    val buf = ByteArray(32767)
    val upstreamSock = DatagramSocket()
    protect(upstreamSock) // forwarding traffic must not loop back into the tunnel

    val hub = hubHost
    if (hub != null) {
      // :80/:443 → the hub engine (PROXY-v2); every other TCP port → a
      // protected pass-through to the original destination; UDP → the
      // datagram relay (without it the broad routes black-hole everything
      // that isn't DNS or QUIC).
      val capture = TcpDispatcher(
        emit = emit,
        upstreamFactory = { key -> HubUpstream(key, hub, HUB_DATA_PORT, { s: Socket -> protect(s) }) },
      )
      val relay = TcpDispatcher(
        emit = emit,
        upstreamFactory = { key -> DirectUpstream(key, { s: Socket -> protect(s) }) },
        portFilter = { true }, // capture claims :80/:443 first — this is the remainder
      )
      val udp = UdpDispatcher(
        emit = emit,
        protect = { s: DatagramSocket -> protect(s) },
      )
      captureDispatcher = capture
      relayDispatcher = relay
      udpDispatcher = udp
      captureStats = capture.stats
      captureRunning.set(true)
      startTicker()
      Log.i(TAG, "hub capture armed — TCP :80/:443 → $hub:$HUB_DATA_PORT, UDP relayed")
    }

    while (cs.isActive) {
      val n = try {
        input.read(buf)
      } catch (e: Exception) {
        break // fd closed on shutdown
      }
      if (n <= 0) continue
      val packet = buf.copyOf(n)
      val query = DnsPacket.parseQuery(packet)

      if (query == null) {
        // Non-DNS traffic only exists while the capture posture routes it in.
        if (relayDispatcher == null) continue
        if (Packet.peekUdpDstPort(packet) == 443) {
          // QUIC suppression — counted; the TCP fallback lands in the stack.
          // Precedes the UDP relay so HTTP/3 still can't bypass filtering.
          quicDropped.incrementAndGet()
          continue
        }
        if (captureDispatcher?.onPacket(packet) == true) continue
        if (relayDispatcher?.onPacket(packet) == true) continue
        if (udpDispatcher?.onPacket(packet) == true) continue
        continue // ICMP et al. — no consumer, honest drop
      }

      if (blocklist?.isBlocked(query.domain) == true) {
        blockedCount.incrementAndGet()
        if (blockedCount.get() <= 20) Log.i(TAG, "blocked: ${query.domain}")
        emit(DnsPacket.buildResponse(query, blocked = true))
        continue
      }

      if (forwardedCount.get() < 20) Log.d(TAG, "forwarded: ${query.domain}")

      forwardedCount.incrementAndGet()
      // Forward the raw DNS body upstream; relay the answer back into the tunnel.
      scope.launch {
        try {
          val dnsBody = DnsPacket.extractDns(packet) ?: return@launch
          val req = DatagramPacket(dnsBody, dnsBody.size, upstream, 53)
          upstreamSock.send(req)
          val respBuf = ByteArray(4096)
          val resp = DatagramPacket(respBuf, respBuf.size)
          upstreamSock.soTimeout = 5000
          upstreamSock.receive(resp)
          val dns = respBuf.copyOf(resp.length)
          emit(DnsPacket.buildResponse(query, blocked = false, relay = dns))
        } catch (e: Exception) {
          // Upstream timeout/failure → answer nothing; the client retransmits.
        }
      }
    }
  }

  /** 100ms housekeeping for the dispatchers — retransmit-lite + idle reaps. */
  private fun startTicker() {
    ticker?.interrupt()
    val t = Thread {
      // The exit condition is supersession: teardown interrupts us and a
      // newer tunnel's ticker replaces `ticker` — either way this loop ends.
      while (ticker === Thread.currentThread()) {
        val c = captureDispatcher
        val r = relayDispatcher
        val u = udpDispatcher
        if (c == null && r == null && u == null) break
        // One runCatching each — a throwing tick must not skip its siblings.
        runCatching { c?.onTick() }
        runCatching { r?.onTick() }
        runCatching { u?.onTick() }
        try {
          Thread.sleep(TICK_MS)
        } catch (e: InterruptedException) {
          break
        }
      }
    }
    t.name = "bm-tcp-tick"
    t.isDaemon = true
    ticker = t // assigned before start — the loop can never see a stale value
    t.start()
  }

  /**
   * Capture off, tunnel up: re-establish on the narrow DNS-only routes.
   * Keeping the broad routes with the relay dispatchers would keep every
   * app flow detoured through userspace long after the user asked to stop;
   * the rebuild RSTs in-flight relayed flows (the old fd dies) — apps
   * reconnect, and real traffic never enters the tunnel again.
   */
  private fun stopCapture() {
    hubHost = null
    if (running.get()) {
      startTunnel(label) // tears the old tunnel + dispatchers down first
    } else {
      teardownTunnel()
      stopSelf()
    }
  }

  /** Tear down the current tunnel — safe to call with none established. */
  private fun teardownTunnel() {
    readerJob?.cancel()
    readerJob = null
    ticker?.interrupt()
    ticker = null
    captureDispatcher?.close()
    captureDispatcher = null
    relayDispatcher?.close()
    relayDispatcher = null
    udpDispatcher?.close()
    udpDispatcher = null
    captureStats = null
    captureRunning.set(false)
    tun?.close()
    tun = null
  }

  private fun startForegroundServiceCompat(label: String) {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Blockingmachine filter", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(
        this, 0, it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val notif = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("$label filter running")
      .setContentText("On-device DNS filtering is active")
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
      .setOngoing(true)
      .apply { if (launch != null) setContentIntent(launch) }
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun updateNotification(text: String) {
    val nm = getSystemService(NotificationManager::class.java)
    val notif = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Blockingmachine filter running")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
      .setOngoing(true)
      .build()
    nm.notify(NOTIF_ID, notif)
  }

  private fun shutdown() {
    running.set(false)
    teardownTunnel()
    stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }
}

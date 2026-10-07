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
import android.system.OsConstants
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Local-VPN DNS filter. Instead of routing all traffic through the tunnel (the
 * battery-heavy full-VPN design), it advertises a virtual resolver address as the
 * device's DNS server and routes only that address into the TUN fd. System DNS
 * lookups land on the tunnel; everything else never touches us.
 *
 * Blocked domains get NXDOMAIN; allowed ones are relayed to the real upstream
 * over a `protect()`ed socket so the forwarding traffic itself never re-enters
 * the tunnel. This covers all protocols that depend on DNS — including HTTPS —
 * at domain granularity. SNI-level TLS interception is deliberately out of
 * scope (it needs a userspace TCP stack); the CONNECT proxy handles the cases
 * where an app bypasses system DNS.
 */
class VpnFilterService : VpnService() {

  companion object {
    const val ACTION_START = "com.blockingmachine.localvpn.START"
    const val ACTION_STOP = "com.blockingmachine.localvpn.STOP"
    const val EXTRA_RULES_PATH = "rulesPath"
    const val EXTRA_UPSTREAM = "upstreamDns"
    const val EXTRA_LABEL = "label"

    /** Virtual resolver advertised to apps; routed into the tunnel. */
    const val VIRTUAL_DNS = "10.0.0.53"
    private const val TUN_ADDR = "10.0.0.2"
    private const val CHANNEL_ID = "blockingmachine_vpn"
    private const val NOTIF_ID = 42
    private const val TAG = "BmVpnFilter"

    val running = AtomicBoolean(false)
    val blockedCount = AtomicLong(0)
    val forwardedCount = AtomicLong(0)
  }

  private val scope = CoroutineScope(Dispatchers.IO + Job())
  private var tun: ParcelFileDescriptor? = null
  private var readerJob: Job? = null
  private var blocklist: Blocklist? = null
  private var upstream: InetAddress = InetAddress.getByName("8.8.8.8")

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
      ACTION_START -> {
        upstream = intent.getStringExtra(EXTRA_UPSTREAM)
          ?.let { runCatching { InetAddress.getByName(it) }.getOrNull() }
          ?: upstream
        val rulesPath = intent.getStringExtra(EXTRA_RULES_PATH)
        blocklist = rulesPath?.let {
          runCatching { Blocklist.load(it) }
            .onFailure { e -> Log.w(TAG, "ruleset load failed for $rulesPath: $e") }
            .getOrNull()
        }
        if (blocklist == null) {
          Log.w(TAG, "no ruleset at $rulesPath — VPN will forward unfiltered")
          blocklist = Blocklist.EMPTY
        } else {
          Log.i(TAG, "ruleset loaded: ${blocklist!!.size} rules")
        }
        startTunnel(intent.getStringExtra(EXTRA_LABEL) ?: "Blockingmachine")
        return START_STICKY
      }
    }
    return START_NOT_STICKY
  }

  private fun startTunnel(label: String) {
    startForegroundServiceCompat(label)

    val pfd = Builder()
      .setSession("Blockingmachine")
      .addAddress(TUN_ADDR, 32)
      .addDnsServer(VIRTUAL_DNS)
      // Route only the virtual resolver — real traffic stays off the tunnel.
      .addRoute(VIRTUAL_DNS, 32)
      .setMtu(1500)
      .setBlocking(true)
      .establish() ?: run {
        Log.e(TAG, "VpnService.Builder.establish() returned null — VPN permission?")
        shutdown()
        return
      }
    tun = pfd
    running.set(true)
    updateNotification("$label · filtering DNS")
    readerJob = scope.launch { readLoop(pfd) }
  }

  private fun readLoop(pfd: ParcelFileDescriptor) {
    val input = FileInputStream(pfd.fileDescriptor)
    val output = FileOutputStream(pfd.fileDescriptor)
    val buf = ByteArray(32767)
    val upstreamSock = DatagramSocket()
    protect(upstreamSock) // forwarding traffic must not loop back into the tunnel

    while (scope.isActive) {
      val n = try {
        input.read(buf)
      } catch (e: Exception) {
        break // fd closed on shutdown
      }
      if (n <= 0) continue
      val packet = buf.copyOf(n)
      val query = DnsPacket.parseQuery(packet) ?: continue

      if (blocklist?.isBlocked(query.domain) == true) {
        blockedCount.incrementAndGet()
        if (blockedCount.get() <= 20) Log.i(TAG, "blocked: ${query.domain}")
        val out = DnsPacket.buildResponse(query, blocked = true)
        output.write(out)
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
          val out = DnsPacket.buildResponse(query, blocked = false, relay = dns)
          synchronized(output) { output.write(out) }
        } catch (e: Exception) {
          // Upstream timeout/failure → answer nothing; the client retransmits.
        }
      }
    }
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
    readerJob?.cancel()
    tun?.close()
    tun = null
    stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }
}

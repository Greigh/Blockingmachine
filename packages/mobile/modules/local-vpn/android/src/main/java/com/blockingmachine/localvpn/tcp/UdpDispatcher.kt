package com.blockingmachine.localvpn.tcp

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * Pass-through UDP relay for the capture posture (P4 T2 review).
 *
 * The broad capture routes drag EVERY UDP datagram into the tun fd, but only
 * :53 (the DNS path) and :443 (QUIC suppression) had consumers — NTP, STUN,
 * WireGuard and every other UDP flow black-holed. This dispatcher restores
 * honest connectivity: each (src,dst) pair gets a `protect()`ed
 * [DatagramSocket] `connect()`ed at the original destination — tun UDP goes
 * out the real socket, replies come back rebuilt as IP+UDP packets for the
 * tun write. `connect` is what makes the socket protected-by-construction
 * loop-safe AND filters stray replies to the right peer.
 *
 * Limits are deliberately small: [maxSessions] pairs with LRU eviction
 * (eviction just closes the socket — UDP has no RST to send), [idleTimeoutMs]
 * silence reap on [onTick], and one daemon reader thread per pair. Sessions
 * are born lazily on the first datagram — a pair with no answer traffic dies
 * at the idle deadline without ever having cost a thread wakeup.
 *
 * Multicast/broadcast can't relay through a connected unicast socket — those
 * datagrams still go nowhere (documented on the service header). DNS never
 * reaches here: the service's `DnsPacket.parseQuery` claims :53 first.
 *
 * Threading: [onPacket] runs on the tun reader, [onTick]/[close] on the
 * service's housekeeping paths; per-session state is confined to the session.
 */
class UdpDispatcher(
  private val emit: (ByteArray) -> Unit,
  private val protect: (DatagramSocket) -> Unit,
  private val socketFactory: () -> DatagramSocket = { DatagramSocket() },
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val maxSessions: Int = 512,
  private val idleTimeoutMs: Long = 60_000L,
) {

  /** Dispatcher-visible counters — the service's status surface can read them. */
  val flowsOpened = AtomicLong()
  val flowsClosed = AtomicLong()
  val datagramsIn = AtomicLong()
  val datagramsOut = AtomicLong()

  val sessions = ConcurrentHashMap<FlowKey, UdpSession>()

  /** Set by [close] — a closed dispatcher refuses packets, like [TcpDispatcher]. */
  @Volatile
  private var closed = false

  /** Insertion-ordered touch log for LRU eviction — guarded by [lruLock]. */
  private val lruLock = Any()
  private val lru = LinkedHashMap<FlowKey, Long>()

  /**
   * Route one IP packet read from tun. Returns true when the packet was UDP
   * (consumed — even when it turned out unparseable or the dial failed: it
   * was aimed at a UDP relay, not at any other path).
   */
  fun onPacket(ip: ByteArray): Boolean {
    if (closed) return false
    if (Packet.peekIpProtocol(ip) != Packet.PROTO_UDP) return false
    val dgram = Packet.parseUdp(ip) ?: return true // UDP but malformed → drop
    datagramsIn.incrementAndGet()
    val key = FlowKey(dgram.family, dgram.srcAddr, dgram.srcPort, dgram.dstAddr, dgram.dstPort)

    var session = sessions[key]
    if (session == null) {
      evictIfNeeded()
      val fresh = try {
        UdpSession(key, emit, protect, socketFactory, nowMs, ::datagramSent)
      } catch (e: Exception) {
        return true // socket create/protect/connect failed → drop this datagram
      }
      // Mirror of the TCP dial race: two readers can both create for the same
      // pair — the loser closes its socket, not leaks it.
      val prev = sessions.putIfAbsent(key, fresh)
      if (prev == null) {
        session = fresh
        flowsOpened.incrementAndGet()
        if (closed) {
          // close() raced our insert and may already have swept — undo it.
          removeSession(key, fresh)
          fresh.close()
          return true
        }
      } else {
        fresh.close()
        session = prev
      }
    }
    touch(key)
    session.send(dgram.payload)
    if (session.closed.get()) removeSession(key, session)
    return true
  }

  /** Periodic housekeeping — the idle reap; same cadence as the TCP tick. */
  fun onTick() {
    if (closed) return
    val now = nowMs()
    for ((k, s) in sessions.entries) {
      if (now - s.lastActivityMs > idleTimeoutMs) {
        s.close()
        removeSession(k, s)
      }
    }
  }

  /** Number of live relay pairs. */
  fun activeCount(): Int = sessions.size

  /** Tear every relay pair down (service shutdown / capture stop). Idempotent. */
  fun close() {
    closed = true
    for ((k, s) in sessions.entries) {
      s.close()
      removeSession(k, s)
    }
    synchronized(lruLock) { lru.clear() }
  }

  private fun datagramSent() { datagramsOut.incrementAndGet() }

  private fun removeSession(key: FlowKey, session: UdpSession) {
    if (sessions.remove(key, session)) {
      flowsClosed.incrementAndGet()
      synchronized(lruLock) { lru.remove(key) }
    }
  }

  private fun touch(key: FlowKey) {
    synchronized(lruLock) {
      lru.remove(key)
      lru[key] = nowMs()
    }
  }

  private fun evictIfNeeded() {
    while (sessions.size >= maxSessions) {
      val victimKey = synchronized(lruLock) {
        val k = lru.keys.firstOrNull()
        if (k != null) lru.remove(k)
        k
      } ?: sessions.keys.firstOrNull() ?: return
      val victim = sessions.remove(victimKey) ?: continue
      victim.close() // no RST exists for UDP — the socket just goes away
      flowsClosed.incrementAndGet()
    }
  }
}

/**
 * One relay pair: a `protect()`ed datagram socket connected at the pair's
 * destination, plus a daemon reader that rebuilds replies into tun packets.
 * The socket dials and binds lazily inside the constructor's `connect` —
 * cheap enough to run on the tun reader.
 */
class UdpSession(
  val key: FlowKey,
  private val emit: (ByteArray) -> Unit,
  protect: (DatagramSocket) -> Unit,
  socketFactory: () -> DatagramSocket,
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val onSent: () -> Unit = {},
) {

  val closed = AtomicBoolean(false)

  /** Monotonic ms of the last send/recv — the dispatcher's idle reap reads it. */
  @Volatile
  var lastActivityMs: Long = nowMs()
    private set

  private val socket: DatagramSocket = socketFactory().also { s ->
    protect(s) // the dial must bypass the tun or every datagram loops
    s.connect(InetAddress.getByAddress(key.dstAddr), key.dstPort)
  }

  private val reader = thread(name = "bm-udp-r", isDaemon = true) { readerLoop() }

  /** Client→server datagram — called from the tun reader via the dispatcher. */
  fun send(payload: ByteArray) {
    if (closed.get()) return
    lastActivityMs = nowMs()
    try {
      // Connected socket → an address-less packet goes to the connected peer.
      socket.send(DatagramPacket(payload, payload.size))
      onSent()
    } catch (e: Exception) {
      close() // a dead socket can't recover — the next datagram re-dials
    }
  }

  /** Close the socket and let the reader exit. Idempotent. */
  fun close() {
    if (closed.compareAndSet(false, true)) {
      runCatching { socket.close() }
    }
  }

  private fun readerLoop() {
    val buf = ByteArray(65535)
    while (!closed.get()) {
      val p = DatagramPacket(buf, buf.size)
      try {
        socket.receive(p)
      } catch (e: Exception) {
        return // closed socket → the thread exits quietly
      }
      lastActivityMs = nowMs()
      // Reply rebuilds the packet with the tuple swapped — from the server's
      // addr:port back to the app's, exactly what a real NAT returns.
      emit(
        Packet.buildUdpDatagram(
          family = key.family,
          srcAddr = key.dstAddr,
          dstAddr = key.srcAddr,
          srcPort = key.dstPort,
          dstPort = key.srcPort,
          payload = p.data.copyOfRange(p.offset, p.offset + p.length),
        )
      )
    }
  }
}

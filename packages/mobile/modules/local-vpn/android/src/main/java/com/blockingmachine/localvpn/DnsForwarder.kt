package com.blockingmachine.localvpn

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/**
 * Allowed-DNS forwarder over one shared upstream socket — flag 130.
 *
 * The shape it replaces had each forwarded query `send()` on the shared
 * socket and then block in its own `receive()` — with two queries in flight,
 * whichever coroutine's receive ran first took whichever reply arrived, so a
 * reply to query B could land in query A's coroutine (and B's real reply then
 * had no reader). Here ONE receive coroutine owns the socket and demuxes
 * replies to waiting queries.
 *
 * The demux key is a REWRITTEN transaction id, not the client's own: each
 * forward allocates a fresh random 16-bit id and stamps it over the query's
 * txid before send (a `SecureRandom` — with a shared socket the source port
 * is fixed, so the upstream-leg txid carries the collision/poisoning burden
 * alone). Two clients picking the same txid can't collide on the wire, and
 * the reply's txid is rewritten back to the client's before the body rides
 * out verbatim. The socket is `connect()`ed at the upstream, so datagrams
 * from any other peer never reach the loop — the source-address half of
 * reply matching is enforced by the OS.
 *
 * Bounds: [maxPending] waiting queries with oldest-first eviction (a DNS
 * pending is one-shot, so insertion order IS wait-age order), [timeoutMs]
 * per-query expiry on a coroutine timer, and counters for what the demux
 * couldn't claim — `droppedUnknown` (late, stray, evicted, or a txid
 * collision answering a different question) and `receiveErrors` (receive()
 * failures tolerated without killing the loop).
 *
 * Threading: [forward] runs on the tun reader (send is a queued datagram,
 * never awaited); the receive loop and per-query timers ride a child scope
 * of [parentScope] so service/tunnel death cancels them — [close] still runs
 * on teardown to release the socket fd promptly rather than at GC.
 */
class DnsForwarder(
  private val upstream: InetAddress,
  private val emit: (query: DnsPacket.Query, dns: ByteArray) -> Unit,
  private val protect: (DatagramSocket) -> Unit = {},
  private val socketFactory: () -> DatagramSocket = { DatagramSocket() },
  parentScope: CoroutineScope = CoroutineScope(Dispatchers.IO),
  private val stats: Stats = Stats(),
  private val upstreamPort: Int = 53,
  private val maxPending: Int = 128,
  private val timeoutMs: Long = 5_000L,
) {

  /** Demux counters — the service passes a companion-held instance so they survive tunnel rebuilds. */
  class Stats(
    val droppedUnknown: AtomicLong = AtomicLong(),
    val timedOut: AtomicLong = AtomicLong(),
    val evicted: AtomicLong = AtomicLong(),
    /** receive() failures survived by the demux loop — spikes mean upstream/NIC trouble. */
    val receiveErrors: AtomicLong = AtomicLong(),
  )

  private data class Pending(val query: DnsPacket.Query, val timer: Job)

  private val scope = CoroutineScope(
    parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext.job),
  )

  private val socket: DatagramSocket = socketFactory().also { s ->
    try {
      protect(s) // forwarding must not loop back into the tunnel
      s.connect(upstream, upstreamPort)
    } catch (e: Exception) {
      runCatching { s.close() } // a failed dial must not leak the fd
      throw e
    }
  }

  /** Rewritten-txid → waiting query. */
  private val pending = ConcurrentHashMap<Int, Pending>()

  /** Insertion order for oldest-first eviction — guarded by [lruLock]. */
  private val lruLock = Any()
  private val lru = LinkedHashMap<Int, Unit>()

  private val closed = AtomicBoolean(false)
  private val random = SecureRandom()

  private val receiver: Job = scope.launch { receiveLoop() }

  /**
   * Forward [query]'s DNS body upstream. Called on the tun reader — the reply
   * is delivered to [emit] by the receive loop, never awaited here.
   */
  fun forward(query: DnsPacket.Query) {
    if (closed.get()) return
    if (query.rawDns.size < 12) return // too short to be a DNS message — drop honestly
    evictIfNeeded()
    val id = allocUpstreamId()
    val dns = query.rawDns.copyOf()
    dns[0] = (id ushr 8).toByte()
    dns[1] = (id and 0xFF).toByte()
    val timer = scope.launch {
      delay(timeoutMs)
      if (removePending(id) != null) stats.timedOut.incrementAndGet()
    }
    pending[id] = Pending(query, timer)
    track(id)
    try {
      socket.send(DatagramPacket(dns, dns.size, upstream, upstreamPort))
    } catch (e: Exception) {
      // A dead socket leaves nothing to wait for — reclaim the pending slot.
      if (removePending(id) != null) timer.cancel()
    }
  }

  /** Queries currently awaiting an upstream reply — test + status visibility. */
  fun pendingCount(): Int = pending.size

  /** Stop the receive loop, drop every waiter, close the socket. Idempotent. */
  fun close() {
    if (closed.compareAndSet(false, true)) {
      runCatching { socket.close() } // unblocks a parked receive()
      scope.cancel() // receiver + per-query timers die here
      pending.clear()
      synchronized(lruLock) { lru.clear() }
    }
  }

  /** A random upstream txid not currently pending — retries then evicts if the map is pathologically dense. */
  private fun allocUpstreamId(): Int {
    repeat(64) {
      val id = random.nextInt(0x10000)
      if (!pending.containsKey(id)) return id
    }
    // Unreachable in practice (maxPending ≪ 65536 ids) — never hand back a
    // duplicate: evict the eldest and keep sampling.
    evictOldest()
    return allocUpstreamId()
  }

  private fun evictIfNeeded() {
    while (pending.size >= maxPending) {
      if (!evictOldest()) return
    }
  }

  private fun evictOldest(): Boolean {
    val victimId = synchronized(lruLock) {
      lru.keys.firstOrNull()?.also { lru.remove(it) }
    } ?: pending.keys.firstOrNull() ?: return false
    // A null remove means a timeout/reply already claimed the slot — the lru
    // entry was still consumed, so the loop makes progress either way.
    removePending(victimId)?.let {
      it.timer.cancel()
      stats.evicted.incrementAndGet()
    }
    return true
  }

  private fun track(id: Int) {
    synchronized(lruLock) {
      lru.remove(id)
      lru[id] = Unit
    }
  }

  private fun removePending(id: Int): Pending? {
    val p = pending.remove(id) ?: return null
    synchronized(lruLock) { lru.remove(id) }
    return p
  }

  /**
   * The demux: the ONLY reader of the shared socket. Each datagram's txid is
   * looked up in [pending]; a hit whose question section echoes the pending
   * query's gets the body back with the client's own txid restored; a miss
   * (late, stray, evicted, or a colliding txid answering a different
   * question) is dropped and counted — never delivered to the wrong query.
   *
   * The loop exits ONLY on teardown ([closed] or a dead socket). Any other
   * receive() failure is per-datagram, not fatal — e. a
   * [java.net.PortUnreachableException] an ICMP error raises on this
   * connected socket when the upstream refuses a query, or a transient NIC
   * flap. Returning on such an error would kill the only demux while
   * [forward] keeps sending: a silent device-wide DNS outage until the next
   * tunnel rebuild. Survivable errors are counted and backed off linearly
   * (capped at [RECEIVE_BACKOFF_CAP_MS]) so a persistently failing socket
   * can't spin the loop hot; datagrams landing during the sleep sit in the
   * socket buffer and are demuxed when it resumes.
   */
  private suspend fun receiveLoop() {
    val buf = ByteArray(4096)
    var consecutiveErrors = 0
    while (!closed.get() && scope.isActive) {
      val pkt = DatagramPacket(buf, buf.size)
      try {
        socket.receive(pkt)
      } catch (e: Exception) {
        if (closed.get() || socket.isClosed) return // teardown — nothing more can arrive
        stats.receiveErrors.incrementAndGet()
        consecutiveErrors += 1
        delay(minOf(RECEIVE_BACKOFF_CAP_MS, RECEIVE_BACKOFF_STEP_MS * consecutiveErrors))
        continue
      }
      consecutiveErrors = 0
      if (pkt.length < 12) {
        stats.droppedUnknown.incrementAndGet() // too short for a DNS header
        continue
      }
      val id = ((pkt.data[pkt.offset].toInt() and 0xFF) shl 8) or
        (pkt.data[pkt.offset + 1].toInt() and 0xFF)
      val dns = pkt.data.copyOfRange(pkt.offset, pkt.offset + pkt.length)
      // Peek before consuming: the rewritten txid is the only demux entropy
      // on a connected socket (the OS pins the peer addr:port), so a hit must
      // also prove it answers THIS question — qname+qtype+qclass echo the
      // pending query's byte-for-byte. A colliding reply drops without
      // consuming the slot, leaving room for the real answer.
      val p = pending[id]
      if (p == null || !questionMatches(dns, p.query.rawDns)) {
        stats.droppedUnknown.incrementAndGet()
        continue
      }
      if (removePending(id) == null) {
        // The per-query timeout claimed the slot between peek and remove —
        // this reply arrived too late; count it like any unclaimed datagram.
        stats.droppedUnknown.incrementAndGet()
        continue
      }
      p.timer.cancel()
      dns[0] = (p.query.transactionId ushr 8).toByte()
      dns[1] = (p.query.transactionId and 0xFF).toByte()
      runCatching { emit(p.query, dns) }
    }
  }

  /**
   * Does [reply] echo [queryDns]'s question section? Both sides bound their
   * first question (uncompressed QNAME run + QTYPE + QCLASS) and the spans
   * compare byte-for-byte — the cheap proof that a txid-keyed datagram really
   * answers the pending query rather than colliding with it. A question that
   * won't parse can't be verified, so it can never match.
   */
  private fun questionMatches(reply: ByteArray, queryDns: ByteArray): Boolean {
    val rEnd = questionEnd(reply)
    if (rEnd < 0 || rEnd != questionEnd(queryDns)) return false
    for (i in 12 until rEnd) {
      if (reply[i] != queryDns[i]) return false
    }
    return true
  }

  /**
   * End offset of the first question (the byte after QCLASS) in a bare DNS
   * message, or -1 when no well-formed uncompressed question is present. A
   * 0xC0 label would be name compression, which a query question never
   * carries — unverifiable either way.
   */
  private fun questionEnd(dns: ByteArray): Int {
    var i = 12 // QNAME starts past the 12-byte header
    while (i < dns.size) {
      val len = dns[i].toInt() and 0xFF
      if (len == 0) {
        val end = i + 5 // root byte + QTYPE(2) + QCLASS(2)
        return if (end <= dns.size) end else -1
      }
      if (len and 0xC0 != 0) return -1
      i += 1 + len
    }
    return -1
  }

  private companion object {
    /** Receive-error backoff: linear steps to the cap — a wedged socket can't spin hot. */
    const val RECEIVE_BACKOFF_STEP_MS = 25L
    const val RECEIVE_BACKOFF_CAP_MS = 1_000L
  }
}

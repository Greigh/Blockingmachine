package com.blockingmachine.localvpn.tcp

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Dispatcher-visible counters. [rst] counts every RST this stack emits;
 *  [reasmDropped] counts inbound bytes dropped inside the reassembly queue. */
class TcpStats {
  val flowsOpened = AtomicLong()
  val flowsClosed = AtomicLong()
  val rst = AtomicLong()
  val reasmDropped = AtomicLong()
}

/**
 * Flow router between the tun fd and per-flow [TcpSession]s (P4 T1).
 *
 * `onPacket` is called with each IP packet read from the tunnel. Packets whose
 * TCP destination port satisfies [portFilter] (default: 80 and 443 — the
 * capture pair) are consumed here — everything else returns `false` so the
 * service can route it to its pass-through posture. After [close] the
 * dispatcher refuses packets outright, letting traffic fall through to the
 * relay path instead of resurrecting flows.
 *
 * A session is born on a bare SYN (the [upstreamFactory] seam hands T2 a
 * `protect()`ed socket dial to the hub); a non-SYN packet for an unknown flow
 * gets a bare RST back — the same answer a real stack gives a port with no
 * listener. The table is bounded ([maxSessions]) with LRU eviction — the
 * evicted flow gets RST'd so the app sees a clean failure instead of a hang.
 *
 * [upstreamFactory] runs on the tun reader thread — it MUST NOT block:
 * return an already-connected socket or a queue-backed upstream whose dial
 * completes on another thread.
 *
 * `onTick` drives each session's retransmit-lite + idle reap; wire it to a
 * ~50–100ms service-side timer.
 *
 * Threading: `onPacket`/`onTick`/`close` are safe to call from the tun reader
 * thread and a timer thread concurrently; per-session state serializes inside
 * the session itself.
 */
class TcpDispatcher(
  private val emit: (ByteArray) -> Unit,
  private val upstreamFactory: (FlowKey) -> SessionUpstream,
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val maxSessions: Int = 1024,
  private val portFilter: (Int) -> Boolean = { it == 80 || it == 443 },
) {

  val stats = TcpStats()
  val sessions = ConcurrentHashMap<FlowKey, TcpSession>()

  /** Set by [close] — a closed dispatcher refuses packets so the caller's
   *  fallback path (pass-through relay) can claim them. */
  @Volatile
  private var closed = false

  /** Insertion-ordered touch log for LRU eviction — guarded by [lruLock]. */
  private val lruLock = Any()
  private val lru = LinkedHashMap<FlowKey, Long>()

  /**
   * Route one IP packet read from tun. Returns true when the packet was
   * consumed by the capture path (TCP dst 80/443 — consumed even when the
   * packet turned out unparseable: it was aimed at us).
   */
  fun onPacket(ip: ByteArray): Boolean {
    if (closed) return false
    val dstPort = Packet.peekTcpDstPort(ip) ?: return false
    if (!portFilter(dstPort)) return false
    val seg = Packet.parseTcp(ip) ?: return true
    val key = FlowKey(seg)

    var session = sessions[key]
    if (session == null) {
      if (!seg.isSyn) {
        // Packet for a flow we have no TCB for — the listener-port answer.
        if (!seg.has(Packet.FLAG_RST)) {
          stats.rst.incrementAndGet()
          emit(Packet.buildRstReply(seg))
        }
        return true
      }
      evictIfNeeded()
      val fresh = try {
        TcpSession(key, emit, upstreamFactory(key), nowMs = nowMs, stats = stats)
      } catch (e: Exception) {
        // Upstream dial seam failed at birth — RST like a refused connection.
        stats.rst.incrementAndGet()
        emit(Packet.buildRstReply(seg))
        return true
      }
      // Two racing readers can both dial upstream for the same flow — the
      // loser of putIfAbsent must not leak its upstream socket (abortWithRst
      // emits nothing while the session is still CLOSED).
      val prev = sessions.putIfAbsent(key, fresh)
      if (prev == null) {
        session = fresh
        stats.flowsOpened.incrementAndGet()
      } else {
        fresh.abortWithRst()
        session = prev
      }
    }
    touch(key)
    session.onPacket(ip)
    if (session.terminated) removeSession(key, session)
    return true
  }

  /**
   * Periodic housekeeping — retransmit-lite ticks + idle reaping inside each
   * session. Weakly-consistent CHM iteration is fine: a session that appears
   * or dies mid-sweep is handled next tick.
   */
  fun onTick() {
    if (closed) return
    val now = nowMs()
    for ((k, s) in sessions.entries) {
      if (s.onTick(now)) removeSession(k, s)
    }
  }

  /** Number of live flows — the T2 status surface reads this. */
  fun activeCount(): Int = sessions.size

  /** Deadline of the next idle expiry — lets the caller sleep until needed. */
  fun nextReapDeadlineMs(): Long {
    var min = Long.MAX_VALUE
    for (s in sessions.values) min = minOf(min, s.idleDeadlineMs)
    return min
  }

  /** Tear every flow down (service shutdown / capture stop). Idempotent. */
  fun close() {
    closed = true
    for ((k, s) in sessions.entries) {
      s.abortWithRst()
      removeSession(k, s)
    }
    synchronized(lruLock) { lru.clear() }
  }

  private fun removeSession(key: FlowKey, session: TcpSession) {
    if (sessions.remove(key, session)) {
      stats.flowsClosed.incrementAndGet()
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
      victim.abortWithRst()
      stats.flowsClosed.incrementAndGet()
    }
  }
}

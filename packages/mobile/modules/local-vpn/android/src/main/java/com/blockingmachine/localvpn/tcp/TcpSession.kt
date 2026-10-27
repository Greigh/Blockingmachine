package com.blockingmachine.localvpn.tcp

import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.TreeMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 5-tuple identifying one captured TCP flow. `src` is the on-device app
 * (client) side; `dst` is the original destination the app dialled — the
 * addresses as they appear in client→server packets read from the tun fd.
 * ByteArray keys use content equality so the dispatcher's ConcurrentHashMap
 * hashes on tuple value, not identity.
 */
class FlowKey(
  val family: Int,
  val srcAddr: ByteArray,
  val srcPort: Int,
  val dstAddr: ByteArray,
  val dstPort: Int,
) {
  constructor(seg: Packet.TcpSegment) :
    this(seg.family, seg.srcAddr, seg.srcPort, seg.dstAddr, seg.dstPort)

  override fun equals(other: Any?): Boolean =
    other is FlowKey &&
      family == other.family &&
      srcPort == other.srcPort &&
      dstPort == other.dstPort &&
      srcAddr.contentEquals(other.srcAddr) &&
      dstAddr.contentEquals(other.dstAddr)

  override fun hashCode(): Int {
    var h = family
    h = 31 * h + srcAddr.contentHashCode()
    h = 31 * h + srcPort
    h = 31 * h + dstAddr.contentHashCode()
    h = 31 * h + dstPort
    return h
  }

  override fun toString(): String =
    "FlowKey(v$family ${fmtIp(srcAddr)}:$srcPort -> ${fmtIp(dstAddr)}:$dstPort)"

  private fun fmtIp(a: ByteArray): String = when (a.size) {
    4 -> a.joinToString(".") { (it.toInt() and 0xFF).toString() }
    16 -> buildString {
      for (i in 0 until 16 step 2) {
        if (i > 0) append(':')
        append(((a[i].toInt() and 0xFF) shl 8 or (a[i + 1].toInt() and 0xFF)).toString(16))
      }
    }
    else -> a.joinToString("") { "%02x".format(it) }
  }
}

/**
 * The service-side end of a captured flow (T2 wires the real one: a
 * `protect()`ed socket to the hub with the PROXY-v2 header already written).
 *
 * All methods are invoked under the session's monitor, in order — an
 * implementation MUST NOT block: enqueue bytes for a writer thread instead.
 */
interface SessionUpstream {
  /**
   * The owning session hands itself over once constructed — upstreams that
   * pump bytes back (a socket reader feeding [TcpSession.onUpstreamData])
   * store it here. Called inside the session's constructor, before any
   * packet or byte can arrive. Default no-op for upstreams that only sink.
   */
  fun attach(session: TcpSession) {}

  /** In-order client→server stream bytes. Implementations take the whole array. */
  fun write(bytes: ByteArray)

  /** The client sent FIN — no further bytes will arrive; shutdown upstream output. */
  fun closeOut()

  /** The flow died (RST/idle/eviction/upstream error) — tear everything down. */
  fun abort()
}

/**
 * Per-flow transmission control block — the userspace TCP endpoint that
 * impersonates the app's original destination on the tun interface.
 *
 * Lifecycle (we are always the passive/accepting side — the client on-device
 * opens every flow):
 *
 *   CLOSED ── SYN ──► SYN_RECV ── handshake ACK ──► ESTABLISHED
 *   ESTABLISHED ── client FIN ──► CLOSE_WAIT ── upstream EOF, FIN sent ──► LAST_ACK ── ACK ──► CLOSED
 *   ESTABLISHED ── upstream EOF, FIN sent ──► FIN_WAIT_1 ── ACK ──► FIN_WAIT_2 ── client FIN ──► TIME_WAIT ──► CLOSED
 *   (simultaneous close collapses into FIN_WAIT_1 until our FIN is ACKed, then TIME_WAIT)
 *
 * Anything malformed or state-violating gets an RST and the session
 * terminates. `onTick` drives the bounded retransmit and the idle reaper —
 * call it from the dispatcher's tick.
 *
 * Retransmit-lite — deliberately NOT a congestion stack: our peer (the app)
 * is on the same device, so the only loss domain is the tun queue itself —
 * rare and never congestion-driven. A fixed ~200ms RTO with 3 retries covers
 * emulator/scheduling edge cases; beyond that the flow is dead and gets RST.
 * There is no cwnd, no fast retransmit, no RTT estimator.
 *
 * Threading: every public method serializes on an internal monitor, so the
 * tun reader thread and upstream reader threads may call concurrently.
 * Emits and upstream calls happen under the monitor — ordering is the
 * correctness guarantee; [SessionUpstream] implementations must not block.
 */
class TcpSession(
  val key: FlowKey,
  private val emit: (ByteArray) -> Unit,
  private val upstream: SessionUpstream,
  initialSeq: Long = nextIssn(),
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val stats: TcpStats? = null,
) {

  enum class State { CLOSED, SYN_RECV, ESTABLISHED, FIN_WAIT_1, FIN_WAIT_2, CLOSE_WAIT, LAST_ACK, TIME_WAIT }

  companion object {
    /** Fixed advertised receive window — no WSOPT is negotiated, so 64KiB-1 is the wire max. */
    const val ADVERTISED_WINDOW = 0xFFFF

    /** Bound on out-of-order buffered bytes per flow — a peer ignoring our window can't grow memory. */
    const val REASM_CAP = 256 * 1024

    /** Bound on reassembly entries — the byte cap alone permits ~256k tiny TreeMap nodes (≈10–20MB/flow). */
    const val REASM_ENTRIES_CAP = 1024

    /**
     * Floor for a peer-advertised send MSS — an MSS option of 0 (or absurdly
     * small) would zero-step the emit loop and livelock the reader thread.
     */
    const val MIN_PEER_MSS = 64

    /** Bound on queued upstream→client bytes when the client's window is shut. */
    const val SEND_CAP = 256 * 1024

    /** Silent this long → RST + terminate (the caller reaps on `onTick`). */
    const val IDLE_TIMEOUT_MS = 60_000L

    /** Fixed retransmit timeout — tun-local losses only, no RTT math. */
    const val RTO_MS = 200L

    /** Bounded retries before the flow is declared dead. */
    const val MAX_RETRIES = 3

    /** TIME_WAIT-lite — just long enough to absorb stray retransmits. */
    const val TIME_WAIT_MS = 1_000L

    private val EMPTY = ByteArray(0)

    /**
     * ISSN source: ONE SecureRandom seeds an AtomicLong, then each connection
     * takes a golden-ratio step — scattered wire seqs at counter cost, not
     * per-connection RNG cost.
     */
    private val issnCounter = AtomicLong(SecureRandom().nextInt().toLong() and 0xFFFF_FFFFL)

    fun nextIssn(): Long = issnCounter.getAndAdd(0x9E37_79B9L) and 0xFFFF_FFFFL

    /** Wrap-aware sequence arithmetic: signed distance between two seqs (valid for |a-b| < 2^31). */
    internal fun seqDiff(a: Long, b: Long): Int = (a - b).toInt()

    internal fun seqAdd(s: Long, n: Int): Long = (s + n) and 0xFFFF_FFFFL
    private fun seqGt(a: Long, b: Long) = seqDiff(a, b) > 0
    private fun seqGe(a: Long, b: Long) = seqDiff(a, b) >= 0
    private fun seqLe(a: Long, b: Long) = seqDiff(a, b) <= 0
    private fun seqLt(a: Long, b: Long) = seqDiff(a, b) < 0
  }

  private val lock = Any()

  @Volatile
  var state = State.CLOSED
    private set

  /** Fully torn down — the dispatcher drops the entry. Read unsynchronized there. */
  @Volatile
  var terminated = false
    private set

  /** Monotonic ms at which an untouched session must be reaped. */
  val idleDeadlineMs: Long
    get() = synchronized(lock) { lastActivityMs + IDLE_TIMEOUT_MS }

  private val issn = initialSeq and 0xFFFF_FFFFL
  private var sndUna = 0L
  private var sndNxt = 0L
  private var rcvNxt = 0L
  private var clientIssn = -1L
  private var clientWnd = 0
  private var sendMss = 1460
  private var ourSynAck: ByteArray? = null

  /** Seq of the client's FIN byte, or -1 — may be recorded before the gap filling it arrives. */
  private var clientFinSeq = -1L
  private var clientFinDone = false

  private var upstreamEof = false
  private var ourFinSeq = -1L
  private var finSentAtMs = 0L
  private var finRetries = 0

  private var lastActivityMs = nowMs()
  private var timeWaitAt = 0L
  private var sendQBytes = 0

  /** Out-of-order inbound queue keyed by seq — total order is valid because
   *  buffered keys are bounded to REASM_CAP distance from rcvNxt (<< 2^31). */
  private val reassem = TreeMap<Long, ByteArray>(Comparator { a, b -> seqDiff(a, b) })
  private var reassemBytes = 0

  private val sendQ = ArrayDeque<ByteArray>()

  /** One in-flight outbound segment, kept for retransmit-lite. */
  private class Sent(var seq: Long, var data: ByteArray, var sentAtMs: Long, var retries: Int)

  private val unacked = ArrayDeque<Sent>()

  init {
    // Last thing the constructor does — every field above is initialized, so
    // the upstream may safely start threads that call back into the session.
    upstream.attach(this)
  }

  /* ------------------------------------------------------------------ */
  /* Inbound — packets read from the tun fd                              */
  /* ------------------------------------------------------------------ */

  /** Feed one IP packet (client→server direction) into the flow. */
  fun onPacket(ipPayload: ByteArray) {
    val seg = Packet.parseTcp(ipPayload) ?: return // unparseable → drop like a real stack
    synchronized(lock) {
      if (terminated) return
      lastActivityMs = nowMs()
      if (seg.has(Packet.FLAG_RST)) {
        // RFC 5961 §3.2: only an RST landing exactly on rcvNxt aborts; anything
        // else is answered with a challenge ACK so a blind RST can't kill the flow.
        if (seqDiff(seg.seq, rcvNxt) == 0) terminateAborted() else emitAck()
        return
      }
      when (state) {
        State.CLOSED -> onSyn(seg)
        State.SYN_RECV -> onSynRecv(seg)
        State.TIME_WAIT -> onTimeWait(seg)
        else -> onDataSegment(seg)
      }
    }
  }

  private fun onSyn(seg: Packet.TcpSegment) {
    if (!seg.isSyn) { sendRstFor(seg); terminateAborted(); return }
    clientIssn = seg.seq
    rcvNxt = seqAdd(seg.seq, 1)
    clientWnd = seg.window
    val clientMss = Packet.advertisedMss(seg.options)
    sendMss = maxOf(MIN_PEER_MSS, minOf(clientMss ?: defaultSendMss(), defaultSendMss()))
    // SYN-ACK: options = bare MSS (negotiated-min, floored) — SACK/TS/WS dropped.
    val mss = maxOf(MIN_PEER_MSS, minOf(Packet.OUR_MSS, clientMss ?: Packet.OUR_MSS))
    ourSynAck = emitSegment(
      Packet.FLAG_SYN or Packet.FLAG_ACK,
      EMPTY,
      seqOverride = issn,
      options = Packet.synAckOptions(mss),
    )
    sndUna = issn
    sndNxt = seqAdd(issn, 1)
    state = State.SYN_RECV
  }

  private fun onSynRecv(seg: Packet.TcpSegment) {
    if (seg.isSyn) {
      if (seg.seq == clientIssn && ourSynAck != null) emit(ourSynAck!!) // client SYN retransmit
      else { sendRstFor(seg); terminateAborted() }
      return
    }
    if (!seg.has(Packet.FLAG_ACK) || seg.ack != sndNxt || seg.seq != rcvNxt) {
      sendRstFor(seg); terminateAborted(); return // bad handshake ACK — RST
    }
    clientWnd = seg.window
    sndUna = seg.ack // the SYN's sequence byte is now acknowledged
    state = State.ESTABLISHED
    if (seg.payload.isNotEmpty() || seg.has(Packet.FLAG_FIN)) {
      processRcv(seg) // payload/FIN riding the third ACK
      if (!terminated) emitAck()
    }
    flushSendQueue()
    maybeEmitFin()
  }

  private fun onDataSegment(seg: Packet.TcpSegment) {
    if (seg.has(Packet.FLAG_ACK)) {
      if (seqGt(seg.ack, sndNxt)) { sendRstFor(seg); terminateAborted(); return } // ACK of never-sent data
      if (seqGt(seg.ack, sndUna)) {
        sndUna = seg.ack
        pruneUnacked()
        if (ourFinSeq >= 0 && seqGt(sndUna, ourFinSeq)) onOurFinAcked()
        if (terminated) return
      }
    }
    clientWnd = seg.window

    if (clientFinDone && seg.payload.isNotEmpty() && seqGt(seqAdd(seg.seq, seg.payload.size), rcvNxt)) {
      // Data beyond the client's own FIN — a state violation, not a loss case.
      sendRstFor(seg); terminateAborted(); return
    }

    if (seg.payload.isNotEmpty() || seg.has(Packet.FLAG_FIN)) {
      processRcv(seg)
      if (terminated) return
      emitAck()
    }
    flushSendQueue()
    maybeEmitFin()
  }

  private fun onTimeWait(seg: Packet.TcpSegment) {
    // Stray retransmits of the client's FIN get one more ACK; everything else drops.
    if (seg.has(Packet.FLAG_FIN)) emitAck()
  }

  /** Payload + FIN receive path with bounded out-of-order reassembly. */
  private fun processRcv(seg: Packet.TcpSegment) {
    var seq = seg.seq
    var data = seg.payload

    // Drop the already-consumed prefix (retransmit overlap).
    val back = seqDiff(rcvNxt, seq)
    if (back > 0) {
      data = if (back >= data.size) EMPTY else data.copyOfRange(back, data.size)
      seq = rcvNxt
    }

    if (data.isNotEmpty()) {
      if (seq == rcvNxt) {
        acceptInbound(data)
        drainReassem()
      } else if (!bufferSegment(seq, data)) {
        sendRstFor(seg); terminateAborted(); return
      }
    }

    if (seg.has(Packet.FLAG_FIN)) {
      val finSeq = seqAdd(seg.seq, seg.payload.size)
      // finSeq behind rcvNxt = retransmit of an already-consumed FIN.
      if (seqGe(finSeq, rcvNxt) && (clientFinSeq < 0 || seqLt(finSeq, clientFinSeq))) clientFinSeq = finSeq
    }
    // Unconditional: a FIN arriving ahead of a reassembly gap only records
    // clientFinSeq — the non-FIN segment that later fills the gap must still
    // consume it. No-op when no FIN is pending.
    checkClientFin()
  }

  private fun acceptInbound(data: ByteArray) {
    if (!upstreamEof) upstream.write(data) // else: half-closed upstream — ACK it anyway, drop it
    rcvNxt = seqAdd(rcvNxt, data.size)
  }

  private fun drainReassem() {
    while (reassem.isNotEmpty()) {
      val e = reassem.firstEntry() ?: return
      val overlap = seqDiff(rcvNxt, e.key)
      if (overlap < 0) return // gap still ahead
      val fresh = if (overlap >= e.value.size) EMPTY else e.value.copyOfRange(overlap, e.value.size)
      reassemBytes -= e.value.size
      reassem.pollFirstEntry()
      if (fresh.isNotEmpty()) acceptInbound(fresh)
    }
  }

  /**
   * Buffer one out-of-order segment — bounded two ways: no byte more than
   * REASM_CAP ahead of rcvNxt (a peer can't legitimately be that far out — we
   * advertised 64KiB), and REASM_CAP total buffered bytes. Returning false
   * means overflow → the caller RSTs the flow.
   */
  private fun bufferSegment(seq: Long, data: ByteArray): Boolean {
    val ahead = seqDiff(seq, rcvNxt)
    if (ahead <= 0 || ahead > REASM_CAP) return false // also kills the 2^31-ambiguous key
    var s = seq
    var d = data
    // Trim the part an already-buffered entry covers (retransmit overlap).
    reassem.floorEntry(s)?.let { floor ->
      val cover = seqDiff(seqAdd(floor.key, floor.value.size), s)
      if (cover > 0) {
        if (cover >= d.size) { stats?.reasmDropped?.incrementAndGet(); return true }
        d = d.copyOfRange(cover, d.size)
        s = seqAdd(s, cover)
      }
    }
    // Trim the tail overlapping the next buffered entry.
    reassem.ceilingEntry(s)?.let { next ->
      val cut = seqDiff(seqAdd(s, d.size), next.key)
      if (cut > 0) {
        d = d.copyOfRange(0, d.size - cut)
        if (d.isEmpty()) { stats?.reasmDropped?.incrementAndGet(); return true }
      }
    }
    if (reassemBytes + d.size > REASM_CAP) return false
    if (!reassem.containsKey(s) && reassem.size >= REASM_ENTRIES_CAP) return false
    reassem[s]?.let { reassemBytes -= it.size } // exact-seq duplicate replaces in place
    reassem[s] = d
    reassemBytes += d.size
    return true
  }

  private fun checkClientFin() {
    if (clientFinSeq >= 0 && !clientFinDone && seqGe(rcvNxt, clientFinSeq)) consumeClientFin()
  }

  private fun consumeClientFin() {
    clientFinDone = true
    rcvNxt = seqAdd(rcvNxt, 1)
    upstream.closeOut()
    when (state) {
      State.ESTABLISHED -> state = State.CLOSE_WAIT
      State.FIN_WAIT_1 -> if (seqGt(sndUna, ourFinSeq)) enterTimeWait() // else stay — CLOSING folded in
      State.FIN_WAIT_2 -> enterTimeWait()
      else -> {}
    }
  }

  private fun onOurFinAcked() {
    when (state) {
      State.FIN_WAIT_1 -> if (clientFinDone) enterTimeWait() else state = State.FIN_WAIT_2
      State.LAST_ACK -> terminate()
      else -> {}
    }
  }

  private fun enterTimeWait() {
    timeWaitAt = nowMs()
    state = State.TIME_WAIT
  }

  /* ------------------------------------------------------------------ */
  /* Outbound — bytes arriving from the upstream (hub) socket            */
  /* ------------------------------------------------------------------ */

  /** Upstream→client stream bytes — emitted as segments honoring the client's advertised window. */
  fun onUpstreamData(bytes: ByteArray) {
    synchronized(lock) {
      lastActivityMs = nowMs() // upstream traffic is liveness too — a long download must not idle-reap
      if (terminated || bytes.isEmpty()) return
      if (ourFinSeq >= 0 || state == State.TIME_WAIT || state == State.CLOSED) return
      sendQ.add(bytes.copyOf())
      sendQBytes += bytes.size
      if (sendQBytes > SEND_CAP) {
        // Client window shut while upstream keeps pushing — bound memory, kill the flow.
        abortWithRst()
        return
      }
      flushSendQueue()
    }
  }

  /** Upstream EOF → FIN to the client once the send queue drains. */
  fun onUpstreamEof() {
    synchronized(lock) {
      lastActivityMs = nowMs()
      if (terminated || upstreamEof) return
      upstreamEof = true
      flushSendQueue()
      maybeEmitFin()
    }
  }

  /** Upstream socket failure → RST to the client, flow dead. */
  fun onUpstreamError() {
    synchronized(lock) { abortWithRst() }
  }

  private fun canSendNow() =
    (state == State.ESTABLISHED || state == State.CLOSE_WAIT) && ourFinSeq < 0

  private fun flushSendQueue() {
    while (sendQ.isNotEmpty() && canSendNow()) {
      val inFlight = seqDiff(sndNxt, sndUna)
      val usable = clientWnd - inFlight
      if (usable <= 0) return // client window shut — the queue flushes on the next ACK
      val head = sendQ.peekFirst() ?: return
      val n = minOf(usable, sendMss, head.size)
      if (n <= 0) return // defensive: a zero-step would spin this loop (MIN_PEER_MSS makes it unreachable)
      sendQ.removeFirst()
      sendQBytes -= head.size
      val chunk: ByteArray
      if (n == head.size) {
        chunk = head
      } else {
        chunk = head.copyOfRange(0, n)
        sendQ.addFirst(head.copyOfRange(n, head.size))
        sendQBytes += head.size - n
      }
      emitSegment(Packet.FLAG_ACK or Packet.FLAG_PSH, chunk)
      unacked.addLast(Sent(sndNxt, chunk, nowMs(), 0))
      sndNxt = seqAdd(sndNxt, n)
    }
  }

  private fun maybeEmitFin() {
    if (!upstreamEof || ourFinSeq >= 0 || sendQ.isNotEmpty()) return
    // FIN only flies on a flow that can legally send one — an upstream EOF
    // arriving mid-handshake stays latched; the post-handshake call emits it.
    if (state != State.ESTABLISHED && state != State.CLOSE_WAIT) return
    emitSegment(Packet.FLAG_FIN or Packet.FLAG_ACK, EMPTY)
    ourFinSeq = sndNxt
    sndNxt = seqAdd(sndNxt, 1)
    finSentAtMs = nowMs()
    state = when (state) {
      State.ESTABLISHED -> State.FIN_WAIT_1
      State.CLOSE_WAIT -> State.LAST_ACK
      else -> state
    }
  }

  private fun pruneUnacked() {
    while (unacked.isNotEmpty()) {
      val s = unacked.first
      val end = seqAdd(s.seq, s.data.size)
      if (seqGt(end, sndUna)) {
        val cut = seqDiff(sndUna, s.seq) // partially ACKed — resend only the tail
        if (cut > 0) {
          s.data = s.data.copyOfRange(cut, s.data.size)
          s.seq = sndUna
        }
        return
      }
      unacked.removeFirst()
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tick — retransmit-lite + idle reap (driven by the dispatcher)       */
  /* ------------------------------------------------------------------ */

  /**
   * Periodic tick. Returns true when the session is fully terminated and the
   * caller should drop it. Sends RST on idle expiry and on retransmit
   * exhaustion.
   */
  fun onTick(now: Long): Boolean {
    synchronized(lock) {
      if (terminated) return true
      if (now - lastActivityMs > IDLE_TIMEOUT_MS) { abortWithRst(); return true }
      if (state == State.TIME_WAIT && now - timeWaitAt > TIME_WAIT_MS) { terminate(); return true }
      retransmit(now)
      return terminated
    }
  }

  /**
   * Retransmit-lite: resend each unacked segment older than the fixed RTO,
   * bounded to MAX_RETRIES — covers tun-local losses (the only loss domain on
   * a same-device link), then gives up with RST. Deliberately no cwnd /
   * backoff / fast-retransmit: this is not a congestion stack.
   */
  private fun retransmit(now: Long) {
    for (s in unacked) {
      if (now - s.sentAtMs < RTO_MS) break // FIFO: first still-fresh entry stops the scan
      if (s.retries >= MAX_RETRIES) { abortWithRst(); return }
      s.retries++
      s.sentAtMs = now
      emitSegment(Packet.FLAG_ACK or Packet.FLAG_PSH, s.data, seqOverride = s.seq)
    }
    if (ourFinSeq >= 0 && seqLe(sndUna, ourFinSeq) && now - finSentAtMs >= RTO_MS) {
      if (finRetries >= MAX_RETRIES) { abortWithRst(); return }
      finRetries++
      finSentAtMs = now
      emitSegment(Packet.FLAG_FIN or Packet.FLAG_ACK, EMPTY, seqOverride = ourFinSeq)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Emit helpers                                                        */
  /* ------------------------------------------------------------------ */

  private fun emitSegment(
    flags: Int,
    payload: ByteArray,
    seqOverride: Long? = null,
    options: ByteArray = EMPTY,
  ): ByteArray {
    val pkt = Packet.buildTcpSegment(
      family = key.family,
      srcAddr = key.dstAddr,   // we emit as the server — swap the tuple
      dstAddr = key.srcAddr,
      srcPort = key.dstPort,
      dstPort = key.srcPort,
      seq = seqOverride ?: sndNxt,
      ack = rcvNxt,
      flags = flags,
      window = ADVERTISED_WINDOW,
      payload = payload,
      options = options,
    )
    emit(pkt)
    return pkt
  }

  private fun emitAck() {
    emitSegment(Packet.FLAG_ACK, EMPTY)
  }

  /** RST reply for an offending inbound segment (RFC 5961 layout). */
  private fun sendRstFor(seg: Packet.TcpSegment) {
    stats?.rst?.incrementAndGet()
    emit(Packet.buildRstReply(seg))
  }

  private fun defaultSendMss() = if (key.family == Packet.FAMILY_V6) 1440 else 1460

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * End of the flow — graceful or abnormal; the RST (if any) has already been
   * emitted by the caller. [SessionUpstream.abort] runs on EVERY path —
   * idempotent and non-blocking by contract, so it is safe under the monitor.
   * Without it a clean close (LAST_ACK's final ACK, TIME_WAIT expiry) would
   * leave a socket upstream's worker parked on its queue forever — one leaked
   * thread + fd per flow.
   */
  private fun terminate() {
    state = State.CLOSED
    terminated = true
    reassem.clear()
    reassemBytes = 0
    sendQ.clear()
    sendQBytes = 0
    unacked.clear()
    upstream.abort()
  }

  /** Abnormal end where the RST has already been emitted by the caller. */
  private fun terminateAborted() = terminate()

  /** Abnormal end — RST to the client, abort the upstream. Idempotent. */
  fun abortWithRst() {
    synchronized(lock) {
      if (terminated) return
      if (state != State.CLOSED) sendRst()
      terminateAborted()
    }
  }

  private fun sendRst() {
    stats?.rst?.incrementAndGet()
    emitSegment(Packet.FLAG_RST or Packet.FLAG_ACK, EMPTY)
  }
}

package com.blockingmachine.localvpn.tcp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * TcpSession state-machine tests — FakeUpstream + captured emits + a manual
 * clock (retransmit/idle are asserted against `now`, never slept).
 */
class TcpSessionTest {

  private val SRC = byteArrayOf(10, 0, 0, 8)
  private val DST = byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34)
  private val SPORT = 50000
  private val DPORT = 443
  private val ISSN = 0x0000_1000L // our (session) initial seq — deterministic for tests
  private val CISSN = 0x1111_2222L // client initial seq

  private lateinit var emitted: MutableList<ByteArray>
  private lateinit var upstream: FakeUpstream
  private lateinit var key: FlowKey
  private var now = 1_000_000L
  private val clock = { now }
  private lateinit var stats: TcpStats
  private lateinit var session: TcpSession

  class FakeUpstream : SessionUpstream {
    val writes = mutableListOf<ByteArray>()
    var closedOut = false
    var aborted = false
    override fun write(bytes: ByteArray) { writes += bytes.copyOf() }
    override fun closeOut() { closedOut = true }
    override fun abort() { aborted = true }
    fun stream(): ByteArray {
      val all = ByteArray(writes.sumOf { it.size })
      var i = 0
      for (w in writes) { w.copyInto(all, i); i += w.size }
      return all
    }
  }

  private fun clientPacket(
    seq: Long, ack: Long, flags: Int, window: Int = 65535,
    payload: ByteArray = ByteArray(0), options: ByteArray = ByteArray(0),
  ): ByteArray = Packet.buildTcpSegment(
    Packet.FAMILY_V4, SRC, DST, SPORT, DPORT, seq, ack, flags, window, payload, options,
  )

  private fun syn(mss: Int? = 1460, extraOpts: ByteArray = ByteArray(0)): ByteArray {
    val opts = (mss?.let { Packet.mssOption(it) } ?: ByteArray(0)) + extraOpts
    return clientPacket(CISSN, 0, Packet.FLAG_SYN, options = opts)
  }

  private fun lastSeg(): Packet.TcpSegment = Packet.parseTcp(emitted.last())!!

  private fun allSegs(): List<Packet.TcpSegment> = emitted.mapNotNull { Packet.parseTcp(it) }

  @Before
  fun setUp() {
    emitted = mutableListOf()
    upstream = FakeUpstream()
    key = FlowKey(Packet.FAMILY_V4, SRC, SPORT, DST, DPORT)
    stats = TcpStats()
    session = TcpSession(key, { emitted += it }, upstream, initialSeq = ISSN, nowMs = clock, stats = stats)
  }

  private fun handshook(clientWnd: Int = 65535) {
    session.onPacket(syn())
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK, window = clientWnd))
    emitted.clear()
    assertEquals(TcpSession.State.ESTABLISHED, session.state)
  }

  /* ------------------------------------------------------------ */

  @Test
  fun `syn elicits syn-ack with correct seq and bare-mss options`() {
    // SYN carrying SACK-ok + TS + WS — all must be stripped; only MSS may appear.
    session.onPacket(syn(mss = 1460, extraOpts = byteArrayOf(0x04, 0x02, 0x08, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x03, 0x03, 0x07)))
    assertEquals(TcpSession.State.SYN_RECV, session.state)
    assertEquals(1, emitted.size)
    val sa = lastSeg()
    assertTrue(sa.has(Packet.FLAG_SYN))
    assertTrue(sa.has(Packet.FLAG_ACK))
    assertEquals(ISSN, sa.seq)
    assertEquals(CISSN + 1, sa.ack)
    assertEquals(TcpSession.ADVERTISED_WINDOW, sa.window)
    assertArrayEquals(Packet.mssOption(1460), sa.options) // negotiated-min(1500,1460)
  }

  @Test
  fun `syn without mss advertises 1500`() {
    session.onPacket(syn(mss = null))
    assertArrayEquals(Packet.mssOption(1500), lastSeg().options)
  }

  @Test
  fun `syn retransmit re-emits identical syn-ack`() {
    session.onPacket(syn())
    val first = emitted.single()
    session.onPacket(syn())
    assertEquals(2, emitted.size)
    assertArrayEquals(first, emitted[1])
    assertEquals(TcpSession.State.SYN_RECV, session.state)
  }

  @Test
  fun `handshake ack establishes`() {
    session.onPacket(syn())
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK))
    assertEquals(TcpSession.State.ESTABLISHED, session.state)
  }

  @Test
  fun `data in SYN_RECV without ack gets rst`() {
    session.onPacket(syn())
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 1, 0, Packet.FLAG_PSH, payload = "x".toByteArray()))
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
    assertEquals(1, stats.rst.get())
  }

  /* ------------------------- receive ------------------------- */

  @Test
  fun `in-order payload lands on upstream and elicits ack`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK or Packet.FLAG_PSH, payload = "hello".toByteArray()))
    assertArrayEquals("hello".toByteArray(), upstream.stream())
    val ack = lastSeg()
    assertEquals(CISSN + 6L, ack.ack)
    assertEquals(ISSN + 1, ack.seq)
  }

  @Test
  fun `out-of-order gap fill delivers ordered payload`() {
    handshook()
    // seg2 arrives first, then seg1 fills the gap.
    session.onPacket(clientPacket(CISSN + 4, ISSN + 1, Packet.FLAG_ACK, payload = "DEF".toByteArray()))
    assertEquals(0, upstream.writes.size) // nothing delivered while the gap is open
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK, payload = "ABC".toByteArray()))
    assertArrayEquals("ABCDEF".toByteArray(), upstream.stream())
    assertEquals(CISSN + 7L, lastSeg().ack)
  }

  @Test
  fun `duplicate segment does not double-deliver`() {
    handshook()
    val seg = clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK, payload = "dup!".toByteArray())
    session.onPacket(seg)
    session.onPacket(seg)
    assertArrayEquals("dup!".toByteArray(), upstream.stream())
  }

  @Test
  fun `reassembly overflow beyond cap gets rst`() {
    handshook()
    // A segment more than REASM_CAP ahead — no legal sender can be there.
    session.onPacket(
      clientPacket(CISSN + 1 + TcpSession.REASM_CAP + 8, ISSN + 1, Packet.FLAG_ACK, payload = "x".toByteArray())
    )
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  /* ------------------------- FIN paths ------------------------ */

  @Test
  fun `client fin half-closes — upstream data still emits`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_FIN or Packet.FLAG_ACK))
    assertTrue(upstream.closedOut)
    assertEquals(TcpSession.State.CLOSE_WAIT, session.state)
    assertFalse(session.terminated)

    // Upstream can still write — the other direction is open.
    session.onUpstreamData("HTTP/1.1 200 OK\r\n\r\n".toByteArray())
    val data = allSegs().first { it.payload.isNotEmpty() }
    assertArrayEquals("HTTP/1.1 200 OK\r\n\r\n".toByteArray(), data.payload)

    session.onUpstreamEof()
    val fin = lastSeg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    assertEquals(TcpSession.State.LAST_ACK, session.state)

    // Client ACKs our FIN → fully closed.
    session.onPacket(clientPacket(CISSN + 2, fin.seq + 1, Packet.FLAG_ACK))
    assertTrue(session.terminated)
    assertEquals(TcpSession.State.CLOSED, session.state)
  }

  @Test
  fun `upstream eof first — fin-wait then time-wait reaps`() {
    handshook()
    session.onUpstreamEof()
    val fin = lastSeg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    assertEquals(TcpSession.State.FIN_WAIT_1, session.state)

    // ACK of our FIN → FIN_WAIT_2.
    session.onPacket(clientPacket(CISSN + 1, fin.seq + 1, Packet.FLAG_ACK))
    assertEquals(TcpSession.State.FIN_WAIT_2, session.state)

    // Client FIN → TIME_WAIT (+ a bare ACK emitted for it).
    session.onPacket(clientPacket(CISSN + 1, fin.seq + 1, Packet.FLAG_FIN or Packet.FLAG_ACK))
    assertEquals(TcpSession.State.TIME_WAIT, session.state)
    assertTrue(lastSeg().has(Packet.FLAG_ACK))

    // TIME_WAIT-lite expires on tick.
    assertFalse(session.onTick(now + TcpSession.TIME_WAIT_MS - 1))
    assertTrue(session.onTick(now + TcpSession.TIME_WAIT_MS + 1))
    assertTrue(session.terminated)
  }

  /* ------------------------- violations ----------------------- */

  @Test
  fun `ack of unsent data gets rst`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 100, Packet.FLAG_ACK))
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  @Test
  fun `data past client fin gets rst`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_FIN or Packet.FLAG_ACK))
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 2, ISSN + 1, Packet.FLAG_ACK, payload = "late".toByteArray()))
    assertTrue(session.terminated)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  /* ------------------------- send side ------------------------ */

  @Test
  fun `upstream data emits acked segments with correct seq`() {
    handshook()
    session.onUpstreamData("abcdefghij".toByteArray())
    val segs = allSegs().filter { it.payload.isNotEmpty() }
    assertEquals(1, segs.size)
    assertEquals(ISSN + 1, segs[0].seq)
    assertEquals(CISSN + 1, segs[0].ack)
    assertArrayEquals("abcdefghij".toByteArray(), segs[0].payload)
  }

  @Test
  fun `send is bounded by the client window`() {
    handshook(clientWnd = 200)
    session.onUpstreamData(ByteArray(500) { 'a'.code.toByte() })
    val sent = allSegs().sumOf { it.payload.size }
    assertEquals(200, sent)

    // Window reopens via a fresh ACK → the queued remainder flushes.
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 201, Packet.FLAG_ACK, window = 800))
    val more = allSegs().sumOf { it.payload.size }
    assertEquals(300, more)
  }

  @Test
  fun `send segment size honors client mss`() {
    session.onPacket(syn(mss = 100))
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK))
    session.onUpstreamData(ByteArray(250) { 'x'.code.toByte() })
    val payloads = allSegs().filter { it.payload.isNotEmpty() }
    assertEquals(3, payloads.size) // 100 + 100 + 50
    assertEquals(100, payloads[0].payload.size)
    assertEquals(50, payloads[2].payload.size)
    // seqs are contiguous
    assertEquals(ISSN + 1, payloads[0].seq)
    assertEquals(ISSN + 101, payloads[1].seq)
    assertEquals(ISSN + 201, payloads[2].seq)
  }

  /* ------------------------- retransmit-lite ------------------ */

  @Test
  fun `rto tick resends unacked segment then rst after retries`() {
    handshook()
    session.onUpstreamData("payload".toByteArray())
    assertEquals(1, allSegs().count { it.payload.isNotEmpty() })

    // Inside the RTO nothing resends.
    now += TcpSession.RTO_MS - 1
    session.onTick(now)
    assertEquals(1, allSegs().count { it.payload.isNotEmpty() })

    // Each tick past the fixed RTO resends at the same seq — bounded to MAX_RETRIES.
    repeat(TcpSession.MAX_RETRIES) {
      now += TcpSession.RTO_MS + 1
      assertFalse(session.onTick(now))
    }
    val resends = allSegs().filter { it.payload.isNotEmpty() && it.seq == ISSN + 1 }
    assertEquals(1 + TcpSession.MAX_RETRIES, resends.size)

    // Budget exhausted → RST, terminated, upstream aborted.
    now += TcpSession.RTO_MS + 1
    assertTrue(session.onTick(now))
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  /* ------------------------- idle reap ------------------------ */

  @Test
  fun `idle session reaps with rst`() {
    handshook()
    val deadline = session.idleDeadlineMs
    assertEquals(now + TcpSession.IDLE_TIMEOUT_MS, deadline)
    assertFalse(session.onTick(now + TcpSession.IDLE_TIMEOUT_MS - 1))
    assertTrue(session.onTick(now + TcpSession.IDLE_TIMEOUT_MS + 1))
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  /* ----------------- review regressions (22e9c5c) ------------- */

  @Test
  fun `fin ahead of reassembly gap still consumes on gap fill`() {
    handshook()
    // FIN+data arrives ahead of a 3-byte gap — buffered, finSeq only recorded.
    session.onPacket(clientPacket(CISSN + 4, ISSN + 1, Packet.FLAG_FIN or Packet.FLAG_ACK, payload = "DEF".toByteArray()))
    assertFalse(upstream.closedOut)
    // The gap fills on a NON-FIN segment — the pending FIN must be consumed here.
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK, payload = "ABC".toByteArray()))
    assertArrayEquals("ABCDEF".toByteArray(), upstream.stream())
    assertTrue(upstream.closedOut)
    assertEquals(TcpSession.State.CLOSE_WAIT, session.state)

    // Half-close still lets upstream data through.
    session.onUpstreamData("tail".toByteArray())
    assertArrayEquals("tail".toByteArray(), allSegs().first { it.payload.isNotEmpty() }.payload)

    session.onUpstreamEof()
    assertEquals(TcpSession.State.LAST_ACK, session.state)
    val fin = lastSeg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    session.onPacket(clientPacket(CISSN + 8, fin.seq + 1, Packet.FLAG_ACK))
    assertTrue(session.terminated)
    assertEquals(TcpSession.State.CLOSED, session.state)
  }

  @Test
  fun `syn advertising mss 0 is floored and emit stays bounded`() {
    session.onPacket(syn(mss = 0))
    assertArrayEquals(Packet.mssOption(TcpSession.MIN_PEER_MSS), lastSeg().options)
    emitted.clear()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK))
    emitted.clear()
    // Before the floor this livelocked: n=0 chunks requeue the head forever.
    session.onUpstreamData(ByteArray(200) { 'x'.code.toByte() })
    val payloads = allSegs().filter { it.payload.isNotEmpty() }
    assertEquals(4, payloads.size) // 64 + 64 + 64 + 8
    assertTrue(payloads.all { it.payload.size <= TcpSession.MIN_PEER_MSS })
    assertEquals(200, payloads.sumOf { it.payload.size })
  }

  @Test
  fun `blind rst gets a challenge ack and the flow survives`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1001, ISSN + 1, Packet.FLAG_RST))
    assertFalse(session.terminated)
    assertFalse(upstream.aborted)
    val challenge = lastSeg()
    assertTrue(challenge.has(Packet.FLAG_ACK))
    assertFalse(challenge.has(Packet.FLAG_RST))
    assertEquals(CISSN + 1, challenge.ack) // advertises the real rcvNxt
    // The flow is unharmed — in-order data still lands.
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK or Packet.FLAG_PSH, payload = "ok".toByteArray()))
    assertArrayEquals("ok".toByteArray(), upstream.stream())
  }

  @Test
  fun `rst exactly at rcvNxt still terminates`() {
    handshook()
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_RST))
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
  }

  @Test
  fun `reassembly entry-count cap rst-kills`() {
    handshook()
    // 1-byte OOO segments stay trivially under the byte cap — only the entry
    // cap stops ~256k TreeMap nodes per flow.
    repeat(TcpSession.REASM_ENTRIES_CAP) { i ->
      session.onPacket(clientPacket(CISSN + 2 + i, ISSN + 1, Packet.FLAG_ACK, payload = byteArrayOf(0x61)))
      assertFalse(session.terminated)
    }
    session.onPacket(
      clientPacket(CISSN + 2L + TcpSession.REASM_ENTRIES_CAP, ISSN + 1, Packet.FLAG_ACK, payload = byteArrayOf(0x62))
    )
    assertTrue(session.terminated)
    assertTrue(upstream.aborted)
    assertTrue(lastSeg().has(Packet.FLAG_RST))
  }

  @Test
  fun `upstream eof during syn-recv stays latched and fins after established`() {
    session.onPacket(syn())
    emitted.clear()
    session.onUpstreamEof()
    assertTrue(emitted.isEmpty()) // no FIN may precede the handshake
    assertEquals(TcpSession.State.SYN_RECV, session.state)
    session.onPacket(clientPacket(CISSN + 1, ISSN + 1, Packet.FLAG_ACK))
    val fin = lastSeg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    assertEquals(ISSN + 1, fin.seq)
    assertEquals(TcpSession.State.FIN_WAIT_1, session.state)
  }

  @Test
  fun `simultaneous close — crossing fins land in time-wait`() {
    handshook()
    session.onUpstreamEof()
    val fin = lastSeg()
    assertEquals(TcpSession.State.FIN_WAIT_1, session.state)

    // The client's FIN crosses ours — its ACK does not yet cover ourFinSeq.
    session.onPacket(clientPacket(CISSN + 1, fin.seq, Packet.FLAG_FIN or Packet.FLAG_ACK))
    assertTrue(upstream.closedOut)
    assertEquals(TcpSession.State.FIN_WAIT_1, session.state) // CLOSING, folded

    // The follow-up ACK covering our FIN resolves to TIME_WAIT.
    session.onPacket(clientPacket(CISSN + 2, fin.seq + 1, Packet.FLAG_ACK))
    assertEquals(TcpSession.State.TIME_WAIT, session.state)
    assertTrue(session.onTick(now + TcpSession.TIME_WAIT_MS + 1))
    assertTrue(session.terminated)
  }

  @Test
  fun `sequence wraparound — issn near 2^32 crosses mid-flow`() {
    val wrapIssn = 0xFFFF_FFF0L
    val s = TcpSession(key, { emitted += it }, upstream, initialSeq = wrapIssn, nowMs = clock, stats = stats)
    s.onPacket(syn())
    assertEquals(wrapIssn, lastSeg().seq)
    val sNxt = (wrapIssn + 1) and 0xFFFF_FFFFL
    s.onPacket(clientPacket(CISSN + 1, sNxt, Packet.FLAG_ACK))
    assertEquals(TcpSession.State.ESTABLISHED, s.state)
    emitted.clear()

    // A 64-byte send from 0xFFFFFFF1 straddles the 2^32 boundary.
    s.onUpstreamData(ByteArray(64) { 'z'.code.toByte() })
    val data = lastSeg()
    assertEquals(sNxt, data.seq)
    assertEquals(64, data.payload.size)

    // The cumulative ACK at the wrapped value is accepted, not RST'd.
    val wrappedAck = (sNxt + 64) and 0xFFFF_FFFFL
    s.onPacket(clientPacket(CISSN + 1, wrappedAck, Packet.FLAG_ACK))
    assertFalse(s.terminated)

    // Inbound still orders correctly while the outbound side is wrapped.
    s.onPacket(clientPacket(CISSN + 1, wrappedAck, Packet.FLAG_ACK or Packet.FLAG_PSH, payload = "hi".toByteArray()))
    assertArrayEquals("hi".toByteArray(), upstream.stream())
    assertEquals(CISSN + 3L, lastSeg().ack)

    // FIN at the wrapped sndNxt; the client's ACK of it is wrap-compared too.
    emitted.clear()
    s.onUpstreamEof()
    val fin = lastSeg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    assertEquals(wrappedAck, fin.seq)
    s.onPacket(clientPacket(CISSN + 3, ((fin.seq + 1) and 0xFFFF_FFFFL), Packet.FLAG_ACK))
    assertEquals(TcpSession.State.FIN_WAIT_2, s.state)
  }
}

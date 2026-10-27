package com.blockingmachine.localvpn.tcp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FakeTun + FakeUpstream end-to-end — a whole flow through the dispatcher:
 * SYN in → SYN-ACK out; payload in → upstream.write; upstream bytes → packets
 * out with correct seq/ack; client FIN → upstream.closeOut; upstream EOF →
 * FIN out; final ACK → session gone.
 */
class EndToEndTest {

  private val SRC = byteArrayOf(10, 0, 0, 8)
  private val DST = byteArrayOf(203.toByte(), 0, 113, 7)
  private val SPORT = 40000
  private val DPORT = 443
  private val CISSN = 0x0102_0304L

  private fun pkt(seq: Long, ack: Long, flags: Int,
                  payload: ByteArray = ByteArray(0), wnd: Int = 65535,
                  options: ByteArray = ByteArray(0)): ByteArray =
    Packet.buildTcpSegment(Packet.FAMILY_V4, SRC, DST, SPORT, DPORT, seq, ack, flags, wnd, payload, options)

  @Test
  fun `full flow — handshake, data both ways, half-close`() {
    val tunOut = mutableListOf<ByteArray>()
    val upstream = TcpSessionTest.FakeUpstream()
    val dispatcher = TcpDispatcher(
      emit = { tunOut += it },
      upstreamFactory = { upstream },
    )
    fun seg() = Packet.parseTcp(tunOut.last())!!

    // SYN in → SYN-ACK out.
    dispatcher.onPacket(pkt(CISSN, 0, Packet.FLAG_SYN, options = Packet.mssOption(1460)))
    val synAck = seg()
    assertTrue(synAck.has(Packet.FLAG_SYN) && synAck.has(Packet.FLAG_ACK))
    assertEquals(CISSN + 1, synAck.ack)
    val serverIssn = synAck.seq

    // Handshake ACK + request payload in → upstream.write gets the bytes.
    dispatcher.onPacket(pkt(CISSN + 1, serverIssn + 1, Packet.FLAG_ACK))
    dispatcher.onPacket(pkt(CISSN + 1, serverIssn + 1, Packet.FLAG_ACK or Packet.FLAG_PSH,
      payload = "GET / HTTP/1.1\r\n".toByteArray()))
    assertArrayEquals("GET / HTTP/1.1\r\n".toByteArray(), upstream.stream())
    assertEquals(CISSN + 17L, seg().ack)

    // Upstream bytes → tun packets with correct seq/ack.
    dispatcher.sessions.values.single().onUpstreamData("HTTP/1.1 200 OK\r\n\r\n".toByteArray())
    val data = seg()
    assertEquals(serverIssn + 1, data.seq)
    assertEquals(CISSN + 17, data.ack)
    assertArrayEquals("HTTP/1.1 200 OK\r\n\r\n".toByteArray(), data.payload)

    // Client FIN → upstream.closeOut; our FIN rides after queued data.
    dispatcher.onPacket(pkt(CISSN + 17, data.seq + data.payload.size, Packet.FLAG_FIN or Packet.FLAG_ACK))
    assertTrue(upstream.closedOut)
    dispatcher.sessions.values.single().onUpstreamEof()
    val fin = seg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    assertEquals(data.seq + data.payload.size, fin.seq)

    // Final ACK → flow reaped — the clean close frees the upstream too.
    dispatcher.onPacket(pkt(CISSN + 18, fin.seq + 1, Packet.FLAG_ACK))
    assertEquals(0, dispatcher.activeCount())
    assertEquals(1, dispatcher.stats.flowsOpened.get())
    assertEquals(1, dispatcher.stats.flowsClosed.get())
    assertTrue(upstream.aborted)
  }

  /* ------------------------------------------------------------ */

  private val SRC6 = hex("fd000000000000000000000000000002")
  private val DST6 = hex("20010db8000000000000000000000005")

  private fun hex(s: String): ByteArray =
    ByteArray(s.length / 2) { ((Character.digit(s[2 * it], 16) shl 4) or Character.digit(s[2 * it + 1], 16)).toByte() }

  private fun pkt6(seq: Long, ack: Long, flags: Int,
                   payload: ByteArray = ByteArray(0), wnd: Int = 65535,
                   options: ByteArray = ByteArray(0)): ByteArray =
    Packet.buildTcpSegment(Packet.FAMILY_V6, SRC6, DST6, SPORT, DPORT, seq, ack, flags, wnd, payload, options)

  @Test
  fun `v6 full flow — handshake, data both ways, half-close`() {
    val tunOut = mutableListOf<ByteArray>()
    val upstream = TcpSessionTest.FakeUpstream()
    val dispatcher = TcpDispatcher(
      emit = { tunOut += it },
      upstreamFactory = { upstream },
    )
    fun seg() = Packet.parseTcp(tunOut.last())!!

    // SYN in → SYN-ACK out (v6 pseudo-header checksum verifies both ways).
    dispatcher.onPacket(pkt6(CISSN, 0, Packet.FLAG_SYN, options = Packet.mssOption(1440)))
    val synAck = seg()
    assertTrue(synAck.has(Packet.FLAG_SYN) && synAck.has(Packet.FLAG_ACK))
    assertEquals(Packet.FAMILY_V6, synAck.family)
    assertEquals(CISSN + 1, synAck.ack)
    val serverIssn = synAck.seq

    // Handshake ACK + payload → upstream.write.
    dispatcher.onPacket(pkt6(CISSN + 1, serverIssn + 1, Packet.FLAG_ACK))
    dispatcher.onPacket(pkt6(CISSN + 1, serverIssn + 1, Packet.FLAG_ACK or Packet.FLAG_PSH,
      payload = "GET /v6 HTTP/1.1\r\n".toByteArray()))
    assertArrayEquals("GET /v6 HTTP/1.1\r\n".toByteArray(), upstream.stream())

    // Upstream bytes → v6 packets out.
    dispatcher.sessions.values.single().onUpstreamData("HTTP/1.1 200 OK\r\n\r\n".toByteArray())
    val data = seg()
    assertEquals(serverIssn + 1, data.seq)
    assertArrayEquals("HTTP/1.1 200 OK\r\n\r\n".toByteArray(), data.payload)

    // Client FIN → closeOut; upstream EOF → our FIN; final ACK → reaped.
    dispatcher.onPacket(pkt6(CISSN + 19, data.seq + data.payload.size, Packet.FLAG_FIN or Packet.FLAG_ACK))
    assertTrue(upstream.closedOut)
    dispatcher.sessions.values.single().onUpstreamEof()
    val fin = seg()
    assertTrue(fin.has(Packet.FLAG_FIN))
    dispatcher.onPacket(pkt6(CISSN + 20, fin.seq + 1, Packet.FLAG_ACK))
    assertEquals(0, dispatcher.activeCount())
    assertEquals(1, dispatcher.stats.flowsOpened.get())
    assertEquals(1, dispatcher.stats.flowsClosed.get())
    assertTrue(upstream.aborted)
  }
}

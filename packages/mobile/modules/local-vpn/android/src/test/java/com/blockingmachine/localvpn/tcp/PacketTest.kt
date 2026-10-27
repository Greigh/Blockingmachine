package com.blockingmachine.localvpn.tcp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Packet codec tests — round-trips plus golden checksum vectors.
 *
 * The golden vectors were computed with an independent Python implementation
 * (struct.pack + a textbook ones-complement sum — the same shapes scapy
 * emits) and are asserted byte-for-byte; a second, structurally different
 * in-test checksum impl cross-checks arbitrary packets below.
 */
class PacketTest {

  private val v4src = byteArrayOf(10, 0, 0, 2)
  private val v4dst = byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34)
  private val v6src = hexToBytes("20010db8000000000000000000000001")
  private val v6dst = hexToBytes("20010db8000000000000000000000005")

  private fun hexToBytes(s: String): ByteArray =
    ByteArray(s.length / 2) { ((Character.digit(s[2 * it], 16) shl 4) or Character.digit(s[2 * it + 1], 16)).toByte() }

  /* ---------------------------------------------------------- */
  /* Checksum correctness                                        */
  /* ---------------------------------------------------------- */

  @Test
  fun `rfc1071 checksum example`() {
    // The canonical RFC 1071 worked example: 00 01 f2 03 f4 f5 f6 f7 → 0x220d.
    val data = byteArrayOf(0x00, 0x01, 0xf2.toByte(), 0x03, 0xf4.toByte(), 0xf5.toByte(), 0xf6.toByte(), 0xf7.toByte())
    assertEquals(0x220d, Packet.ipv4Checksum(data, 0, data.size))
  }

  /**
   * Independent re-implementation — walks the buffer as big-endian Ints and
   * folds differently (Int arithmetic, not Long) — cross-checks the codec's
   * checksum on arbitrary inputs.
   */
  private fun independentSum(b: ByteArray, off: Int, len: Int): Int {
    var sum = 0
    var i = 0
    while (i + 1 < len) {
      sum += ((b[off + i].toInt() and 0xFF) shl 8) or (b[off + i + 1].toInt() and 0xFF)
      sum = (sum and 0xFFFF) + (sum ushr 16) // fold eagerly, differently
      i += 2
    }
    if (i < len) sum += (b[off + i].toInt() and 0xFF) shl 8
    while (sum ushr 16 != 0) sum = (sum and 0xFFFF) + (sum ushr 16)
    return sum.inv() and 0xFFFF
  }

  @Test
  fun `ipv4 checksum matches independent impl`() {
    for (size in listOf(20, 24, 40)) {
      val hdr = ByteArray(size) { (it * 37 + 11).toByte() }
      assertEquals(independentSum(hdr, 0, size), Packet.ipv4Checksum(hdr, 0, size))
    }
  }

  /* ---------------------------------------------------------- */
  /* Golden wire vectors (computed with an independent impl)     */
  /* ---------------------------------------------------------- */

  /** 10.0.0.2:40000 → 93.184.216.34:443 SYN seq=0x11223344 wnd=64240, opts MSS=1460+SACKok+TS+NOP+WS=7. */
  private val v4SynGolden = byteArrayOf(
    0x45, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x40, 0x00, 0x40, 0x06, 0xfa.toByte(), 0xdf.toByte(),
    0x0a, 0x00, 0x00, 0x02, 0x5d, 0xb8.toByte(), 0xd8.toByte(), 0x22,
    0x9c.toByte(), 0x40, 0x01, 0xbb.toByte(), 0x11, 0x22, 0x33, 0x44, 0x00, 0x00, 0x00, 0x00,
    0xa0.toByte(), 0x02, 0xfa.toByte(), 0xf0.toByte(), 0x26, 0xcb.toByte(), 0x00, 0x00,
    0x02, 0x04, 0x05, 0xb4.toByte(), 0x04, 0x02, 0x08, 0x0a, 0x01, 0x02, 0x03, 0x04,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x03, 0x03, 0x07,
  )

  /** Same tuple, PSH|ACK seq=0x11223345 ack=0xaabbccdd wnd=64240, payload "GET / HTTP/1.1\r\n". */
  private val v4DataGolden = byteArrayOf(
    0x45, 0x00, 0x00, 0x38, 0x00, 0x00, 0x40, 0x00, 0x40, 0x06, 0xfa.toByte(), 0xe3.toByte(),
    0x0a, 0x00, 0x00, 0x02, 0x5d, 0xb8.toByte(), 0xd8.toByte(), 0x22,
    0x9c.toByte(), 0x40, 0x01, 0xbb.toByte(), 0x11, 0x22, 0x33, 0x45, 0xaa.toByte(), 0xbb.toByte(),
    0xcc.toByte(), 0xdd.toByte(), 0x50, 0x18, 0xfa.toByte(), 0xf0.toByte(), 0x49, 0x5c, 0x00, 0x00,
    0x47, 0x45, 0x54, 0x20, 0x2f, 0x20, 0x48, 0x54, 0x54, 0x50, 0x2f, 0x31, 0x2e, 0x31, 0x0d, 0x0a,
  )

  /** 2001:db8::1:52000 → 2001:db8::5:443 SYN seq=0xdeadbeef wnd=65535, opts MSS=1440. */
  private val v6SynGolden = byteArrayOf(
    0x60, 0x00, 0x00, 0x00, 0x00, 0x18, 0x06, 0x40,
    0x20, 0x01, 0x0d, 0xb8.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    0x20, 0x01, 0x0d, 0xb8.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
    0xcb.toByte(), 0x20, 0x01, 0xbb.toByte(), 0xde.toByte(), 0xad.toByte(), 0xbe.toByte(), 0xef.toByte(),
    0x00, 0x00, 0x00, 0x00, 0x60, 0x02, 0xff.toByte(), 0xff.toByte(), 0xd2.toByte(), 0x49, 0x00, 0x00,
    0x02, 0x04, 0x05, 0xa0.toByte(),
  )

  @Test
  fun `v4 syn emits golden bytes`() {
    val opts = byteArrayOf(
      0x02, 0x04, 0x05, 0xb4.toByte(),             // MSS 1460
      0x04, 0x02,                                 // SACK-permitted
      0x08, 0x0a, 0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0, // timestamp
      0x01,                                       // NOP
      0x03, 0x03, 0x07,                           // WS 7
    )
    val got = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 40000, 443,
      seq = 0x11223344, ack = 0, flags = Packet.FLAG_SYN, window = 64240, options = opts,
    )
    assertArrayEquals(v4SynGolden, got)
  }

  @Test
  fun `v4 data emits golden bytes`() {
    val got = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 40000, 443,
      seq = 0x11223345, ack = 0xaabbccdd, flags = Packet.FLAG_PSH or Packet.FLAG_ACK,
      window = 64240, payload = "GET / HTTP/1.1\r\n".toByteArray(),
    )
    assertArrayEquals(v4DataGolden, got)
  }

  @Test
  fun `v6 syn emits golden bytes`() {
    val got = Packet.buildTcpSegment(
      Packet.FAMILY_V6, v6src, v6dst, 52000, 443,
      seq = 0xdeadbeef, ack = 0, flags = Packet.FLAG_SYN, window = 65535,
      options = Packet.mssOption(1440),
    )
    assertArrayEquals(v6SynGolden, got)
  }

  /* ---------------------------------------------------------- */
  /* Round-trip                                                  */
  /* ---------------------------------------------------------- */

  @Test
  fun `v4 round-trip parses what serialize emits`() {
    val payload = ByteArray(1023) { (it and 0xFF).toByte() }
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 12345, 80,
      seq = 0x01020304, ack = 0xf0e0d0c0, flags = Packet.FLAG_ACK or Packet.FLAG_PSH,
      window = 65535, payload = payload,
    )
    val seg = Packet.parseTcp(wire)
    assertNotNull(seg)
    seg!!
    assertEquals(Packet.FAMILY_V4, seg.family)
    assertArrayEquals(v4src, seg.srcAddr)
    assertArrayEquals(v4dst, seg.dstAddr)
    assertEquals(12345, seg.srcPort)
    assertEquals(80, seg.dstPort)
    assertEquals(0x01020304L, seg.seq)
    assertEquals(0xf0e0d0c0L, seg.ack)
    assertTrue(seg.has(Packet.FLAG_PSH))
    assertEquals(65535, seg.window)
    assertArrayEquals(payload, seg.payload)
  }

  @Test
  fun `v6 round-trip parses what serialize emits`() {
    val payload = "hello v6".toByteArray()
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V6, v6src, v6dst, 52000, 443,
      seq = 777, ack = 888, flags = Packet.FLAG_ACK, window = 12345, payload = payload,
    )
    val seg = Packet.parseTcp(wire)!!
    assertEquals(Packet.FAMILY_V6, seg.family)
    assertArrayEquals(v6src, seg.srcAddr)
    assertArrayEquals(v6dst, seg.dstAddr)
    assertEquals(777L, seg.seq)
    assertEquals(888L, seg.ack)
    assertArrayEquals(payload, seg.payload)
  }

  @Test
  fun `serialize is idempotent through parse`() {
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 40000, 443,
      seq = 5, ack = 6, flags = Packet.FLAG_SYN, window = 30000, options = Packet.mssOption(1460),
    )
    val seg = Packet.parseTcp(wire)!!
    val rebuilt = Packet.buildTcpSegment(
      seg.family, seg.srcAddr, seg.dstAddr, seg.srcPort, seg.dstPort,
      seg.seq, seg.ack, seg.flags, seg.window, seg.payload, seg.options,
    )
    assertArrayEquals(wire, rebuilt)
  }

  /* ---------------------------------------------------------- */
  /* Parse rejects                                               */
  /* ---------------------------------------------------------- */

  @Test
  fun `bad tcp checksum drops`() {
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 1, 2, 3, 4, Packet.FLAG_ACK, 100, "x".toByteArray(),
    )
    wire[wire.size - 1] = (wire[wire.size - 1].toInt() xor 0xFF).toByte() // corrupt the payload → bad csum
    assertNull(Packet.parseTcp(wire))
  }

  @Test
  fun `bad ipv4 checksum drops`() {
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 1, 2, 3, 4, Packet.FLAG_SYN, 100,
    )
    wire[10] = (wire[10].toInt() xor 0xFF).toByte() // corrupt the header checksum itself
    assertNull(Packet.parseTcp(wire))
  }

  @Test
  fun `non-tcp drops`() {
    val udp = byteArrayOf(0x45, 0, 0, 28, 0, 0, 0, 0, 64, 17, 0, 0) +
      v4src + v4dst + ByteArray(8)
    assertNull(Packet.parseTcp(udp))
  }

  @Test
  fun `fragmented packet drops`() {
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 1, 2, 3, 4, Packet.FLAG_ACK, 100,
    )
    wire[6] = 0x20 // MF flag — fragment, we don't reassemble IP
    assertNull(Packet.parseTcp(wire))
  }

  @Test
  fun `truncated and garbage drop`() {
    assertNull(Packet.parseTcp(ByteArray(0)))
    assertNull(Packet.parseTcp(byteArrayOf(0x45, 0, 0)))
    assertNull(Packet.parseTcp(ByteArray(64) { 0x55 }))    // bogus version 5
    val short = v4SynGolden.copyOfRange(0, 30)
    assertNull(Packet.parseTcp(short))
  }

  @Test
  fun `checksum verification can be skipped for crafting`() {
    val wire = Packet.buildTcpSegment(
      Packet.FAMILY_V4, v4src, v4dst, 1, 2, 3, 4, Packet.FLAG_ACK, 100,
    )
    wire[wire.size - 1] = 0x7f
    assertNotNull(Packet.parseTcp(wire, verifyChecksum = false))
  }

  /* ---------------------------------------------------------- */
  /* Options                                                     */
  /* ---------------------------------------------------------- */

  @Test
  fun `advertisedMss parses out of a typical client option blob`() {
    val opts = byteArrayOf(
      0x02, 0x04, 0x05, 0xb4.toByte(),      // MSS 1460
      0x01, 0x01,                            // NOP NOP
      0x04, 0x02,                            // SACK-permitted
      0x08, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,   // TS
      0x03, 0x03, 0x07,                      // WS 7
    )
    assertEquals(1460, Packet.advertisedMss(opts))
  }

  @Test
  fun `advertisedMss absent and malformed`() {
    assertNull(Packet.advertisedMss(byteArrayOf(0x04, 0x02)))
    assertNull(Packet.advertisedMss(byteArrayOf(0x02, 0x04, 0x05))) // truncated
    assertNull(Packet.advertisedMss(ByteArray(0)))
  }

  @Test
  fun `synAckOptions emits only MSS`() {
    assertArrayEquals(byteArrayOf(0x02, 0x04, 0x05, 0xdc.toByte()), Packet.synAckOptions(1500))
  }

  /* ---------------------------------------------------------- */
  /* Routing peek                                                */
  /* ---------------------------------------------------------- */

  @Test
  fun `peekTcpDstPort`() {
    assertEquals(443, Packet.peekTcpDstPort(v4SynGolden))
    assertEquals(443, Packet.peekTcpDstPort(v6SynGolden))
    val nonTcp = byteArrayOf(0x45, 0, 0, 28, 0, 0, 0, 0, 64, 17, 0, 0) + v4src + v4dst + ByteArray(8)
    assertNull(Packet.peekTcpDstPort(nonTcp))
    assertNull(Packet.peekTcpDstPort(ByteArray(0)))
  }

  @Test
  fun `peekUdpDstPort reads v4 and v6 datagram ports`() {
    // IPv4 UDP/443 — the QUIC shape the service suppresses.
    val v4 = byteArrayOf(0x45, 0, 0, 28, 0, 0, 0, 0, 64, 17, 0, 0) +
      v4src + v4dst +
      byteArrayOf(0xc8.toByte(), 0x3a, 0x01, 0xbb.toByte(), 0, 8, 0, 0)
    assertEquals(443, Packet.peekUdpDstPort(v4))

    // IPv6 UDP — next-header 17, ports at fixed offset 40.
    val v6 = ByteArray(48)
    v6[0] = 0x60; v6[6] = 17
    v6[42] = 0x01; v6[43] = 0xbb.toByte()
    assertEquals(443, Packet.peekUdpDstPort(v6))
  }

  @Test
  fun `peekUdpDstPort rejects non-udp, fragments, and truncation`() {
    assertNull(Packet.peekUdpDstPort(v4SynGolden)) // TCP proto
    assertNull(Packet.peekUdpDstPort(ByteArray(0)))
    assertNull(Packet.peekUdpDstPort(byteArrayOf(0x45, 0, 0))) // truncated
    val frag = byteArrayOf(0x45, 0, 0, 28, 0, 0, 0x20, 0, 64, 17, 0, 0) +
      v4src + v4dst + ByteArray(8)
    assertNull(Packet.peekUdpDstPort(frag)) // MF set — same posture as TCP
  }

  @Test
  fun `peekTcpDstPort passes fragments through`() {
    // Fragment-1 carries the TCP header (dst 443) but must NOT be consumed —
    // its siblings carry no port and pass, so eating the first alone wedges
    // the peer's IP reassembly.
    val firstFrag = v4SynGolden.copyOf()
    firstFrag[6] = 0x20 // MF set, offset 0 — first fragment
    assertNull(Packet.peekTcpDstPort(firstFrag))
    val laterFrag = v4SynGolden.copyOf()
    laterFrag[6] = 0x00; laterFrag[7] = 0x01 // fragment offset > 0
    assertNull(Packet.peekTcpDstPort(laterFrag))
  }

  /* ---------------------------------------------------------- */
  /* RST reply shape (RFC 5961)                                  */
  /* ---------------------------------------------------------- */

  @Test
  fun `rst reply to ack-bearing segment`() {
    val seg = Packet.parseTcp(v4DataGolden)!!
    val rst = Packet.parseTcp(Packet.buildRstReply(seg))!!
    assertTrue(rst.has(Packet.FLAG_RST))
    assertTrue(!rst.has(Packet.FLAG_ACK))
    assertEquals(seg.ack, rst.seq)
    assertEquals(seg.srcPort, rst.dstPort)
    assertArrayEquals(seg.srcAddr, rst.dstAddr)
  }

  @Test
  fun `rst reply to non-ack segment`() {
    val seg = Packet.parseTcp(v4SynGolden)!!
    val rst = Packet.parseTcp(Packet.buildRstReply(seg))!!
    assertTrue(rst.has(Packet.FLAG_RST))
    assertTrue(rst.has(Packet.FLAG_ACK))
    assertEquals(0L, rst.seq)
    assertEquals(seg.endSeq(), rst.ack)
  }

  /* ---------------------------------------------------------- */
  /* UDP codec (the relay's wire format)                         */
  /* ---------------------------------------------------------- */

  /** 10.0.0.2:5353 → 8.8.8.8:53, 14-byte payload — independent Python golden. */
  private val v4UdpGolden = byteArrayOf(
    0x45, 0x00, 0x00, 0x2a, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0x20, 0xb2.toByte(),
    0x0a, 0x00, 0x00, 0x02, 0x08, 0x08, 0x08, 0x08,
    0x14, 0xe9.toByte(), 0x00, 0x35, 0x00, 0x16, 0xbd.toByte(), 0x5d,
    0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  )

  /** fd00::2:5353 → 2606:4700:4700::1111:53 — same payload, v6 golden. */
  private val v6UdpGolden = byteArrayOf(
    0x60, 0x00, 0x00, 0x00, 0x00, 0x16, 0x11, 0x40,
    0xfd.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
    0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x11,
    0x14, 0xe9.toByte(), 0x00, 0x35, 0x00, 0x16, 0x15, 0x55,
    0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  )

  private val udpPayload = byteArrayOf(
    0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  )

  @Test
  fun `v4 udp emits golden bytes`() {
    val got = Packet.buildUdpDatagram(Packet.FAMILY_V4, v4src, byteArrayOf(8, 8, 8, 8), 5353, 53, udpPayload)
    assertArrayEquals(v4UdpGolden, got)
  }

  @Test
  fun `v6 udp emits golden bytes`() {
    val src6 = hexToBytes("fd000000000000000000000000000002")
    val dst6 = hexToBytes("26064700470000000000000000001111")
    val got = Packet.buildUdpDatagram(Packet.FAMILY_V6, src6, dst6, 5353, 53, udpPayload)
    assertArrayEquals(v6UdpGolden, got)
  }

  @Test
  fun `udp round-trip parses what serialize emits`() {
    for (fam in listOf(Packet.FAMILY_V4, Packet.FAMILY_V6)) {
      val src = if (fam == Packet.FAMILY_V4) v4src else hexToBytes("fd000000000000000000000000000002")
      val dst = if (fam == Packet.FAMILY_V4) v4dst else hexToBytes("26064700470000000000000000001111")
      val wire = Packet.buildUdpDatagram(fam, src, dst, 53000, 123, udpPayload)
      val dg = Packet.parseUdp(wire)!!
      assertEquals(fam, dg.family)
      assertArrayEquals(src, dg.srcAddr)
      assertArrayEquals(dst, dg.dstAddr)
      assertEquals(53000, dg.srcPort)
      assertEquals(123, dg.dstPort)
      assertArrayEquals(udpPayload, dg.payload)
      // The checksum field as emitted verifies to zero end-to-end.
      val off = if (fam == Packet.FAMILY_V6) 40 else 20
      assertEquals(0, Packet.udpChecksum(dg.srcAddr, dg.dstAddr, wire, off, 8 + dg.payload.size))
    }
  }

  @Test
  fun `parseUdp drops fragments, non-udp, and truncation`() {
    assertNull(Packet.parseUdp(v4SynGolden)) // TCP proto
    assertNull(Packet.parseUdp(ByteArray(0)))
    val frag = v4UdpGolden.copyOf()
    frag[6] = 0x20 // MF — relay passes no partial datagrams
    assertNull(Packet.parseUdp(frag))
    val short = v4UdpGolden.copyOfRange(0, v4UdpGolden.size - 2)
    assertNull(Packet.parseUdp(short)) // declared UDP length exceeds the packet
  }

  @Test
  fun `peekIpProtocol reads the transport protocol`() {
    assertEquals(Packet.PROTO_TCP, Packet.peekIpProtocol(v4SynGolden))
    assertEquals(Packet.PROTO_UDP, Packet.peekIpProtocol(v4UdpGolden))
    assertEquals(Packet.PROTO_UDP, Packet.peekIpProtocol(v6UdpGolden))
    assertNull(Packet.peekIpProtocol(ByteArray(0)))
  }
}

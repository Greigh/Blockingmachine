package com.blockingmachine.localvpn.tcp

/**
 * IPv4/IPv6 + TCP codec for the userspace TCP core (P4 T1).
 *
 * Strict-enough header parse (bounds, version, protocol, real checksum
 * verification — bad-checksum segments drop like a real stack) and serialize
 * with real checksums: the IPv4 header checksum and the TCP pseudo-header
 * checksum for both address families (IPv6 carries no header checksum — the
 * TCP pseudo-header sum is all it gets).
 *
 * Pure stdlib — no android.jar types — so the whole codec is JVM-testable.
 * All multi-byte fields are big-endian (network order); sequence numbers are
 * the raw unsigned 32-bit wire values kept in a Long (0..0xFFFFFFFF).
 */
object Packet {

  const val FAMILY_V4 = 4
  const val FAMILY_V6 = 6
  const val PROTO_TCP = 6

  // TCP flag bits — the flags byte sits at TCP offset 13 (data offset lives in
  // the high nibble of offset 12; we never emit the NS bit).
  const val FLAG_FIN = 0x01
  const val FLAG_SYN = 0x02
  const val FLAG_RST = 0x04
  const val FLAG_PSH = 0x08
  const val FLAG_ACK = 0x10
  const val FLAG_URG = 0x20
  const val FLAG_ECE = 0x40
  const val FLAG_CWR = 0x80

  // TCP option kinds (only MSS is ever emitted — the rest are parsed so the
  // SYN-ACK can negotiate them away).
  const val OPT_END = 0
  const val OPT_NOP = 1
  const val OPT_MSS = 2
  const val OPT_WS = 3
  const val OPT_SACK_OK = 4
  const val OPT_SACK = 5
  const val OPT_TS = 8

  /**
   * MSS advertised on our SYN-ACK. We emit ONLY this one option (see
   * [synAckOptions]) — no SACK-permitted, no timestamps, no window scale —
   * which pins the session to the simplest possible TCP dialect; clients cope
   * because absent options simply mean "not negotiated". 1500 is safe: the
   * peer still caps its segments by its own path MTU.
   */
  const val OUR_MSS = 1500

  private val EMPTY = ByteArray(0)

  /**
   * One parsed TCP segment inside an IP packet. [srcAddr]/[dstAddr] are the raw
   * wire bytes — 4 bytes for v4, 16 for v6; [family] says which.
   */
  class TcpSegment(
    val family: Int,
    val srcAddr: ByteArray,
    val dstAddr: ByteArray,
    val srcPort: Int,
    val dstPort: Int,
    val seq: Long,
    val ack: Long,
    val flags: Int,
    val window: Int,
    val options: ByteArray,
    val payload: ByteArray,
  ) {
    fun has(flag: Int): Boolean = flags and flag != 0

    /** A connection-opening SYN — SYN set, ACK clear (ECE/CWR may ride along). */
    val isSyn: Boolean get() = has(FLAG_SYN) && !has(FLAG_ACK)

    /** First sequence number this segment does NOT cover (SYN and FIN each consume one). */
    fun endSeq(): Long =
      (seq + payload.size + (if (has(FLAG_SYN) || has(FLAG_FIN)) 1 else 0)) and 0xFFFF_FFFFL
  }

  /* ------------------------------------------------------------------ */
  /* Parse                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Parse a full IP packet (as read from the tun fd) into a [TcpSegment].
   * Returns null for anything that is not an unfragmented TCP/IPv4 or
   * TCP/IPv6 packet — and for malformed headers or bad checksums.
   */
  fun parseTcp(ip: ByteArray, verifyChecksum: Boolean = true): TcpSegment? {
    if (ip.isEmpty()) return null
    return when (ip[0].toInt() ushr 4) {
      4 -> parseTcpV4(ip, verifyChecksum)
      6 -> parseTcpV6(ip, verifyChecksum)
      else -> null
    }
  }

  private fun parseTcpV4(ip: ByteArray, verify: Boolean): TcpSegment? {
    if (ip.size < 20) return null
    val ihl = (ip[0].toInt() and 0x0F) * 4
    if (ihl < 20 || ip.size < ihl) return null
    val totalLen = u16(ip, 2)
    if (totalLen < ihl + 20 || totalLen > ip.size) return null
    // Fragmented packets can't be reassembled here — the session layer never
    // sees them (the service passes them through untouched).
    if (u16(ip, 6) and 0x3FFF != 0) return null
    if (u8(ip, 9) != PROTO_TCP) return null
    if (verify && ipv4Checksum(ip, 0, ihl) != 0) return null
    val src = ip.copyOfRange(12, 16)
    val dst = ip.copyOfRange(16, 20)
    return parseTcpCommon(FAMILY_V4, ip, ihl, totalLen - ihl, src, dst, verify)
  }

  private fun parseTcpV6(ip: ByteArray, verify: Boolean): TcpSegment? {
    if (ip.size < 40) return null
    val payloadLen = u16(ip, 4)
    if (u8(ip, 6) != PROTO_TCP) return null // no extension-header chasing — plain TCP only
    if (payloadLen < 20 || ip.size < 40 + payloadLen) return null
    val src = ip.copyOfRange(8, 24)
    val dst = ip.copyOfRange(24, 40)
    return parseTcpCommon(FAMILY_V6, ip, 40, payloadLen, src, dst, verify)
  }

  private fun parseTcpCommon(
    family: Int,
    buf: ByteArray,
    off: Int,
    len: Int,
    src: ByteArray,
    dst: ByteArray,
    verify: Boolean,
  ): TcpSegment? {
    if (len < 20) return null
    val dataOff = (u8(buf, off + 12) ushr 4) * 4
    if (dataOff < 20 || dataOff > len) return null
    if (verify && tcpChecksum(src, dst, buf, off, len) != 0) return null
    val opts = buf.copyOfRange(off + 20, off + dataOff)
    val payload = buf.copyOfRange(off + dataOff, off + len)
    return TcpSegment(
      family = family,
      srcAddr = src,
      dstAddr = dst,
      srcPort = u16(buf, off),
      dstPort = u16(buf, off + 2),
      seq = u32(buf, off + 4),
      ack = u32(buf, off + 8),
      flags = u8(buf, off + 13),
      window = u16(buf, off + 14),
      options = opts,
      payload = payload,
    )
  }

  /* ------------------------------------------------------------------ */
  /* Serialize                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Build a full IP packet carrying one TCP segment. [options] are appended to
   * the fixed 20-byte TCP header padded with OPT_END zeroes to a 4-byte
   * boundary. Returns the complete packet (IP header through payload) with all
   * checksums filled in.
   */
  fun buildTcpSegment(
    family: Int,
    srcAddr: ByteArray,
    dstAddr: ByteArray,
    srcPort: Int,
    dstPort: Int,
    seq: Long,
    ack: Long,
    flags: Int,
    window: Int,
    payload: ByteArray = EMPTY,
    options: ByteArray = EMPTY,
  ): ByteArray {
    val optPad = (4 - (options.size % 4)) % 4
    val opts = if (optPad == 0) options else options + ByteArray(optPad)
    val tcpLen = 20 + opts.size + payload.size
    val ipLen = (if (family == FAMILY_V6) 40 else 20) + tcpLen
    val buf = ByteArray(ipLen)

    val tcpOff: Int
    if (family == FAMILY_V6) {
      buf[0] = 0x60                    // version 6, tc/flow = 0
      put16(buf, 4, tcpLen)            // payload length
      buf[6] = PROTO_TCP.toByte()      // next header
      buf[7] = 64                      // hop limit
      srcAddr.copyInto(buf, 8)
      dstAddr.copyInto(buf, 24)
      tcpOff = 40
    } else {
      buf[0] = 0x45                    // version 4, IHL 5
      buf[1] = 0                       // DSCP/ECN
      put16(buf, 2, ipLen)
      put16(buf, 4, 0)                 // identification
      put16(buf, 6, 0x4000)            // DF, fragment offset 0
      buf[8] = 64                      // TTL
      buf[9] = PROTO_TCP.toByte()
      srcAddr.copyInto(buf, 12)
      dstAddr.copyInto(buf, 16)
      tcpOff = 20
    }

    put16(buf, tcpOff, srcPort)
    put16(buf, tcpOff + 2, dstPort)
    put32(buf, tcpOff + 4, seq)
    put32(buf, tcpOff + 8, ack)
    buf[tcpOff + 12] = (((20 + opts.size) / 4) shl 4).toByte()
    buf[tcpOff + 13] = flags.toByte()
    put16(buf, tcpOff + 14, window)
    // checksum patched below; urgent pointer stays 0
    opts.copyInto(buf, tcpOff + 20)
    payload.copyInto(buf, tcpOff + 20 + opts.size)

    if (family == FAMILY_V4) {
      put16(buf, 10, ipv4Checksum(buf, 0, 20))
    }
    put16(buf, tcpOff + 16, tcpChecksum(srcAddr, dstAddr, buf, tcpOff, tcpLen))
    return buf
  }

  /**
   * RFC 5961-style RST reply to [seg]: for ACK-bearing segments a bare RST
   * whose seq is the incoming ack; otherwise RST|ACK with seq 0 and ack = the
   * first sequence number the segment did not cover. Addresses/ports swap.
   */
  fun buildRstReply(seg: TcpSegment): ByteArray =
    if (seg.has(FLAG_ACK)) {
      buildTcpSegment(
        seg.family, seg.dstAddr, seg.srcAddr, seg.dstPort, seg.srcPort,
        seq = seg.ack, ack = 0, flags = FLAG_RST, window = 0,
      )
    } else {
      buildTcpSegment(
        seg.family, seg.dstAddr, seg.srcAddr, seg.dstPort, seg.srcPort,
        seq = 0, ack = seg.endSeq(), flags = FLAG_RST or FLAG_ACK, window = 0,
      )
    }

  /** The only option block we ever emit: bare MSS, already 4-aligned. */
  fun mssOption(mss: Int): ByteArray =
    byteArrayOf(OPT_MSS.toByte(), 4, (mss shr 8).toByte(), (mss and 0xFF).toByte())

  /** SYN-ACK options: MSS only — SACK/timestamps/window-scale stay unnegotiated. */
  fun synAckOptions(mss: Int): ByteArray = mssOption(mss)

  /** Walk a TCP option blob and return the MSS value, or null when absent/malformed. */
  fun advertisedMss(options: ByteArray): Int? {
    var i = 0
    while (i < options.size) {
      val kind = u8(options, i)
      if (kind == OPT_END) return null
      if (kind == OPT_NOP) { i += 1; continue }
      if (i + 1 >= options.size) return null
      val len = u8(options, i + 1)
      if (len < 2 || i + len > options.size) return null
      if (kind == OPT_MSS && len == 4) return u16(options, i + 2)
      i += len
    }
    return null
  }

  /**
   * Cheap routing peek — the destination port of a TCP packet without a full
   * parse (no checksum touch); null when the packet is not TCP or is truncated.
   */
  fun peekTcpDstPort(ip: ByteArray): Int? {
    if (ip.isEmpty()) return null
    return when (ip[0].toInt() ushr 4) {
      4 -> {
        if (ip.size < 20) return null
        val ihl = (ip[0].toInt() and 0x0F) * 4
        if (ihl < 20 || u8(ip, 9) != PROTO_TCP || ip.size < ihl + 4) null
        else u16(ip, ihl + 2)
      }
      6 -> {
        if (ip.size < 44 || u8(ip, 6) != PROTO_TCP) null
        else u16(ip, 42)
      }
      else -> null
    }
  }

  /* ------------------------------------------------------------------ */
  /* Checksums                                                           */
  /* ------------------------------------------------------------------ */

  /** Internet checksum (RFC 1071) over a header range — returns the complemented sum. */
  fun ipv4Checksum(buf: ByteArray, off: Int, len: Int): Int = fold(wordSum(buf, off, len))

  /**
   * TCP checksum including the pseudo-header. Family is inferred from the
   * address sizes: 4-byte addrs → IPv4 pseudo-header (src,dst,zero,proto,len16);
   * 16-byte → IPv6 (src,dst,len32,zero×3,next-header).
   */
  fun tcpChecksum(srcAddr: ByteArray, dstAddr: ByteArray, segment: ByteArray, off: Int, len: Int): Int {
    var sum = wordSum(srcAddr, 0, srcAddr.size)
    sum += wordSum(dstAddr, 0, dstAddr.size)
    if (srcAddr.size == 4) {
      sum += PROTO_TCP.toLong()     // 0x00 || proto
      sum += len.toLong()           // 16-bit TCP length
    } else {
      sum += (len ushr 16).toLong() // 32-bit TCP length, high word first
      sum += (len and 0xFFFF).toLong()
      sum += PROTO_TCP.toLong()     // 0x0000 || next-header
    }
    sum += wordSum(segment, off, len)
    return fold(sum)
  }

  private fun wordSum(b: ByteArray, off: Int, len: Int): Long {
    var sum = 0L
    var i = 0
    while (i + 2 <= len) {
      sum += ((b[off + i].toInt() and 0xFF) shl 8) or (b[off + i + 1].toInt() and 0xFF)
      i += 2
    }
    if (i < len) sum += (b[off + i].toInt() and 0xFF) shl 8 // odd tail byte pads low
    return sum
  }

  private fun fold(sum0: Long): Int {
    var sum = sum0
    while (sum ushr 16 != 0L) sum = (sum and 0xFFFF) + (sum ushr 16)
    return sum.toInt().inv() and 0xFFFF
  }

  /* ------------------------------------------------------------------ */
  /* Scalar helpers                                                      */
  /* ------------------------------------------------------------------ */

  private fun u8(b: ByteArray, off: Int) = b[off].toInt() and 0xFF

  private fun u16(b: ByteArray, off: Int) = (u8(b, off) shl 8) or u8(b, off + 1)

  private fun u32(b: ByteArray, off: Int) =
    ((u16(b, off).toLong() shl 16) or u16(b, off + 2).toLong()) and 0xFFFF_FFFFL

  private fun put16(b: ByteArray, off: Int, v: Int) {
    b[off] = (v shr 8).toByte()
    b[off + 1] = v.toByte()
  }

  private fun put32(b: ByteArray, off: Int, v: Long) {
    b[off] = (v shr 24).toByte()
    b[off + 1] = (v shr 16).toByte()
    b[off + 2] = (v shr 8).toByte()
    b[off + 3] = v.toByte()
  }
}

package com.blockingmachine.localvpn.tcp

/**
 * PROXY protocol v2 header emit — the Kotlin port of `bm_proxy_v2_format`
 * in `helper/common/splice.c` (P4 T1). The upstream hub socket writes this
 * header before the first payload byte so the engine sees the app's real
 * 5-tuple: src = the on-device app, dst = the original packet destination.
 *
 * Wire layout (byte-exact vs the C emit, verified against the same golden
 * vectors `splice-golden-test.c` asserts):
 *
 *   bytes  0..11  signature 0D 0A 0D 0A 00 0D 0A 51 55 49 54 0A
 *   byte      12  0x21 — version 2, PROXY command
 *   byte      13  fam — 0x11 TCP-over-IPv4, 0x21 TCP-over-IPv6
 *   bytes 14..15  address-block length, big-endian (v4: 12, v6: 36)
 *   v4: 16..19 src addr, 20..23 dst addr, 24..25 src port, 26..27 dst port
 *   v6: 16..31 src addr, 32..47 dst addr, 48..49 src port, 50..51 dst port
 *
 * Totals: 28 bytes for v4, 52 for v6.
 */
object ProxyV2 {

  private val SIGNATURE = byteArrayOf(
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
  )

  /**
   * Encode one PROXY-v2 TCP header. [srcIp]/[dstIp] are raw wire bytes and
   * must both be 4 bytes (IPv4) or both 16 bytes (IPv6) — the v2 frame carries
   * a single family, so a mixed src/dst pair cannot be represented and throws.
   * Ports are host-order 0..65535; they land big-endian on the wire.
   */
  fun encode(srcIp: ByteArray, srcPort: Int, dstIp: ByteArray, dstPort: Int): ByteArray {
    require(srcIp.size == dstIp.size) { "PROXY v2: src/dst family mismatch (${srcIp.size}B vs ${dstIp.size}B)" }
    require(srcPort in 0..0xFFFF && dstPort in 0..0xFFFF) { "PROXY v2: port out of range" }
    val fam: Int
    val len: Int
    when (srcIp.size) {
      4 -> { fam = 0x11; len = 12 }
      16 -> { fam = 0x21; len = 36 }
      else -> throw IllegalArgumentException("PROXY v2: address must be 4 or 16 bytes, got ${srcIp.size}")
    }
    val out = ByteArray(16 + len)
    SIGNATURE.copyInto(out, 0)
    out[12] = 0x21                     // version 2, PROXY command
    out[13] = fam.toByte()
    out[14] = (len shr 8).toByte()
    out[15] = (len and 0xFF).toByte()
    val addrLen = srcIp.size
    srcIp.copyInto(out, 16)
    dstIp.copyInto(out, 16 + addrLen)
    val portOff = 16 + 2 * addrLen
    out[portOff] = (srcPort shr 8).toByte()
    out[portOff + 1] = srcPort.toByte()
    out[portOff + 2] = (dstPort shr 8).toByte()
    out[portOff + 3] = dstPort.toByte()
    return out
  }
}

package com.blockingmachine.localvpn

import java.net.InetAddress
import java.nio.ByteBuffer

/**
 * Minimal IPv4/UDP/DNS codec — just enough to read a query arriving on the TUN
 * fd and write a synthesized response. Only handles single-question UDP/53
 * packets (the shape every system resolver emits).
 */
object DnsPacket {

  data class Query(
    val transactionId: Int,
    val flags: Int,
    val domain: String,
    val qType: Int,
    val srcAddr: ByteArray,
    val srcPort: Int,
    val dstAddr: ByteArray,
    val dstPort: Int,
    val dnsPayloadOffset: Int,
    val rawDns: ByteArray,
  )

  /** Parse an IPv4 UDP/53 packet; null for anything else (TCP, fragments, IPv6). */
  fun parseQuery(packet: ByteArray): Query? {
    if (packet.size < 28) return null
    val version = (packet[0].toInt() shr 4) and 0xF
    if (version != 4) return null
    val ihl = (packet[0].toInt() and 0xF) * 4
    if (packet.size < ihl + 8) return null
    if ((packet[9].toInt() and 0xFF) != 17) return null // UDP only

    val bb = ByteBuffer.wrap(packet)
    val srcAddr = packet.copyOfRange(12, 16)
    val dstAddr = packet.copyOfRange(16, 20)
    val udpOff = ihl
    bb.position(udpOff)
    val srcPort = bb.short.toInt() and 0xFFFF
    val dstPort = bb.short.toInt() and 0xFFFF
    if (dstPort != 53 && srcPort != 53) return null

    val dnsOff = udpOff + 8
    if (packet.size <= dnsOff + 12) return null
    bb.position(dnsOff)
    val txid = bb.short.toInt() and 0xFFFF
    val flags = bb.short.toInt() and 0xFFFF
    val qd = bb.short.toInt() and 0xFFFF
    bb.position(dnsOff + 12) // past an/ns/ar counts — QNAME starts at +12
    if (qd < 1) return null

    // QNAME: length-prefixed labels terminated by 0
    val name = StringBuilder()
    while (true) {
      if (bb.position() >= packet.size) return null
      val len = bb.get().toInt() and 0xFF
      if (len == 0) break
      if (len and 0xC0 != 0) return null // compressed name in a question = malformed
      if (bb.position() + len > packet.size) return null
      val label = ByteArray(len)
      bb.get(label)
      if (name.isNotEmpty()) name.append('.')
      name.append(String(label))
    }
    if (bb.remaining() < 4) return null
    val qType = bb.short.toInt() and 0xFFFF

    return Query(
      transactionId = txid,
      flags = flags,
      domain = name.toString().lowercase(),
      qType = qType,
      srcAddr = srcAddr,
      srcPort = srcPort,
      dstAddr = dstAddr,
      dstPort = dstPort,
      dnsPayloadOffset = dnsOff,
      rawDns = packet.copyOfRange(dnsOff, packet.size),
    )
  }

  /**
   * Build a DNS response packet for the query: NXDOMAIN when `blocked`, otherwise
   * a 60s A record pointing at [answerIp] (or srcPort/dstPort swapped header on a
   * relayed upstream answer when [relay] is set — the relay path rewrites only
   * the transport addresses and keeps the upstream DNS body verbatim).
   */
  fun buildResponse(query: Query, blocked: Boolean, relay: ByteArray? = null): ByteArray {
    val dns: ByteArray = relay ?: run {
      // QR=1, copy RD, RA=1, RCODE=3 (NXDOMAIN) — clients treat NXDOMAIN as
      // "does not exist", which is the honest answer for a filtered domain.
      val bb = ByteBuffer.allocate(query.rawDns.size)
      bb.put(query.rawDns)
      bb.position(0)
      bb.putShort(query.transactionId.toShort())
      val flags = 0x8000 or 0x0080 or (query.flags and 0x0100) or (if (blocked) 0x0003 else 0x0000)
      bb.putShort(flags.toShort())
      bb.array()
    }

    val ipLen = 20 + 8 + dns.size
    val out = ByteBuffer.allocate(ipLen)
    out.put(0x45.toByte())             // version 4, IHL 5
    out.put(0)                         // DSCP
    out.putShort(ipLen.toShort())
    out.putShort(0)                    // id
    out.putShort(0x4000.toShort())     // DF
    out.put(64.toByte())               // TTL
    out.put(17.toByte())               // UDP
    out.putShort(0)                    // checksum (patched below)
    out.put(query.dstAddr)             // src = the virtual DNS addr the client asked
    out.put(query.srcAddr)             // dst = the client
    out.putShort(query.dstPort.toShort())
    out.putShort(query.srcPort.toShort())
    out.putShort((8 + dns.size).toShort())
    out.putShort(0)                    // UDP checksum — 0 disables it (valid for IPv4)
    out.put(dns)
    val packet = out.array()
    // IPv4 header checksum
    val sum = ipv4Checksum(packet)
    packet[10] = (sum shr 8).toByte()
    packet[11] = (sum and 0xFF).toByte()
    return packet
  }

  private fun ipv4Checksum(header: ByteArray): Int {
    var sum = 0
    var i = 0
    while (i < 20) {
      if (i == 10) { i += 2; continue } // checksum field itself
      sum += ((header[i].toInt() and 0xFF) shl 8) or (header[i + 1].toInt() and 0xFF)
      i += 2
    }
    while (sum shr 16 != 0) sum = (sum and 0xFFFF) + (sum shr 16)
    return sum.inv() and 0xFFFF
  }

  /** Extract the DNS payload from an upstream response packet. */
  fun extractDns(packet: ByteArray): ByteArray? {
    if (packet.size < 28 || (packet[0].toInt() and 0xF) * 4 > packet.size) return null
    val ihl = (packet[0].toInt() and 0xF) * 4
    return packet.copyOfRange(ihl + 8, packet.size)
  }

  fun dstIpOf(packet: ByteArray): InetAddress? =
    if (packet.size >= 20 && (packet[0].toInt() shr 4) == 4) {
      InetAddress.getByAddress(packet.copyOfRange(16, 20))
    } else null
}

package com.blockingmachine.localvpn

import java.net.InetAddress

/**
 * Boundary validation for the capture hub address (P4 T2 review).
 *
 * The settings card gates "Start" on an IP literal, but the module boundary
 * must defend itself: a hostname would resolve through whatever DNS the
 * tunnel itself is answering (or fail there), and an empty string arms
 * capture against a meaningless dial. The tunnel's own virtual space is
 * rejected too — dialing the tun's own address loops straight back.
 *
 * Pure JVM — the unit tests cover it.
 */
object HubHost {

  /** The hub field accepts a numeric literal only — never a DNS name. */
  fun isIpLiteral(host: String): Boolean = isIpv4(host) || isIpv6(host)

  /**
   * Validate `EXTRA_HUB_HOST`: must be an IP literal and must not sit inside
   * the tunnel's own virtual space ([ownAddrs] — the tun address, its v6
   * twin and the virtual resolver). Returns the trimmed literal; throws
   * [IllegalArgumentException], which the bridge surfaces as a rejected
   * promise.
   */
  fun requireLiteral(host: String?, vararg ownAddrs: String): String {
    val h = host?.trim().orEmpty()
    require(isIpLiteral(h)) {
      "hub address must be an IP literal (e.g. 192.168.1.20), got '$h'"
    }
    // Safe below: the literal gate means getByName parses numerically — a
    // proven literal can never fall through to DNS.
    val bytes = runCatching { InetAddress.getByName(h).address }
      .getOrElse { throw IllegalArgumentException("hub address is not parseable: '$h'") }
    for (own in ownAddrs) {
      val ownBytes = runCatching { InetAddress.getByName(own).address }.getOrNull() ?: continue
      if (ownBytes.contentEquals(bytes)) {
        throw IllegalArgumentException("hub address $h is the tunnel's own virtual space")
      }
    }
    return h
  }

  private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")
  private val HEXTET = Regex("""^[0-9a-fA-F]{1,4}$""")

  /** Dotted-quad, each octet 0–255, no leading-zero octets. */
  private fun isIpv4(host: String): Boolean {
    val m = IPV4.matchEntire(host) ?: return false
    return m.groupValues.drop(1).all { it.toInt() <= 255 && it.toInt().toString() == it }
  }

  /**
   * IPv6 literal: hextets with at most one `::` compression (which must stand
   * for at least one group) and an optional embedded-IPv4 tail counting as
   * the last two groups. No zone ids — a LAN hub address doesn't need one.
   * Mirrors the JS-side validator in src/filter/httpsCapture.ts.
   */
  private fun isIpv6(host: String): Boolean {
    var s = host
    if (s.isEmpty() || s.length > 45 || !s.contains(':')) return false

    // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) — validate it, then count
    // it as two ordinary hextets below.
    val lastColon = s.lastIndexOf(':')
    val tail = s.substring(lastColon + 1)
    if (tail.contains('.')) {
      if (!isIpv4(tail)) return false
      s = s.substring(0, lastColon + 1) + "0:0"
    }

    val halves = s.split("::")
    if (halves.size > 2) return false
    val groups = { h: String -> if (h.isEmpty()) emptyList() else h.split(':') }
    for (g in groups(halves[0]) + (if (halves.size == 2) groups(halves[1]) else emptyList())) {
      if (!HEXTET.matches(g)) return false
    }
    if (halves.size == 1) return groups(halves[0]).size == 8
    return groups(halves[0]).size + groups(halves[1]).size < 8
  }
}

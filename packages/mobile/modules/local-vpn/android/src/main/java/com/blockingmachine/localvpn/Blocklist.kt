package com.blockingmachine.localvpn

import java.io.File

/**
 * Suffix-matching domain blocklist shared by the VPN DNS responder and the
 * PAC/CONNECT proxy. The rules file is a compact native format written by the JS
 * side: one domain per line, `!domain` for exceptions — no ABP syntax on-device
 * (the JS layer already normalized it from the hub feed).
 */
class Blocklist private constructor(
  private val blocked: Set<String>,
  private val exceptions: Set<String>,
) {
  val size: Int get() = blocked.size

  /** Suffix match: `ads.doubleclick.net` is blocked when `doubleclick.net` is listed. */
  private fun suffixHit(rules: Set<String>, domain: String): Boolean {
    var d = domain
    while (true) {
      if (rules.contains(d)) return true
      val dot = d.indexOf('.')
      if (dot < 0) return false
      d = d.substring(dot + 1)
    }
  }

  fun isBlocked(domain: String): Boolean {
    val d = domain.lowercase().trimEnd('.')
    if (d.isEmpty()) return false
    if (suffixHit(exceptions, d)) return false // exception rules win
    return suffixHit(blocked, d)
  }

  companion object {
    /** Empty ruleset — nothing blocked, VPN still forwards. */
    val EMPTY = Blocklist(emptySet(), emptySet())

    fun load(path: String): Blocklist {
      val blocked = HashSet<String>()
      val exceptions = HashSet<String>()
      // JS hands us FileSystem.documentDirectory — a file:// URI, not a raw path.
      File(path.removePrefix("file://")).forEachLine { raw ->
        val line = raw.trim().lowercase()
        when {
          line.isEmpty() || line.startsWith("#") -> Unit
          line.startsWith("!") -> exceptions += line.substring(1)
          else -> blocked += line
        }
      }
      return Blocklist(blocked, exceptions)
    }
  }
}

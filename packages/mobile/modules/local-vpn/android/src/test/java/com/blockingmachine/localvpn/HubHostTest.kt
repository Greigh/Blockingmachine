package com.blockingmachine.localvpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Hub-host boundary validation — the shapes startHttpsCapture must reject at
 * the module edge (names, empties, the tun's own virtual space). Mirrors the
 * JS-side cases in src/__tests__/httpsCapture.test.ts.
 */
class HubHostTest {

  private val OWN = arrayOf("10.0.0.2", "10.0.0.53", "fd00::2")

  @Test
  fun `accepts v4 and v6 literals`() {
    for (ok in listOf("192.168.1.20", "10.0.0.5", "8.8.8.8", "fd00::5", "2001:db8::5", "::ffff:192.0.2.1")) {
      assertTrue("$ok should validate", HubHost.isIpLiteral(ok))
      assertEquals(ok, HubHost.requireLiteral(ok, *OWN))
    }
  }

  @Test
  fun `rejects names, empties, and malformed shapes`() {
    for (bad in listOf("", " ", "hub.local", "blockingmachine.lan", "256.1.1.1", "01.2.3.4",
      "1::2::3", "1.2.3.4 ", "gggg::1", "fe80::1%eth0", "http://192.168.1.20:9293")) {
      assertFalse("'$bad' should not validate untrimmed", HubHost.isIpLiteral(bad))
    }
    // requireLiteral trims first — "1.2.3.4 " is out of this list on purpose.
    for (bad in listOf("", " ", "hub.local", "blockingmachine.lan", "256.1.1.1", "01.2.3.4",
      "1::2::3", "gggg::1", "fe80::1%eth0", "http://192.168.1.20:9293")) {
      try {
        HubHost.requireLiteral(bad, *OWN)
        fail("'$bad' should have thrown")
      } catch (e: IllegalArgumentException) {
        // expected — the bridge turns this into a rejected promise
      }
    }
    try {
      HubHost.requireLiteral(null, *OWN)
      fail("null should have thrown")
    } catch (e: IllegalArgumentException) {
      // expected
    }
  }

  @Test
  fun `rejects the tunnel's own virtual space in any written form`() {
    for (own in listOf("10.0.0.2", "10.0.0.53", "fd00::2", "fd00:0:0:0:0:0:0:2", "FD00::2")) {
      try {
        HubHost.requireLiteral(own, *OWN)
        fail("$own should have thrown")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message!!.contains("virtual space"))
      }
    }
  }

  @Test
  fun `trims surrounding whitespace before validating`() {
    assertEquals("192.168.1.20", HubHost.requireLiteral("  192.168.1.20  ", *OWN))
  }
}

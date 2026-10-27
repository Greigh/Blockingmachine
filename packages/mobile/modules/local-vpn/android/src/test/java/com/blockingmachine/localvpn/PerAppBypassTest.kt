package com.blockingmachine.localvpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The package-name grammar the `setDisallowedApps` bridge enforces before a
 * set is persisted — mirrors the JS-side checks in
 * src/__tests__/perAppBypass.test.ts.
 */
class PerAppBypassTest {

  @Test
  fun `accepts manifest-shaped package names`() {
    for (ok in listOf(
      "com.blockingmachine.mobile",
      "a.b",
      "com.example",
      "org.foo_bar.baz9",
      "A.B2",
      "com.x",
    )) {
      assertEquals(ok, sanitizePackageName(ok))
    }
  }

  @Test
  fun `trims surrounding whitespace`() {
    assertEquals("com.example.app", sanitizePackageName("  com.example.app  \n"))
  }

  @Test
  fun `rejects shapes that cannot be a package`() {
    for (bad in listOf(
      "",
      "   ",
      "9com.example",     // leading digit
      "com.9example",     // segment leading digit
      "com..app",         // empty segment
      ".com.app",         // leading dot
      "com.app.",         // trailing dot
      "com.exa mple",     // embedded space
      "com.example-app",  // hyphen
      "com/example",      // slash
      "com.example:app",  // colon
      "com.example.app\u0000", // NUL
      "a".repeat(256),    // over the length cap
    )) {
      assertNull("'$bad' must not sanitize", sanitizePackageName(bad))
    }
  }
}

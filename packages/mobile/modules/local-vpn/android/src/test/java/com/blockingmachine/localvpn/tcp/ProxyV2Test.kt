package com.blockingmachine.localvpn.tcp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * PROXY-v2 emit golden tests — the vectors are COPIED VERBATIM from
 * `helper/common/splice-golden-test.c` (test_v4 / test_v6): the Kotlin emit
 * must be byte-identical to the C helper's `bm_proxy_v2_format` output, which
 * is itself verified against the engine parser's expected bytes
 * (`src/__tests__/helper.test.ts`).
 */
class ProxyV2Test {

  /* src 192.0.2.10:51000 → dst 203.0.113.7:443 — copied verbatim from
   * splice-golden-test.c `want[28]`. */
  @Test
  fun `v4 header emits the exact C-helper golden bytes`() {
    val want = byteArrayOf(
      0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      0x21, 0x11, 0x00, 0x0c,
      0xc0.toByte(), 0x00, 0x02, 0x0a, 0xcb.toByte(), 0x00, 0x71, 0x07,
      0xc7.toByte(), 0x38, 0x01, 0xbb.toByte(),
    )
    val got = ProxyV2.encode(
      byteArrayOf(0xc0.toByte(), 0x00, 0x02, 0x0a), 51000,
      byteArrayOf(0xcb.toByte(), 0x00, 0x71, 0x07), 443,
    )
    assertEquals(28, got.size)
    assertArrayEquals(want, got)
  }

  @Test
  fun `v6 header emits the exact C-helper golden bytes`() {
    val want = byteArrayOf(
      0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      0x21, 0x21, 0x00, 0x24,
      0x20, 0x01, 0x0d, 0xb8.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
      0x20, 0x01, 0x0d, 0xb8.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
      0xcb.toByte(), 0x20, 0x01, 0xbb.toByte(),
    )
    val src = byteArrayOf(
      0x20, 0x01, 0x0d, 0xb8.toByte(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    )
    val dst = byteArrayOf(
      0x20, 0x01, 0x0d, 0xb8.toByte(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
    )
    val got = ProxyV2.encode(src, 52000, dst, 443)
    assertEquals(52, got.size)
    assertArrayEquals(want, got)
  }

  /* Flag 127: the auth token lands as a custom TLV (type 0xE0, 2-byte BE
   * length, UTF-8 bytes) appended after the address block and counted in the
   * declared length — the exact shape `proxyProtocol.ts` parses. */
  @Test
  fun `auth token emits the 0xE0 TLV inside the declared length`() {
    val want = byteArrayOf(
      0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      0x21, 0x11, 0x00, 0x12,                     // len = 12 + 3 + 3 = 18
      0xc0.toByte(), 0x00, 0x02, 0x0a, 0xcb.toByte(), 0x00, 0x71, 0x07,
      0xc7.toByte(), 0x38, 0x01, 0xbb.toByte(),
      0xE0.toByte(), 0x00, 0x03, 't'.code.toByte(), 'o'.code.toByte(), 'k'.code.toByte(),
    )
    val got = ProxyV2.encode(
      byteArrayOf(0xc0.toByte(), 0x00, 0x02, 0x0a), 51000,
      byteArrayOf(0xcb.toByte(), 0x00, 0x71, 0x07), 443,
      "tok",
    )
    assertEquals(16 + 18, got.size)
    assertArrayEquals(want, got)
  }

  @Test
  fun `utf8 tokens encode their byte length, not their char count`() {
    val token = "tök€n" // ö = 2 bytes, € = 3 bytes → 8 UTF-8 bytes, 5 chars
    val got = ProxyV2.encode(
      byteArrayOf(127, 0, 0, 1), 1000,
      byteArrayOf(8, 8, 8, 8), 443,
      token,
    )
    assertEquals(16 + 12 + 3 + 8, got.size)
    // TLV header
    assertEquals(0xE0.toByte(), got[28])
    assertEquals(0x00.toByte(), got[29])
    assertEquals(0x08.toByte(), got[30])
    val tlv = got.copyOfRange(31, 31 + 8)
    assertArrayEquals(token.toByteArray(Charsets.UTF_8), tlv)
  }

  @Test
  fun `empty and null tokens emit no TLV`() {
    val v4 = byteArrayOf(127, 0, 0, 1)
    assertEquals(28, ProxyV2.encode(v4, 1, v4, 2, null).size)
    assertEquals(28, ProxyV2.encode(v4, 1, v4, 2, "").size)
  }

  @Test
  fun `mixed families and bad sizes throw`() {
    val v4 = byteArrayOf(127, 0, 0, 1)
    val v6 = ByteArray(16)
    assertThrows { ProxyV2.encode(v4, 1, v6, 2) }       // family mismatch
    assertThrows { ProxyV2.encode(byteArrayOf(1, 2, 3), 1, byteArrayOf(1, 2, 3), 2) } // bad size
    assertThrows { ProxyV2.encode(v4, -1, v4, 2) }      // bad port
    assertThrows { ProxyV2.encode(v4, 1, v4, 65536) }   // port out of range
  }

  private fun assertThrows(block: () -> Unit) {
    try {
      block()
    } catch (e: IllegalArgumentException) {
      return
    }
    fail("expected IllegalArgumentException")
  }
}

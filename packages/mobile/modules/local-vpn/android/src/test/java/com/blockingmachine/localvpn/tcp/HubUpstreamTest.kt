package com.blockingmachine.localvpn.tcp

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * HubUpstream/DirectUpstream pump tests — a FakeSocket seam (no real dials):
 * connect() parks on a gate, outbound bytes accumulate in a buffer, inbound is
 * a fixed script or quiet-until-closed. attach() arms the worker via a real
 * TcpSession so the session's own callbacks carry the assertions.
 */
class HubUpstreamTest {

  private val SRC = byteArrayOf(10, 0, 0, 8)
  private val DST = byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34)
  private val SPORT = 50000
  private val DPORT = 443
  private val CISSN = 0x1111_2222L

  private fun key(dport: Int = DPORT) = FlowKey(Packet.FAMILY_V4, SRC, SPORT, DST, dport)

  /**
   * A Socket with no network: [connect] blocks until [connectGate] opens (or
   * the socket closes), [getOutputStream] records into [out], and
   * [getInputStream] replays [inboundScript] (then EOF) or blocks quiet until
   * close — an idle server.
   */
  class FakeSocket(
    private val connectGate: CountDownLatch = CountDownLatch(0),
    inboundScript: ByteArray? = null,
  ) : Socket() {
    val out = ByteArrayOutputStream()
    val connectedAt = AtomicReference<SocketAddress?>()
    val connectStarted = AtomicBoolean(false)
    val shutdownOutCalled = AtomicBoolean(false)
    private val closedFlag = AtomicBoolean(false)
    private val closeLatch = CountDownLatch(1)
    private val scripted = inboundScript?.let { ByteArrayInputStream(it) }

    private val input = object : InputStream() {
      override fun read(): Int = quietRead()
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        scripted?.let { return it.read(b, off, len) }
        return quietRead()
      }
      private fun quietRead(): Int {
        closeLatch.await(10, TimeUnit.SECONDS)
        return -1
      }
    }

    override fun connect(endpoint: SocketAddress?, timeout: Int) {
      connectStarted.set(true)
      while (!isClosed && !connectGate.await(25, TimeUnit.MILLISECONDS)) {
        // parked — a slow/refused dial held off the reader thread
      }
      if (!isClosed) connectedAt.set(endpoint)
    }
    override fun getOutputStream(): OutputStream = out
    override fun getInputStream(): InputStream = input
    override fun shutdownOutput() { shutdownOutCalled.set(true) }
    override fun close() {
      if (closedFlag.compareAndSet(false, true)) closeLatch.countDown()
    }
    override fun isClosed(): Boolean = closedFlag.get()
  }

  private fun pkt(seq: Long, ack: Long, flags: Int, payload: ByteArray = ByteArray(0)): ByteArray =
    Packet.buildTcpSegment(Packet.FAMILY_V4, SRC, DST, SPORT, DPORT, seq, ack, flags, 65535, payload)

  /** Establish the session so abortWithRst actually emits (state != CLOSED). */
  private fun handshook(session: TcpSession, emitted: MutableList<ByteArray>): Long {
    session.onPacket(pkt(CISSN, 0, Packet.FLAG_SYN))
    val issn = Packet.parseTcp(emitted.last())!!.seq
    session.onPacket(pkt(CISSN + 1, issn + 1, Packet.FLAG_ACK))
    emitted.clear()
    return issn
  }

  private fun await(timeoutMs: Long = 4_000, cond: () -> Boolean) {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (!cond()) {
      assertTrue("condition not met within ${timeoutMs}ms", System.nanoTime() < deadline)
      Thread.sleep(5)
    }
  }

  /* ------------------------------------------------------------ */

  @Test
  fun `the dial and every write stay off the caller thread`() {
    val gate = CountDownLatch(1) // connect parks — a slow hub
    val fake = FakeSocket(connectGate = gate)
    val emitted = mutableListOf<ByteArray>()
    val up = HubUpstream(key(), "192.0.2.10", 9294, protect = {}, socketFactory = { fake })

    val t0 = System.nanoTime()
    TcpSession(key(), { emitted += it }, up) // attach arms the worker
    val attachMs = (System.nanoTime() - t0) / 1_000_000
    assertTrue("attach blocked ${attachMs}ms on the dial", attachMs < 500)

    await { fake.out.size() == 0 && fake.connectedAt.get() == null } // dial still parked
    val w0 = System.nanoTime()
    repeat(8) { up.write(ByteArray(1024) { it.toByte() }) }
    assertTrue("write blocked on a parked dial", (System.nanoTime() - w0) / 1_000_000 < 200)
    assertNull(fake.connectedAt.get())

    up.abort()
    gate.countDown()
  }

  @Test
  fun `abort during the dial closes the in-flight socket`() {
    val gate = CountDownLatch(1) // connect parks — a slow hub
    val fake = FakeSocket(connectGate = gate)
    val up = HubUpstream(key(), "192.0.2.10", 9294, protect = {}, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    TcpSession(key(), { emitted += it }, up)
    await { fake.connectStarted.get() } // the worker is mid-connect()

    up.abort()
    // The socket was published before connect() so abort() could close it —
    // the parked dial breaks without waiting on the gate or the 10s timeout.
    await { fake.isClosed }
    gate.countDown()
  }

  @Test
  fun `proxy-v2 header is the first bytes the socket sees`() {
    val fake = FakeSocket()
    val k = key()
    val up = HubUpstream(k, "192.0.2.10", 9294, protect = {}, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    TcpSession(k, { emitted += it }, up)

    await { fake.connectedAt.get() != null && fake.out.size() >= 28 }
    assertEquals(9294, (fake.connectedAt.get() as InetSocketAddress).port)
    assertArrayEquals(
      ProxyV2.encode(SRC, SPORT, DST, DPORT),
      fake.out.toByteArray().copyOf(28),
    )

    up.write("GET / HTTP/1.1\r\n".toByteArray())
    await { fake.out.size() >= 28 + 16 }
    assertArrayEquals(
      "GET / HTTP/1.1\r\n".toByteArray(),
      fake.out.toByteArray().copyOfRange(28, 28 + 16),
    )
    up.abort()
  }

  @Test
  fun `protect wraps the socket before the dial`() {
    val order = ConcurrentLinkedDeque<String>()
    val fake = object : Socket() {
      override fun connect(endpoint: SocketAddress?, timeout: Int) { order += "connect" }
      override fun getOutputStream(): OutputStream = ByteArrayOutputStream()
      override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))
    }
    val up = HubUpstream(key(), "192.0.2.10", 9294, protect = { order += "protect" }, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    TcpSession(key(), { emitted += it }, up)
    await { order.contains("connect") }
    assertEquals(listOf("protect", "connect"), order.toList())
    up.abort()
  }

  @Test
  fun `queue overflow rst-kills the flow`() {
    val gate = CountDownLatch(1)
    val fake = FakeSocket(connectGate = gate) // dial parked — the queue can't drain
    val k = key()
    val up = HubUpstream(k, "192.0.2.10", 9294, protect = {}, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    val session = TcpSession(k, { emitted += it }, up)
    handshook(session, emitted)

    val chunk = ByteArray(64 * 1024) { 0x55 }
    repeat(QueuedSocketUpstream.DEFAULT_QUEUE_CAP_BYTES / chunk.size) { up.write(chunk) }
    assertFalse(session.terminated) // exactly at the cap — still alive

    up.write(byteArrayOf(0x55)) // one byte over → RST
    assertTrue(session.terminated)
    assertTrue(Packet.parseTcp(emitted.last())!!.has(Packet.FLAG_RST))
    await { fake.isClosed }
    gate.countDown()
  }

  @Test
  fun `closeOut flushes queued bytes then shutdowns output`() {
    val fake = FakeSocket()
    val k = key()
    val up = HubUpstream(k, "192.0.2.10", 9294, protect = {}, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    TcpSession(k, { emitted += it }, up)

    await { fake.out.size() >= 28 } // preamble landed
    up.write("AB".toByteArray())
    up.closeOut()
    await { fake.shutdownOutCalled.get() }
    val all = fake.out.toByteArray()
    assertEquals(28 + 2, all.size)
    assertEquals("AB", String(all.copyOfRange(28, 30)))
    up.abort()
  }

  @Test
  fun `socket bytes and eof reach the session`() {
    val reply = "HTTP/1.1 200 OK\r\n\r\n".toByteArray()
    val fake = FakeSocket(inboundScript = reply)
    val k = key()
    val up = HubUpstream(k, "192.0.2.10", 9294, protect = {}, socketFactory = { fake })
    // COW list — the upstream READER thread appends while the asserts iterate.
    val emitted = CopyOnWriteArrayList<ByteArray>()
    val session = TcpSession(k, { emitted += it }, up)
    handshook(session, emitted)

    // The reader thread pumped the scripted reply in, then hit EOF → FIN.
    await(timeoutMs = 4_000) {
      emitted.any { Packet.parseTcp(it)?.has(Packet.FLAG_FIN) == true }
    }
    assertTrue(
      emitted.any {
        Packet.parseTcp(it)?.payload?.contentEquals(reply) == true
      },
    )
    up.abort()
  }

  @Test
  fun `connect failure reports upstream error and terminates the session`() {
    val dead = object : Socket() {
      override fun connect(endpoint: SocketAddress?, timeout: Int) {
        throw java.net.SocketException("refused")
      }
    }
    val up = HubUpstream(key(), "192.0.2.10", 9294, protect = {}, socketFactory = { dead })
    val emitted = mutableListOf<ByteArray>()
    val session = TcpSession(key(), { emitted += it }, up)
    await { session.terminated }
  }

  @Test
  fun `direct upstream dials the original destination with no header`() {
    val fake = FakeSocket()
    val k = key(dport = 8080)
    val up = DirectUpstream(k, protect = {}, socketFactory = { fake })
    val emitted = mutableListOf<ByteArray>()
    TcpSession(k, { emitted += it }, up)

    up.write("X".toByteArray())
    await { fake.out.size() >= 1 && fake.connectedAt.get() != null }
    // First byte on the wire is payload — no PROXY-v2 preamble on pass-through.
    assertArrayEquals("X".toByteArray(), fake.out.toByteArray().copyOf(1))
    val ep = fake.connectedAt.get() as InetSocketAddress
    assertEquals(8080, ep.port)
    assertArrayEquals(DST, ep.address.address)
    up.abort()
  }
}

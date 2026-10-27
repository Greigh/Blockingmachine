package com.blockingmachine.localvpn.tcp

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketAddress
import java.net.SocketException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * UdpDispatcher relay tests — a FakeDatagramSocket seam (no real network):
 * send() records, receive() replays scripted datagrams then parks until the
 * socket closes. The clock is manual like the TCP suite's.
 */
class UdpDispatcherTest {

  private val SRC = byteArrayOf(10, 0, 0, 8)
  private val DST = byteArrayOf(8, 8, 8, 8)
  private val SRC6 = hex("fd000000000000000000000000000008")
  private val DST6 = hex("26064700470000000000000000001111")

  private lateinit var emitted: MutableList<ByteArray>
  private lateinit var sockets: MutableList<FakeDatagramSocket>
  private var scripted: List<ByteArray> = emptyList()
  private var now = 5_000_000L
  private lateinit var dispatcher: UdpDispatcher

  private fun hex(s: String): ByteArray =
    ByteArray(s.length / 2) { ((Character.digit(s[2 * it], 16) shl 4) or Character.digit(s[2 * it + 1], 16)).toByte() }

  /** A DatagramSocket with no network: sent datagrams land in [sent];
   *  receive() replays [replies] then parks until [close] drops the latch. */
  class FakeDatagramSocket(replies: List<ByteArray> = emptyList()) : DatagramSocket() {
    val sent = ConcurrentLinkedQueue<ByteArray>()
    val connectedTo = AtomicReference<SocketAddress?>()
    private val inbox = ConcurrentLinkedQueue(replies)
    private val closedFlag = AtomicBoolean(false)
    private val closeLatch = CountDownLatch(1)

    override fun connect(address: InetAddress?, port: Int) {
      connectedTo.set(InetSocketAddress(address, port))
    }

    override fun connect(peer: SocketAddress?) {
      connectedTo.set(peer)
    }

    override fun send(p: DatagramPacket) {
      if (isClosed) throw SocketException("Socket is closed")
      sent += p.data.copyOfRange(p.offset, p.offset + p.length)
    }

    override fun receive(p: DatagramPacket) {
      inbox.poll()?.let { d ->
        d.copyInto(p.data, p.offset)
        p.length = d.size
        return
      }
      closeLatch.await(30, TimeUnit.SECONDS)
      throw SocketException("Socket closed")
    }

    override fun close() {
      if (closedFlag.compareAndSet(false, true)) closeLatch.countDown()
    }

    override fun isClosed(): Boolean = closedFlag.get()
  }

  @Before
  fun setUp() {
    emitted = mutableListOf()
    sockets = mutableListOf()
    scripted = emptyList()
    now = 5_000_000L
    dispatcher = UdpDispatcher(
      emit = { emitted += it },
      protect = {},
      socketFactory = { FakeDatagramSocket(replies = scripted).also { sockets += it } },
      nowMs = { now },
      maxSessions = 3,
      idleTimeoutMs = 60_000L,
    )
  }

  private fun pkt(sport: Int, dport: Int, payload: ByteArray = byteArrayOf(0x01),
                  src: ByteArray = SRC, dst: ByteArray = DST): ByteArray =
    Packet.buildUdpDatagram(Packet.FAMILY_V4, src, dst, sport, dport, payload)

  private fun await(timeoutMs: Long = 4_000, cond: () -> Boolean) {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (!cond()) {
      assertTrue("condition not met within ${timeoutMs}ms", System.nanoTime() < deadline)
      Thread.sleep(5)
    }
  }

  /* ------------------------------------------------------------ */

  @Test
  fun `non-udp packets are refused`() {
    // A TCP packet (proto 6) is not ours.
    val tcp = Packet.buildTcpSegment(Packet.FAMILY_V4, SRC, DST, 50000, 443, 0, 0, Packet.FLAG_SYN, 65535)
    assertFalse(dispatcher.onPacket(tcp))
    assertEquals(0, dispatcher.activeCount())
  }

  @Test
  fun `first datagram creates a session that sends via the connected socket`() {
    assertTrue(dispatcher.onPacket(pkt(53000, 123, "ntp".toByteArray())))
    assertEquals(1, dispatcher.activeCount())
    assertEquals(1, dispatcher.flowsOpened.get())
    val sock = sockets.single()
    val peer = sock.connectedTo.get() as InetSocketAddress
    assertEquals(123, peer.port)
    assertArrayEquals(DST, peer.address.address)
    assertArrayEquals("ntp".toByteArray(), sock.sent.single())
    assertEquals(1L, dispatcher.datagramsIn.get())
    assertEquals(1L, dispatcher.datagramsOut.get())
    dispatcher.close()
  }

  @Test
  fun `same pair reuses the session — no second socket`() {
    dispatcher.onPacket(pkt(53000, 123, byteArrayOf(1)))
    dispatcher.onPacket(pkt(53000, 123, byteArrayOf(2)))
    assertEquals(1, dispatcher.activeCount())
    assertEquals(1, sockets.size)
    assertEquals(2, sockets.single().sent.size)
    dispatcher.close()
  }

  @Test
  fun `socket reply rebuilds an ip+udp packet with the tuple swapped`() {
    scripted = listOf("pong".toByteArray())
    dispatcher.onPacket(pkt(53000, 123, "ping".toByteArray()))
    await { emitted.isNotEmpty() }
    val reply = Packet.parseUdp(emitted.single())!!
    assertEquals(Packet.FAMILY_V4, reply.family)
    assertArrayEquals(DST, reply.srcAddr)
    assertArrayEquals(SRC, reply.dstAddr)
    assertEquals(123, reply.srcPort)
    assertEquals(53000, reply.dstPort)
    assertArrayEquals("pong".toByteArray(), reply.payload)
    dispatcher.close()
  }

  @Test
  fun `v6 pairs relay with v6 replies`() {
    scripted = listOf(byteArrayOf(0x2a))
    val p = Packet.buildUdpDatagram(Packet.FAMILY_V6, SRC6, DST6, 53000, 123, byteArrayOf(1))
    assertTrue(dispatcher.onPacket(p))
    await { emitted.isNotEmpty() }
    val reply = Packet.parseUdp(emitted.single())!!
    assertEquals(Packet.FAMILY_V6, reply.family)
    assertArrayEquals(DST6, reply.srcAddr)
    assertArrayEquals(SRC6, reply.dstAddr)
    assertArrayEquals(byteArrayOf(0x2a), reply.payload)
    dispatcher.close()
  }

  @Test
  fun `idle sessions reap on tick`() {
    dispatcher.onPacket(pkt(53000, 123))
    assertEquals(1, dispatcher.activeCount())
    now += 59_999L
    dispatcher.onTick()
    assertEquals(1, dispatcher.activeCount())
    now += 2
    dispatcher.onTick()
    assertEquals(0, dispatcher.activeCount())
    assertTrue(sockets.single().isClosed)
    assertEquals(1, dispatcher.flowsClosed.get())
  }

  @Test
  fun `cap evicts the least-recently-touched pair`() {
    dispatcher.onPacket(pkt(53001, 123))
    dispatcher.onPacket(pkt(53002, 123))
    dispatcher.onPacket(pkt(53003, 123))
    assertEquals(3, dispatcher.activeCount())

    // Touch pair-1 so pair-2 becomes the LRU eldest.
    dispatcher.onPacket(pkt(53001, 123))
    dispatcher.onPacket(pkt(53004, 123)) // overflows the cap
    assertEquals(3, dispatcher.activeCount())
    assertTrue(dispatcher.sessions.keys.any { it.srcPort == 53001 })
    assertFalse(dispatcher.sessions.keys.any { it.srcPort == 53002 })
    assertTrue(dispatcher.sessions.keys.any { it.srcPort == 53004 })
    assertEquals(1, sockets.count { it.isClosed }) // exactly the evicted socket
    dispatcher.close()
  }

  @Test
  fun `malformed udp is consumed silently — aimed at us but unparseable`() {
    // IP header + truncated UDP header (proto 17, too short for ports/length).
    val broken = byteArrayOf(0x45, 0, 0, 24, 0, 0, 0, 0, 64, 17, 0, 0) + SRC + DST + byteArrayOf(0x00, 0x50)
    assertTrue(dispatcher.onPacket(broken))
    assertEquals(0, dispatcher.activeCount())
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `socket factory failure drops the datagram without a session`() {
    val dead = UdpDispatcher(
      emit = { emitted += it },
      protect = {},
      socketFactory = { throw SocketException("no net") },
      nowMs = { now },
    )
    assertTrue(dead.onPacket(pkt(53000, 123)))
    assertEquals(0, dead.activeCount())
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `close tears every session down and refuses new packets`() {
    dispatcher.onPacket(pkt(53001, 123))
    dispatcher.onPacket(pkt(53002, 123))
    dispatcher.close()
    assertEquals(0, dispatcher.activeCount())
    assertTrue(sockets.all { it.isClosed })
    assertEquals(2, dispatcher.flowsClosed.get())
    assertFalse(dispatcher.onPacket(pkt(53003, 123)))
  }

  @Test
  fun `a send on a dead socket retires the session`() {
    dispatcher.onPacket(pkt(53000, 123))
    val sock = sockets.single()
    sock.close() // the socket died out from under the pair
    dispatcher.onPacket(pkt(53000, 123)) // next datagram's send fails → session retired
    assertEquals(0, dispatcher.activeCount())
    assertEquals(1, dispatcher.flowsClosed.get())
    dispatcher.close()
  }
}

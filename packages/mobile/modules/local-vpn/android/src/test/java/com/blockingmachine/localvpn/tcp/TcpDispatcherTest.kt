package com.blockingmachine.localvpn.tcp

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Dispatcher routing, bounds, reaper and stats. */
class TcpDispatcherTest {

  private val SRC = byteArrayOf(10, 0, 0, 8)
  private val DST = byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34)

  private lateinit var emitted: MutableList<ByteArray>
  private lateinit var upstreams: MutableList<TcpSessionTest.FakeUpstream>
  private var now = 5_000_000L
  private lateinit var dispatcher: TcpDispatcher

  private fun pkt(sport: Int, dport: Int, seq: Long, ack: Long, flags: Int,
                  payload: ByteArray = ByteArray(0), dst: ByteArray = DST,
                  options: ByteArray = ByteArray(0)): ByteArray =
    Packet.buildTcpSegment(Packet.FAMILY_V4, SRC, dst, sport, dport, seq, ack, flags, 65535, payload, options)

  private fun syn(sport: Int, dport: Int = 443, seq: Long = 100): ByteArray =
    pkt(sport, dport, seq, 0, Packet.FLAG_SYN, options = Packet.mssOption(1460))

  @Before
  fun setUp() {
    emitted = mutableListOf()
    upstreams = mutableListOf()
    now = 5_000_000L
    dispatcher = TcpDispatcher(
      emit = { emitted += it },
      upstreamFactory = { TcpSessionTest.FakeUpstream().also { upstreams += it } },
      nowMs = { now },
      maxSessions = 3,
    )
  }

  @Test
  fun `non-capture ports pass through`() {
    assertFalse(dispatcher.onPacket(pkt(50000, 9999, 100, 0, Packet.FLAG_SYN)))
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `syn on 443 opens a session and emits syn-ack`() {
    assertTrue(dispatcher.onPacket(syn(50000)))
    assertEquals(1, dispatcher.activeCount())
    assertEquals(1, dispatcher.stats.flowsOpened.get())
    assertEquals(1, upstreams.size)
    val sa = Packet.parseTcp(emitted.single())!!
    assertTrue(sa.has(Packet.FLAG_SYN) && sa.has(Packet.FLAG_ACK))
    assertEquals(101L, sa.ack)
  }

  @Test
  fun `non-syn for unknown flow answers rst`() {
    assertTrue(dispatcher.onPacket(pkt(50000, 80, 100, 55, Packet.FLAG_ACK)))
    assertEquals(0, dispatcher.activeCount())
    val rst = Packet.parseTcp(emitted.single())!!
    assertTrue(rst.has(Packet.FLAG_RST))
    assertEquals(1, dispatcher.stats.rst.get())
  }

  @Test
  fun `rst for unknown flow is dropped silently`() {
    assertTrue(dispatcher.onPacket(pkt(50000, 443, 100, 55, Packet.FLAG_RST)))
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `unparseable packet on capture port is consumed`() {
    // IP header + just enough TCP for the port peek, then it truncates —
    // aimed at :443 so the dispatcher owns it even though it can't parse.
    val p = byteArrayOf(0x45, 0, 0, 24, 0, 0, 0, 0, 64, 6, 0, 0) + SRC + DST +
      byteArrayOf(0x00, 0x50, 0x01, 0xbb.toByte())
    assertTrue(dispatcher.onPacket(p))
    assertTrue(emitted.isEmpty()) // nothing sane to RST back
  }

  @Test
  fun `lru eviction at cap rst-kills the oldest flow`() {
    dispatcher.onPacket(syn(50001, 443, 100))
    val issn1 = Packet.parseTcp(emitted.last())!!.seq
    dispatcher.onPacket(syn(50002, 443, 200))
    dispatcher.onPacket(syn(50003, 443, 300))
    assertEquals(3, dispatcher.activeCount())

    // Complete flow-1's handshake — a valid touch, making it the LRU-youngest.
    dispatcher.onPacket(pkt(50001, 443, 101, issn1 + 1, Packet.FLAG_ACK))
    emitted.clear()

    // The 4th SYN overflows the cap → evicts flow-2 (now the eldest), RST to it.
    dispatcher.onPacket(syn(50004, 443, 400))
    assertEquals(3, dispatcher.activeCount())
    assertTrue(emitted.any { p ->
      Packet.parseTcp(p)?.let { it.has(Packet.FLAG_RST) && it.dstPort == 50002 } == true
    })
    assertTrue(dispatcher.sessions.keys.any { it.srcPort == 50001 })
    assertFalse(dispatcher.sessions.keys.any { it.srcPort == 50002 })
    assertTrue(dispatcher.sessions.keys.any { it.srcPort == 50004 })
    assertEquals(4, dispatcher.stats.flowsOpened.get())
    assertEquals(1, dispatcher.stats.flowsClosed.get())
  }

  @Test
  fun `idle reaper closes silent flows on tick`() {
    dispatcher.onPacket(syn(50000))
    assertEquals(1, dispatcher.activeCount())
    now += TcpSession.IDLE_TIMEOUT_MS + 1
    dispatcher.onTick()
    assertEquals(0, dispatcher.activeCount())
    assertEquals(1, dispatcher.stats.flowsClosed.get())
    assertTrue(upstreams.single().aborted)
    assertTrue(Packet.parseTcp(emitted.last())!!.has(Packet.FLAG_RST))
  }

  @Test
  fun `closed session is removed after the packet that killed it`() {
    dispatcher.onPacket(syn(50000))
    dispatcher.onPacket(pkt(50000, 443, 101, 0xFFFF_FFFFL, Packet.FLAG_ACK)) // bad handshake ack → RST + die
    assertEquals(0, dispatcher.activeCount())
    assertEquals(1, dispatcher.stats.flowsOpened.get())
    assertEquals(1, dispatcher.stats.flowsClosed.get())
  }

  @Test
  fun `close aborts everything`() {
    dispatcher.onPacket(syn(50000))
    dispatcher.onPacket(syn(50001))
    dispatcher.close()
    assertEquals(0, dispatcher.activeCount())
    assertTrue(upstreams.all { it.aborted })
  }

  @Test
  fun `custom port filter turns the dispatcher into a pass-through`() {
    // The service's relay dispatcher is the same class with the filter flipped:
    // it claims every TCP port the capture dispatcher refuses.
    val relay = TcpDispatcher(
      emit = { emitted += it },
      upstreamFactory = { TcpSessionTest.FakeUpstream().also { upstreams += it } },
      nowMs = { now },
      portFilter = { it != 80 && it != 443 },
    )
    assertFalse(relay.onPacket(syn(50000)))          // :443 stays with capture
    assertFalse(relay.onPacket(pkt(50000, 80, 100, 0, Packet.FLAG_SYN)))
    assertTrue(relay.onPacket(pkt(50000, 8080, 100, 0, Packet.FLAG_SYN, options = Packet.mssOption(1460))))
    assertEquals(1, relay.activeCount())
    assertTrue(Packet.parseTcp(emitted.last())!!.has(Packet.FLAG_SYN))
  }

  @Test
  fun `closed dispatcher refuses packets so the fallback can claim them`() {
    dispatcher.onPacket(syn(50000))
    dispatcher.close()
    emitted.clear()
    assertFalse(dispatcher.onPacket(syn(50001)))
    assertTrue(emitted.isEmpty())
    assertEquals(0, dispatcher.activeCount())
  }

  @Test
  fun `dial race — the losing session aborts its upstream`() {
    // Thread A dials upstream then stalls inside the factory; thread B runs the
    // same SYN to completion and wins the map slot. A's putIfAbsent loses —
    // its session must be aborted, not dropped on the floor with a live socket.
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val once = AtomicBoolean(true)
    val racing = TcpDispatcher(
      emit = { emitted += it },
      upstreamFactory = {
        val u = TcpSessionTest.FakeUpstream().also { upstreams += it }
        if (once.getAndSet(false)) { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)) }
        u
      },
      nowMs = { now },
      maxSessions = 3,
    )
    val synPkt = syn(50000)
    val a = Thread { racing.onPacket(synPkt) }
    a.start()
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    val b = Thread { racing.onPacket(synPkt) }
    b.start(); b.join(5_000)
    release.countDown(); a.join(5_000)

    assertEquals(1, racing.activeCount())
    assertEquals(2, upstreams.size)
    assertEquals(1, upstreams.count { it.aborted }) // exactly the loser's dial was freed
    assertEquals(1, racing.stats.flowsOpened.get())
  }
}

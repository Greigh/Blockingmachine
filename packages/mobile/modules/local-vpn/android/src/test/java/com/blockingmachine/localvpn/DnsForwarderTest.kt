package com.blockingmachine.localvpn

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketAddress
import java.net.SocketException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * DnsForwarder demux tests (flag 130) — a FakeUpstreamSocket seam like the
 * UDP suite's: send() records the (txid-rewritten) wire bytes, receive()
 * hands back whatever the test queues. The out-of-order swap that used to
 * cross-deliver is the headline case.
 */
class DnsForwarderTest {

  private val UPSTREAM: InetAddress = InetAddress.getByName("8.8.8.8")

  private lateinit var emitted: ConcurrentLinkedQueue<Pair<DnsPacket.Query, ByteArray>>
  private lateinit var sock: FakeUpstreamSocket
  private lateinit var stats: DnsForwarder.Stats

  /** A DatagramSocket with no network: sent datagrams land in [sent];
   *  receive() pops [inbox], parking (and throwing on close) when empty. */
  class FakeUpstreamSocket : DatagramSocket() {
    val sent = ConcurrentLinkedQueue<ByteArray>()
    val inbox = LinkedBlockingQueue<ByteArray>()
    val connectedTo = AtomicReference<SocketAddress?>()
    private val closedFlag = AtomicBoolean(false)
    var failSend = false

    override fun connect(address: InetAddress?, port: Int) {
      connectedTo.set(InetSocketAddress(address, port))
    }

    override fun connect(peer: SocketAddress?) {
      connectedTo.set(peer)
    }

    override fun send(p: DatagramPacket) {
      if (isClosed) throw SocketException("Socket is closed")
      if (failSend) throw SocketException("dead on send")
      sent += p.data.copyOfRange(p.offset, p.offset + p.length)
    }

    override fun receive(p: DatagramPacket) {
      while (true) {
        if (closedFlag.get()) throw SocketException("Socket is closed")
        val d = inbox.poll(25, TimeUnit.MILLISECONDS) ?: continue
        d.copyInto(p.data, p.offset)
        p.length = d.size
        return
      }
    }

    override fun close() {
      closedFlag.set(true)
    }

    override fun isClosed(): Boolean = closedFlag.get()
  }

  private fun forwarder(
    timeoutMs: Long = 5_000L,
    maxPending: Int = 128,
    factory: () -> DatagramSocket = { sock },
  ) = DnsForwarder(
    upstream = UPSTREAM,
    emit = { q, dns -> emitted += q to dns },
    protect = {},
    socketFactory = factory,
    parentScope = CoroutineScope(Dispatchers.IO),
    stats = stats,
    upstreamPort = 53,
    maxPending = maxPending,
    timeoutMs = timeoutMs,
  )

  /** A synthetic query — the forwarder only needs the txid and the DNS body. */
  private fun query(txid: Int, tag: Byte): DnsPacket.Query = DnsPacket.Query(
    transactionId = txid,
    flags = 0x0100,
    domain = "host-$tag.example",
    qType = 1,
    srcAddr = byteArrayOf(10, 0, 0, 8),
    srcPort = 53000 + tag,
    dstAddr = byteArrayOf(10, 0, 0, 53),
    dstPort = 53,
    dnsPayloadOffset = 28,
    rawDns = dnsBody(txid, tag),
  )

  /** 13 bytes: txid + minimal header zeros + a marker byte for identity. */
  private fun dnsBody(txid: Int, tag: Byte): ByteArray =
    byteArrayOf((txid ushr 8).toByte(), txid.toByte()) +
      ByteArray(10) + byteArrayOf(tag)

  /** A scripted upstream reply for [upstreamId] carrying [tag] as marker. */
  private fun reply(upstreamId: Int, tag: Byte): ByteArray = dnsBody(upstreamId, tag)

  private fun txidOf(dns: ByteArray): Int =
    ((dns[0].toInt() and 0xFF) shl 8) or (dns[1].toInt() and 0xFF)

  private fun await(timeoutMs: Long = 4_000, cond: () -> Boolean) {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (!cond()) {
      assertTrue("condition not met within ${timeoutMs}ms", System.nanoTime() < deadline)
      Thread.sleep(5)
    }
  }

  @Before
  fun setUp() {
    emitted = ConcurrentLinkedQueue()
    sock = FakeUpstreamSocket()
    stats = DnsForwarder.Stats()
  }

  /* ------------------------------------------------------------ */

  @Test
  fun `the socket is protected and connected at the upstream`() {
    val f = forwarder()
    val peer = sock.connectedTo.get() as InetSocketAddress
    assertEquals(53, peer.port)
    assertEquals(UPSTREAM, peer.address)
    f.close()
  }

  @Test
  fun `out-of-order replies each reach their own query`() {
    val f = forwarder()
    val qa = query(0x1111, 0x4A)
    val qb = query(0x2222, 0x4B)
    f.forward(qa)
    f.forward(qb)

    val sent = sock.sent.toList()
    assertEquals(2, sent.size)
    // Both bodies went out rewritten under fresh, distinct upstream ids —
    // the client txids 0x1111/0x2222 are not (necessarily) what was sent.
    val upA = txidOf(sent[0])
    val upB = txidOf(sent[1])
    assertNotEquals(upA, upB)
    assertTrue(sent[0].copyOfRange(2, sent[0].size).contentEquals(qa.rawDns.copyOfRange(2, qa.rawDns.size)))
    assertTrue(sent[1].copyOfRange(2, sent[1].size).contentEquals(qb.rawDns.copyOfRange(2, qb.rawDns.size)))

    // The wedge the flag describes: B's reply lands first.
    sock.inbox += reply(upB, 0x4B)
    await { emitted.isNotEmpty() }
    var (q, dns) = emitted.poll()
    assertTrue(q === qb)
    assertEquals(0x2222, txidOf(dns)) // client's own txid restored
    assertEquals(0x4B.toByte(), dns[12]) // rest of the body verbatim

    sock.inbox += reply(upA, 0x4A)
    await { emitted.isNotEmpty() }
    val out = emitted.poll()
    q = out.first; dns = out.second
    assertTrue(q === qa)
    assertEquals(0x1111, txidOf(dns))
    assertEquals(0x4A.toByte(), dns[12])

    await { f.pendingCount() == 0 }
    assertEquals(0L, stats.droppedUnknown.get())
    assertEquals(0L, stats.timedOut.get())
    f.close()
  }

  @Test
  fun `a reply with an unknown txid is dropped and counted`() {
    val f = forwarder()
    sock.inbox += reply(0xDEAD, 0x00)
    await { stats.droppedUnknown.get() == 1L }
    assertTrue(emitted.isEmpty())
    f.close()
  }

  @Test
  fun `a too-short datagram is dropped and counted`() {
    val f = forwarder()
    sock.inbox += byteArrayOf(0x00, 0x01) // under a DNS header's 12 bytes
    await { stats.droppedUnknown.get() == 1L }
    f.close()
  }

  @Test
  fun `a timed-out query frees its slot — the late reply drops as unknown`() {
    val f = forwarder(timeoutMs = 80)
    f.forward(query(0x1111, 0x4A))
    val upA = txidOf(sock.sent.single())
    await { stats.timedOut.get() == 1L }
    assertEquals(0, f.pendingCount())
    sock.inbox += reply(upA, 0x4A)
    await { stats.droppedUnknown.get() == 1L }
    assertTrue(emitted.isEmpty())
    f.close()
  }

  @Test
  fun `the pending map is bounded — the eldest is evicted and its reply drops`() {
    val f = forwarder(maxPending = 2)
    val qa = query(0x1111, 0x4A)
    val qb = query(0x2222, 0x4B)
    val qc = query(0x3333, 0x4C)
    f.forward(qa)
    f.forward(qb)
    f.forward(qc)
    assertEquals(2, f.pendingCount())
    assertEquals(1L, stats.evicted.get())

    val sent = sock.sent.toList()
    // A's slot is gone — a reply to its upstream id counts as unknown now.
    sock.inbox += reply(txidOf(sent[0]), 0x4A)
    await { stats.droppedUnknown.get() == 1L }
    // B and C still resolve to their own queries.
    sock.inbox += reply(txidOf(sent[1]), 0x4B)
    sock.inbox += reply(txidOf(sent[2]), 0x4C)
    await { emitted.size == 2 }
    val outs = emitted.map { it.first }
    assertTrue(outs.contains(qb))
    assertTrue(outs.contains(qc))
    f.close()
  }

  @Test
  fun `a send failure frees the pending slot`() {
    sock.failSend = true
    val f = forwarder()
    f.forward(query(0x1111, 0x4A))
    assertEquals(0, f.pendingCount())
    f.close()
  }

  @Test
  fun `close releases the socket, drops waiters, and refuses new forwards`() {
    val f = forwarder()
    f.forward(query(0x1111, 0x4A))
    assertEquals(1, f.pendingCount())
    f.close()
    assertTrue(sock.isClosed)
    assertEquals(0, f.pendingCount())
    f.forward(query(0x2222, 0x4B))
    assertEquals(1, sock.sent.size) // only the pre-close query ever left
    f.close() // idempotent
  }
}

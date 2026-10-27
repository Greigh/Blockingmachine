package com.blockingmachine.localvpn.tcp

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * Socket-backed [SessionUpstream] — the service-side end of one captured (or
 * relayed) TCP flow. Client bytes are queued here and a per-flow WORKER
 * thread drains them onto a `protect()`ed socket; a second READER thread
 * pumps the socket back into the session.
 *
 * The non-blocking contract `TcpSession` requires, and how this class keeps it:
 *
 *  - Construction is cheap. The dial is deferred — `protect()` + `connect()`
 *    run on the worker thread (started at [attach], which the session calls
 *    from its own constructor), never on the tun reader.
 *  - [write]/[closeOut]/[abort] only ever enqueue or set a flag. `closeOut`
 *    is a queued sentinel so `shutdownOutput()` lands strictly after every
 *    previously-written byte.
 *  - The outbound queue is byte-bounded ([queueCapBytes]); an app producing
 *    faster than the socket drains RST-kills the flow rather than growing
 *    memory — `write` invokes `session.abortWithRst()` on overflow.
 *
 * Threads are daemon + session-scoped: [abort] closes the socket and
 * interrupts both, and the dispatcher tears every upstream down at close.
 * Pure `java.net` — JVM-testable; `protect` and the socket creation are
 * injected so Android's `VpnService.protect` stays behind the service seam.
 */
open class QueuedSocketUpstream(
  private val endpoint: InetSocketAddress,
  private val preamble: ByteArray?,
  private val protect: (Socket) -> Unit,
  private val socketFactory: () -> Socket,
  private val connectTimeoutMs: Int,
  private val queueCapBytes: Int = DEFAULT_QUEUE_CAP_BYTES,
) : SessionUpstream {

  companion object {
    const val DEFAULT_QUEUE_CAP_BYTES = 256 * 1024
    const val DEFAULT_CONNECT_TIMEOUT_MS = 10_000
    private val POISON = Any()
    private val CLOSE_OUT = Any()
  }

  @Volatile private var session: TcpSession? = null
  @Volatile private var socket: Socket? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var reader: Thread? = null

  /** Items are ByteArray (stream bytes) or the CLOSE_OUT/POISON sentinels. */
  private val queue = LinkedBlockingQueue<Any>()
  private val queuedBytes = AtomicLong(0)
  private val started = AtomicBoolean(false)
  private val aborted = AtomicBoolean(false)

  /** The session stores itself and arms the pump — the dial starts here. */
  override fun attach(session: TcpSession) {
    this.session = session
    if (started.compareAndSet(false, true)) {
      worker = thread(name = "bm-upstream-w", isDaemon = true) { workerLoop() }
    }
  }

  /**
   * In-order stream bytes — always returns immediately: the array is queued
   * for the worker, never written to the socket on this thread.
   */
  override fun write(bytes: ByteArray) {
    if (aborted.get() || bytes.isEmpty()) return
    if (queuedBytes.addAndGet(bytes.size.toLong()) > queueCapBytes) {
      // The socket can't keep up — kill the flow honestly instead of ballooning.
      session?.abortWithRst()
      return
    }
    queue.offer(bytes)
  }

  /** Client FIN — shutdown(OUT) lands on the socket after all queued bytes flush. */
  override fun closeOut() {
    if (!aborted.get()) queue.offer(CLOSE_OUT)
  }

  /** Abnormal teardown — close the socket and interrupt both threads. Idempotent. */
  override fun abort() {
    if (aborted.compareAndSet(false, true)) {
      queue.offer(POISON) // lands behind queued data; the interrupt is the real wake
      runCatching { socket?.close() }
      worker?.interrupt()
      reader?.interrupt()
    }
  }

  private fun workerLoop() {
    var sock: Socket? = null
    try {
      sock = socketFactory()
      protect(sock) // the dial must bypass the tun or every byte loops
      sock.connect(endpoint, connectTimeoutMs)
    } catch (e: Exception) {
      runCatching { sock?.close() }
      fail()
      return
    }
    socket = sock
    if (aborted.get()) {
      // abort() raced the dial and couldn't see the socket yet — close it here.
      runCatching { sock.close() }
      return
    }
    runCatching { sock.tcpNoDelay = true }
    reader = thread(name = "bm-upstream-r", isDaemon = true) { readerLoop(sock) }
    try {
      val out = sock.getOutputStream()
      // The PROXY-v2 header (hub upstreams) is the engine contract — it rides
      // ahead of every payload byte.
      preamble?.let { out.write(it) }
      while (true) {
        when (val item = queue.take()) {
          is ByteArray -> {
            queuedBytes.addAndGet(-item.size.toLong())
            out.write(item)
            out.flush()
          }
          CLOSE_OUT -> {
            out.flush()
            runCatching { sock.shutdownOutput() }
          }
          POISON -> return
          else -> {}
        }
      }
    } catch (e: Exception) {
      fail()
    }
  }

  private fun readerLoop(sock: Socket) {
    val buf = ByteArray(16 * 1024)
    try {
      val input = sock.getInputStream()
      while (true) {
        val n = input.read(buf)
        if (n < 0) {
          session?.onUpstreamEof()
          return
        }
        if (n > 0) session?.onUpstreamData(buf.copyOf(n))
      }
    } catch (e: Exception) {
      if (!aborted.get()) fail()
    }
  }

  /** One-shot failure path — whichever thread notices first reports the error. */
  private fun fail() {
    if (aborted.compareAndSet(false, true)) {
      runCatching { socket?.close() }
      reader?.interrupt()
      worker?.interrupt() // self-interrupt is harmless
      session?.onUpstreamError()
    }
  }
}

/**
 * Hub capture upstream: dial `<hub>:9294` and emit the PROXY-v2 header before
 * the first stream byte — the engine contract that carries the app's real
 * 5-tuple (src = the on-device app, dst = the original packet destination).
 * [InetSocketAddress.createUnresolved] keeps any name resolution off the tun
 * reader entirely; the worker resolves at connect time.
 */
class HubUpstream(
  key: FlowKey,
  hubHost: String,
  hubPort: Int,
  protect: (Socket) -> Unit,
  socketFactory: () -> Socket = { Socket() },
  connectTimeoutMs: Int = QueuedSocketUpstream.DEFAULT_CONNECT_TIMEOUT_MS,
) : QueuedSocketUpstream(
  endpoint = InetSocketAddress.createUnresolved(hubHost, hubPort),
  preamble = ProxyV2.encode(key.srcAddr, key.srcPort, key.dstAddr, key.dstPort),
  protect = protect,
  socketFactory = socketFactory,
  connectTimeoutMs = connectTimeoutMs,
)

/**
 * Pass-through upstream for TCP ports we don't capture: a `protect()`ed dial
 * straight at the original destination, no header — the app can't tell the
 * detour happened (beyond a few µs of userspace relay). `getByAddress` on the
 * packet's raw dst never touches DNS.
 */
class DirectUpstream(
  key: FlowKey,
  protect: (Socket) -> Unit,
  socketFactory: () -> Socket = { Socket() },
  connectTimeoutMs: Int = QueuedSocketUpstream.DEFAULT_CONNECT_TIMEOUT_MS,
) : QueuedSocketUpstream(
  endpoint = InetSocketAddress(InetAddress.getByAddress(key.dstAddr), key.dstPort),
  preamble = null,
  protect = protect,
  socketFactory = socketFactory,
  connectTimeoutMs = connectTimeoutMs,
)

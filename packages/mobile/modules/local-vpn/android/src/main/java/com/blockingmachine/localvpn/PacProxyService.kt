package com.blockingmachine.localvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * "Automatic proxying": a local HTTP server on 0.0.0.0 that serves a proxy.pac
 * (for devices configured to auto-detect/auto-configure) and answers CONNECT +
 * absolute-URI requests as a real forward proxy. HTTPS goes through CONNECT —
 * the proxy sees only the destination domain, which is exactly what the
 * blocklist needs; no TLS MITM, no CA install, nothing pinned breaks.
 *
 * Blocked domains get a 403; everything else relays byte-for-byte.
 */
class PacProxyService : Service() {

  companion object {
    const val ACTION_START = "com.blockingmachine.localvpn.PROXY_START"
    const val ACTION_STOP = "com.blockingmachine.localvpn.PROXY_STOP"
    const val EXTRA_PORT = "port"
    const val EXTRA_RULES_PATH = "rulesPath"
    const val DEFAULT_PORT = 8890
    private const val CHANNEL_ID = "blockingmachine_proxy"
    private const val NOTIF_ID = 43
    private const val TAG = "BmProxy"

    val running = AtomicBoolean(false)
    val allowedCount = AtomicLong(0)
    val blockedCount = AtomicLong(0)
    var boundPort: Int = 0
      private set
  }

  private val scope = CoroutineScope(Dispatchers.IO + Job())
  private var server: ServerSocket? = null
  private var listener: Job? = null
  private var blocklist = Blocklist.EMPTY
  private var lanAddress = "127.0.0.1"

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { shutdown(); return START_NOT_STICKY }
      ACTION_START -> {
        val port = intent.getIntExtra(EXTRA_PORT, DEFAULT_PORT)
        blocklist = intent.getStringExtra(EXTRA_RULES_PATH)
          ?.let { runCatching { Blocklist.load(it) }.getOrNull() }
          ?: Blocklist.EMPTY
        lanAddress = lanIpv4() ?: "127.0.0.1"
        runServer(port) // binds first so the notification shows the real port
        return START_STICKY
      }
    }
    return START_NOT_STICKY
  }

  private fun runServer(port: Int) {
    try {
      server = ServerSocket(port)
      boundPort = port
      running.set(true)
      startForegroundCompat()
    } catch (e: Exception) {
      Log.e(TAG, "bind :$port failed — ${e.message}")
      shutdown()
      return
    }
    listener = scope.launch {
      while (isActive) {
        val sock = try {
          server?.accept()
        } catch (e: Exception) { null } ?: break
        launch { handle(sock) }
      }
    }
  }

  private fun handle(client: Socket) {
    client.use { c ->
      c.soTimeout = 30_000
      val reader = BufferedReader(InputStreamReader(c.getInputStream()))
      val requestLine = reader.readLine() ?: return
      val parts = requestLine.split(" ")
      if (parts.size < 2) return

      // Drain headers — we only need Host for plain HTTP.
      var host = ""
      val headers = mutableListOf<String>()
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        headers += line
        if (line.lowercase().startsWith("host:")) {
          host = line.substringAfter(':').trim().substringBefore(':')
        }
      }

      if (parts[0] == "GET" && parts[1] == "/proxy.pac") {
        servePac(c.getOutputStream())
        return
      }

      if (parts[0] == "CONNECT") {
        // host:port form
        val target = parts[1]
        val hostPart = target.substringBefore(':')
        val port = target.substringAfter(':', "443").toIntOrNull() ?: 443
        connectRelay(c, reader, hostPart, port)
      } else {
        // Absolute-URI plain HTTP — proxy the request line + headers.
        val url = parts[1]
        val hostPart = url.removePrefix("http://").substringBefore('/').substringBefore(':')
        val port = if (url.removePrefix("http://").substringBefore('/').contains(':')) {
          url.removePrefix("http://").substringBefore('/').substringAfter(':').toIntOrNull() ?: 80
        } else 80
        httpRelay(c, requestLine, url, headers, hostPart, port)
      }
    }
  }

  private fun connectRelay(client: Socket, reader: BufferedReader, host: String, port: Int) {
    val out = client.getOutputStream()
    if (blocklist.isBlocked(host)) {
      blockedCount.incrementAndGet()
      out.write("HTTP/1.1 403 Blocked\r\nContent-Length: 0\r\n\r\n".toByteArray())
      out.flush()
      return
    }
    allowedCount.incrementAndGet()
    val upstream = runCatching { Socket(host, port) }.getOrNull() ?: run {
      out.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".toByteArray())
      out.flush()
      return
    }
    out.write("HTTP/1.1 200 Connection established\r\n\r\n".toByteArray())
    out.flush()
    relay(client, upstream)
  }

  private fun httpRelay(
    client: Socket,
    requestLine: String,
    url: String,
    headers: List<String>,
    host: String,
    port: Int,
  ) {
    val out = client.getOutputStream()
    if (blocklist.isBlocked(host)) {
      blockedCount.incrementAndGet()
      out.write("HTTP/1.1 403 Blocked\r\nContent-Length: 0\r\n\r\n".toByteArray())
      out.flush()
      return
    }
    allowedCount.incrementAndGet()
    val upstream = runCatching { Socket(host, port) }.getOrNull() ?: run {
      out.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".toByteArray())
      out.flush()
      return
    }
    // Rewrite absolute URI → origin form, forward headers verbatim.
    // substringAfter('/') alone drops the leading slash (upstream 400s), so take
    // everything from the first '/' or '?' after the authority, defaulting to "/".
    val path = url.removePrefix("http://")
      .dropWhile { it != '/' && it != '?' }
      .ifEmpty { "/" }
    val method = requestLine.substringBefore(' ')
    val up = upstream.getOutputStream()
    up.write("$method $path HTTP/1.1\r\n".toByteArray())
    for (h in headers) up.write("$h\r\n".toByteArray())
    up.write("\r\n".toByteArray())
    up.flush()
    relay(client, upstream)
  }

  /** Bidirectional byte pump; returns when either side closes. */
  private fun relay(a: Socket, b: Socket) {
    val t = Thread {
      try {
        b.getInputStream().copyTo(a.getOutputStream())
      } catch (_: Exception) { }
      runCatching { a.shutdownOutput() }
    }.apply { isDaemon = true; start() }
    try {
      a.getInputStream().copyTo(b.getOutputStream())
    } catch (_: Exception) { }
    runCatching { b.shutdownOutput() }
    t.join(30_000)
    runCatching { b.close() }
  }

  private fun servePac(out: OutputStream) {
    val pac = """
      function FindProxyForURL(url, host) {
        // All traffic to the phone's proxy — it enforces the blocklist.
        return "PROXY $lanAddress:$boundPort; DIRECT";
      }
    """.trimIndent() + "\n"
    out.write(
      ("HTTP/1.1 200 OK\r\n" +
        "Content-Type: application/x-ns-proxy-autoconfig\r\n" +
        "Content-Length: ${pac.toByteArray().size}\r\n\r\n" + pac).toByteArray(),
    )
    out.flush()
  }

  private fun lanIpv4(): String? = NetworkInterface.getNetworkInterfaces()
    ?.toList()
    ?.flatMap { it.inetAddresses.toList() }
    ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
    ?.hostAddress

  private fun startForegroundCompat() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Blockingmachine proxy", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val notif = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Blockingmachine proxy running")
      .setContentText("PAC: http://$lanAddress:$boundPort/proxy.pac")
      .setSmallIcon(android.R.drawable.ic_menu_share)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun shutdown() {
    running.set(false)
    boundPort = 0
    listener?.cancel()
    server?.close()
    server = null
    stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }
}

/**
 * Upstream relay for terminated flows (design spec §5.3, plan Task 5).
 *
 * Each request that survives evaluation is dialed to the flow's upstream over
 * a fresh `tls.connect` — `rejectUnauthorized: true` always, full chain
 * verification against `tls.rootCertificates` (plus optional deployment CAs),
 * ALPN offering `h2` then `http/1.1`. The negotiated protocol picks the
 * client implementation: `h2` → `http2.connect` on the same socket,
 * anything else → `http.request` on it. Request and response bodies stream —
 * nothing buffers unboundedly on the proxy itself.
 *
 * Upstream failure is fail-closed (spec §7): a refused/broken/unverifiable
 * upstream answers the client `502` and destroys the socket — never a silent
 * blind-tunnel fallback, which would smuggle an uninspected flow past the
 * verdict that already ran.
 *
 * Every remote-controlled construct (`http.request`, `http2.connect`,
 * `session.request`, `res.begin`) sits behind try/catch — an upstream `101`,
 * a control-character `:path`, or a malformed `:authority` must degrade to
 * `502`+close, never an uncaughtException that kills the engine and every
 * in-flight flow with it. Objects that can emit 'error' independently
 * (`upRes`, the downstream `res`) get explicit listeners for the same reason.
 *
 * The plain-HTTP helpers at the bottom serve the data listener's
 * absolute-form path (Review Focus #3): bytes that classify as an HTTP
 * request rather than CONNECT/PROXY-v2/TLS get their request head parsed,
 * evaluated once, then forwarded verbatim to the resolved host.
 *
 * Task 6 wiring: the verdict seam lives one level up, in the proxy's
 * per-request handler — `evaluator.evaluate(url)` → blocked ⇒ `respond(403)`,
 * else ⇒ `applyRequestTransforms` on `req.url`/`req.headers`, then
 * `relayRequest`. This file only ever sees the already-transformed request.
 */

import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import http2 from 'node:http2';
import tls from 'node:tls';
import type { RelayResponse, TerminatedRequest } from './terminate.js';

/** Where a terminated flow's requests are dialed. */
export interface UpstreamEndpoint {
  /** Dial address — CONNECT host or PROXY-v2 destination, not the SNI. */
  host: string;
  port: number;
  /** TLS SNI the upstream verifies against — the client's announced name. */
  servername: string;
}

export interface RelayOptions {
  /**
   * Extra PEM roots merged over `tls.rootCertificates` for upstream
   * verification — deployment/test hook, never a verification bypass:
   * `rejectUnauthorized` stays `true` either way. Semantics to know: passing
   * `ca` replaces Node's *whole* default trust list — including whatever
   * `NODE_EXTRA_CA_CERTS` contributed at process start — so a deployment
   * relying on env-provided roots must fold them into this list.
   */
  upstreamCaCerts?: string[];
  /** Upstream dial deadline override (default 15s) — test/deploy knob. */
  connectTimeoutMs?: number;
  /**
   * Upstream first-byte deadline override (default 30s) — bound on the wait
   * for the 'response' event after request dispatch, NOT on body streaming.
   */
  responseTimeoutMs?: number;
}

/** Upstream dial deadline — a blackholed target must not park fds. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
/**
 * Upstream first-byte deadline — an upstream that handshakes then never
 * answers must not park the request (and the downstream client) until the
 * client gives up. Cleared the instant 'response' fires; a long-running
 * body streams unbounded below it.
 */
const UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * RFC 7230 hop-by-hop fields — never forwarded in either direction.
 * `http2-settings` joins the fixed set: it is only legal inside an h2c
 * Upgrade handshake, and a hostile/forged one reaching the h2 compat
 * `writeHead` throws — the crash class this file's try/catch guards.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'http2-settings',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Response-only strips: `alt-svc` advertises an h3/QUIC escape the capture
 * layer cannot see (spec §2 — UDP 443 suppression is a P1 concern), so a
 * relayed response must not offer it.
 */
const RESPONSE_ONLY_STRIP = new Set(['alt-svc']);

/**
 * RFC 7230 §6.1: the `Connection` header *names* the hop-by-hop fields.
 * Names it lists are stripped alongside the fixed set — a proxy must not
 * forward "connection-marked" extensions it doesn't understand.
 */
function connectionListedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const listed = new Set<string>();
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  for (const value of values) {
    for (const name of value.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed !== '') {
        listed.add(trimmed);
      }
    }
  }
  return listed;
}

function failClosed(res: RelayResponse, destroy: () => void): void {
  if (!res.headersSent) {
    res.respond(502, { 'content-length': '0' });
  } else {
    res.destroy();
  }
  destroy();
}

/** The absolute URL a verdict runs on — preserves absolute-form targets. */
export function absoluteRequestUrl(
  req: { url: string; host: string },
  scheme: 'http' | 'https',
): string {
  if (/^https?:\/\//i.test(req.url)) {
    return req.url;
  }
  return `${scheme}://${req.host}${req.url}`;
}

/**
 * h1 `path`/h2 `:path` for the upstream wire: absolute-form targets are
 * normalized to origin-form, everything else passes through verbatim
 * (including `OPTIONS *`).
 */
function originFormPath(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  return url;
}

/**
 * The authority the verdict actually judged — the absolute-form target's
 * authority when present, else the Host/`:authority` header (origin-form is
 * self-consistent). Forwarded `Host`/`:authority` is rewritten to this so a
 * mismatched client header can't smuggle an unjudged name to a shared edge
 * (RFC 7230 §5.4).
 */
function requestAuthority(req: TerminatedRequest): string {
  if (/^https?:\/\//i.test(req.url)) {
    try {
      const parsed = new URL(req.url);
      if (parsed.host !== '') {
        return parsed.host;
      }
    } catch {
      // fall through to the header authority
    }
  }
  return req.host;
}

/**
 * Request headers for the upstream dial: pseudo-headers (`:authority` etc.),
 * hop-by-hop fields, and `Connection`-listed names removed. The forwarded
 * authority is rewritten to the evaluated one — see {@link requestAuthority}.
 */
function requestHeaders(req: TerminatedRequest, upstreamH2: boolean): OutgoingHttpHeaders {
  const connectionListed = connectionListedHeaders(req.headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith(':') ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionListed.has(lower) ||
      lower === 'host' // authority rewritten below — never copied verbatim
    ) {
      continue;
    }
    out[name] = value as string | string[];
  }
  const authority = requestAuthority(req);
  if (upstreamH2) {
    out[':method'] = req.method;
    out[':path'] = originFormPath(req.url);
    out[':scheme'] = 'https';
    if (authority !== '') {
      out[':authority'] = authority;
    }
  } else if (authority !== '') {
    out['host'] = authority;
  }
  return out;
}

/**
 * Response headers for the downstream side: pseudo-headers, hop-by-hop
 * fields, `Connection`-listed names, and response-only strips (`alt-svc`).
 */
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionListed = connectionListedHeaders(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith(':') ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      RESPONSE_ONLY_STRIP.has(lower) ||
      connectionListed.has(lower)
    ) {
      continue;
    }
    out[name] = value as string | string[];
  }
  return out;
}

/** h1 upstream: `http.request` rides the pre-connected socket (no `agent` key —
 * that is the only spot where Node honors `createConnection`). */
function relayOverH1(
  req: TerminatedRequest,
  res: RelayResponse,
  sock: tls.TLSSocket,
  responseTimeoutMs: number,
): void {
  let upstream: http.ClientRequest;
  try {
    // `path` with a control character throws ERR_UNESCAPED_CHARACTERS — a
    // hostile client header must degrade to 502, not an uncaughtException.
    upstream = http.request({
      method: req.method,
      path: originFormPath(req.url),
      headers: requestHeaders(req, false),
      createConnection: () => sock,
    });
  } catch {
    failClosed(res, () => sock.destroy());
    return;
  }
  // First-byte deadline (flag 99): armed at request dispatch, cleared the
  // moment 'response' fires — a handshook-but-silent upstream answers 502 +
  // destroy inside the bound instead of parking until the client gives up.
  const responseDeadline = setTimeout(
    () => failClosed(res, () => sock.destroy()),
    responseTimeoutMs,
  );
  responseDeadline.unref();
  upstream.once('response', (upRes) => {
    clearTimeout(responseDeadline);
    let target;
    try {
      // A status the downstream protocol can't express (101 on h2) or an
      // upstream header the compat layer rejects throws synchronously here.
      target = res.begin(upRes.statusCode ?? 502, responseHeaders(upRes.headers));
    } catch {
      upRes.destroy();
      failClosed(res, () => sock.destroy());
      return;
    }
    upRes.once('error', () => {
      res.destroy();
      sock.destroy();
    });
    upRes.once('aborted', () => res.destroy());
    upRes.pipe(target);
  });
  // Forwarded headers strip Upgrade/Connection, so a 101 should surface as
  // 'response' — but a protocol-correct client can't rely on hostile bytes:
  // anything routed here is still an uninspectable switch → fail closed.
  upstream.once('upgrade', () => {
    clearTimeout(responseDeadline);
    failClosed(res, () => sock.destroy());
  });
  upstream.once('error', () => {
    clearTimeout(responseDeadline);
    failClosed(res, () => sock.destroy());
  });
  req.body.pipe(upstream);
}

/** h2 upstream: `http2.connect` adopts the pre-connected socket; one request
 * per session — the session closes with its stream. */
function relayOverH2(
  req: TerminatedRequest,
  res: RelayResponse,
  sock: tls.TLSSocket,
  responseTimeoutMs: number,
): void {
  let session: http2.ClientHttp2Session;
  try {
    // A malformed evaluated authority throws ERR_INVALID_URL here. The
    // session authority is the same name the verdict judged — the stream's
    // :authority is set to it in requestHeaders() too.
    session = http2.connect(`https://${requestAuthority(req) || req.host || 'upstream'}`, {
      createConnection: () => sock,
    });
  } catch {
    failClosed(res, () => sock.destroy());
    return;
  }
  const kill = () => {
    session.close();
    sock.destroy();
  };
  session.once('error', () => failClosed(res, kill));
  let stream: http2.ClientHttp2Stream;
  try {
    // session.request validates header names/values — hostile bytes throw.
    stream = session.request(requestHeaders(req, true) as http2.OutgoingHttpHeaders);
  } catch {
    failClosed(res, kill);
    return;
  }
  // First-byte deadline (flag 99) — same posture as the h1 path: armed at
  // stream dispatch, cleared at 'response' or on any teardown that already
  // resolved the request. Body streaming is unaffected below it.
  const responseDeadline = setTimeout(() => failClosed(res, kill), responseTimeoutMs);
  responseDeadline.unref();
  let responded = false;
  stream.once('response', (headers) => {
    clearTimeout(responseDeadline);
    responded = true;
    let target;
    try {
      target = res.begin(
        Number((headers as IncomingHttpHeaders)[':status'] ?? 502),
        responseHeaders(headers as IncomingHttpHeaders),
      );
    } catch {
      failClosed(res, kill);
      return;
    }
    stream.pipe(target);
  });
  stream.once('error', () => {
    clearTimeout(responseDeadline);
    failClosed(res, kill);
  });
  stream.once('aborted', () => {
    clearTimeout(responseDeadline);
    failClosed(res, kill);
  });
  stream.once('close', () => {
    clearTimeout(responseDeadline);
    session.close();
    // A stream that dies without ever producing a response (graceful GOAWAY,
    // reset) still owes the client an honest failure — not a hang.
    if (!responded) {
      failClosed(res, () => sock.destroy());
    }
  });
  req.body.pipe(stream);
}

/**
 * Dial the upstream and stream `req`/`res` across. Per-request connection —
 * a keep-alive client connection may carry different Hosts, and pooling by
 * destination is Task 6+ bookkeeping, not P0 correctness.
 */
export function relayRequest(
  req: TerminatedRequest,
  res: RelayResponse,
  upstream: UpstreamEndpoint,
  options?: RelayOptions,
): void {
  const ca =
    options !== undefined && options.upstreamCaCerts !== undefined && options.upstreamCaCerts.length > 0
      ? [...tls.rootCertificates, ...options.upstreamCaCerts]
      : undefined;
  const sock = tls.connect({
    host: upstream.host,
    port: upstream.port,
    servername: upstream.servername,
    rejectUnauthorized: true, // mandatory — no bypass flag exists (spec §5.3)
    ALPNProtocols: ['h2', 'http/1.1'],
    ...(ca !== undefined ? { ca } : {}),
  });
  const connectTimeout = options?.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  const responseTimeout = options?.responseTimeoutMs ?? UPSTREAM_RESPONSE_TIMEOUT_MS;
  // A blackholed dial owes the client a 502, not a silent destroy — the
  // downstream request must never park until some distant default timeout.
  sock.setTimeout(connectTimeout, () => failClosed(res, () => sock.destroy()));
  sock.once('error', () => failClosed(res, () => sock.destroy()));
  req.body.once('error', () => sock.destroy());
  // Downstream death kills the upstream dial — no orphaned connections.
  res.onClose(() => sock.destroy());
  sock.once('secureConnect', () => {
    sock.setTimeout(0);
    try {
      if (sock.alpnProtocol === 'h2') {
        relayOverH2(req, res, sock, responseTimeout);
      } else {
        // false (no ALPN) and 'http/1.1' both mean the h1 path.
        relayOverH1(req, res, sock, responseTimeout);
      }
    } catch {
      failClosed(res, () => sock.destroy());
    }
  });
}

/* ------------------------------------------------------------------ */
/* Plain-HTTP absolute-form path (Review Focus #3).                    */
/* ------------------------------------------------------------------ */

export type HttpProbe = 'no' | 'possible' | 'yes';

const HTTP_METHOD_TOKEN = /^[A-Z][A-Z0-9_-]{0,15}$/;

/**
 * First-bytes probe for the dispatch 'reject' branch: could this buffer be an
 * HTTP request line? 'possible' while it is still a prefix of `METHOD SP`;
 * 'yes' once a method token and a plausible target opener (`/`, `*`, or the
 * `http://` scheme prefix) have arrived; 'no' for anything else — garbage
 * must still close promptly, so a space followed by a non-URL token answers
 * 'no' immediately.
 */
export function probePlainHttp(buf: Buffer): HttpProbe {
  const text = buf.toString('latin1');
  const space = text.indexOf(' ');
  if (space < 0) {
    return HTTP_METHOD_TOKEN.test(text) ? 'possible' : 'no';
  }
  if (!HTTP_METHOD_TOKEN.test(text.slice(0, space))) {
    return 'no';
  }
  const rest = text.slice(space + 1);
  if (rest.length === 0) {
    return 'yes';
  }
  const lower = rest.toLowerCase();
  if (lower.startsWith('http://') || 'http://'.startsWith(lower)) {
    return 'yes';
  }
  return rest.startsWith('/') || rest === '*' ? 'yes' : 'no';
}

export interface PlainHttpTarget {
  method: string;
  /** Absolute `http://` URL the verdict runs on. */
  url: string;
  /** Resolved dial target. */
  host: string;
  port: number;
  /** The raw `Host` header value when present — the second authority. */
  hostHeader: string | null;
  /**
   * An absolute-form request line and a `Host` header that disagree on
   * authority (RFC 7230 §5.4). Forwarding the pair would let
   * `GET http://allowed/x` + `Host: blocked` evade the verdict on the Host
   * name — callers evaluate both and reject.
   */
  authorityMismatch: boolean;
}

/** `host:port` / `[v6]:port` / bare host → `{host, port}` with `defPort`. */
export function splitHostPort(
  authority: string,
  defPort: number,
): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) {
      return null;
    }
    const portText = trimmed.slice(close + 1);
    if (portText === '') {
      return { host: trimmed.slice(1, close), port: defPort };
    }
    if (portText[0] !== ':' || !/^\d{1,5}$/.test(portText.slice(1))) {
      return null;
    }
    return { host: trimmed.slice(1, close), port: Number(portText.slice(1)) };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) {
    return { host: trimmed, port: defPort };
  }
  const portText = trimmed.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) {
    return null;
  }
  return { host: trimmed.slice(0, colon), port: Number(portText) };
}

/** First `Host:` header value in a latin1 head block, or null when absent. */
function hostHeaderValue(head: string, lineEnd: number): string | null {
  for (const line of head.slice(lineEnd + 2).split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep > 0 && line.slice(0, sep).trim().toLowerCase() === 'host') {
      return line.slice(sep + 1).trim();
    }
  }
  return null;
}

/**
 * Parse a complete request head (up to CRLFCRLF) into a forwardable target.
 * Absolute-form `http://h[:port]/x` takes its host from the request line and
 * must agree with the `Host` header when one is present (`authorityMismatch`);
 * origin-form/asterisk targets take it from `Host` outright. Port defaults
 * to 80. Returns null for anything that isn't a routable plain-HTTP request
 * (https absolute-form included — that is a CONNECT's job).
 */
export function parsePlainHttpTarget(buf: Buffer): PlainHttpTarget | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  const head = buf.subarray(0, headEnd < 0 ? buf.length : headEnd).toString('latin1');
  const lineEnd = head.indexOf('\r\n');
  const requestLine = lineEnd < 0 ? head : head.slice(0, lineEnd);
  const match = /^([A-Z][A-Z0-9_-]{0,15})\s+(\S+)\s+HTTP\/\d+(?:\.\d+)?$/.exec(requestLine);
  if (match === null) {
    return null;
  }
  const [, method, target] = match;
  const hostHeader = hostHeaderValue(head, lineEnd);

  if (/^http:\/\//i.test(target)) {
    try {
      const parsed = new URL(target);
      const port = parsed.port === '' ? 80 : Number(parsed.port);
      let authorityMismatch = false;
      if (hostHeader !== null) {
        const declared = splitHostPort(hostHeader, 80);
        authorityMismatch =
          declared === null ||
          declared.host.toLowerCase() !== parsed.hostname.toLowerCase() ||
          declared.port !== port;
      }
      return {
        method,
        url: target,
        host: parsed.hostname,
        port,
        hostHeader,
        authorityMismatch,
      };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return null; // a scheme this listener does not carry (https absolute-form)
  }

  // Origin-form / asterisk-form — the Host header is the authority.
  if (hostHeader === null) {
    return null;
  }
  const resolved = splitHostPort(hostHeader, 80);
  if (resolved === null) {
    return null;
  }
  return {
    method,
    url: `http://${hostHeader}${target}`,
    ...resolved,
    hostHeader,
    authorityMismatch: false,
  };
}

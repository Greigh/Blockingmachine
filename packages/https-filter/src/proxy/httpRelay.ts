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
 * The plain-HTTP helpers at the bottom serve the data listener's
 * absolute-form path (Review Focus #3): bytes that classify as an HTTP
 * request rather than CONNECT/PROXY-v2/TLS get their request head parsed,
 * evaluated once, then forwarded verbatim to the resolved host.
 *
 * Task 6 hooks: the verdict seam lives one level up, in the proxy's
 * per-request handler — `evaluator.evaluate(url)` → blocked ⇒ `respond(403)`,
 * else ⇒ `relayRequest` — so transforms slot in between those two calls
 * against `req.headers`/`req.url` untouched here.
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
   * `rejectUnauthorized` stays `true` either way.
   */
  upstreamCaCerts?: string[];
}

/** Upstream dial deadline — a blackholed target must not park fds. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** RFC 7230 hop-by-hop fields — never forwarded in either direction. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

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
 * Request headers for the upstream dial: pseudo-headers (`:authority` etc.)
 * and hop-by-hop fields removed; for an h2→h1 hop the `:authority` becomes a
 * `host` header so the origin sees the same name the client sent.
 */
function requestHeaders(req: TerminatedRequest, upstreamH2: boolean): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }
    out[name] = value as string | string[];
  }
  if (upstreamH2) {
    out[':method'] = req.method;
    out[':path'] = originFormPath(req.url);
    out[':scheme'] = 'https';
    if (req.host !== '') {
      out[':authority'] = req.host;
    }
  } else if (req.protocol === 'h2' && req.host !== '') {
    out['host'] = req.host;
  }
  return out;
}

/** Response headers for the downstream side: pseudo + hop-by-hop stripped. */
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }
    out[name] = value as string | string[];
  }
  return out;
}

/** h1 upstream: `http.request` rides the pre-connected socket (no `agent` key —
 * that is the only spot where Node honors `createConnection`). */
function relayOverH1(req: TerminatedRequest, res: RelayResponse, sock: tls.TLSSocket): void {
  const upstream = http.request({
    method: req.method,
    path: originFormPath(req.url),
    headers: requestHeaders(req, false),
    createConnection: () => sock,
  });
  upstream.once('response', (upRes) => {
    const target = res.begin(upRes.statusCode ?? 502, responseHeaders(upRes.headers));
    upRes.once('aborted', () => res.destroy());
    upRes.pipe(target);
  });
  upstream.once('error', () => failClosed(res, () => sock.destroy()));
  req.body.pipe(upstream);
}

/** h2 upstream: `http2.connect` adopts the pre-connected socket; one request
 * per session — the session closes with its stream. */
function relayOverH2(req: TerminatedRequest, res: RelayResponse, sock: tls.TLSSocket): void {
  const session = http2.connect(`https://${req.host || 'upstream'}`, {
    createConnection: () => sock,
  });
  const kill = () => {
    session.close();
    sock.destroy();
  };
  session.once('error', () => failClosed(res, kill));
  const stream = session.request(requestHeaders(req, true) as http2.OutgoingHttpHeaders);
  stream.once('response', (headers) => {
    const target = res.begin(
      Number((headers as IncomingHttpHeaders)[':status'] ?? 502),
      responseHeaders(headers as IncomingHttpHeaders),
    );
    stream.pipe(target);
  });
  stream.once('error', () => failClosed(res, kill));
  stream.once('aborted', () => failClosed(res, kill));
  stream.once('close', () => session.close());
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
  sock.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => sock.destroy());
  sock.once('error', () => failClosed(res, () => sock.destroy()));
  req.body.once('error', () => sock.destroy());
  sock.once('secureConnect', () => {
    sock.setTimeout(0);
    if (sock.alpnProtocol === 'h2') {
      relayOverH2(req, res, sock);
    } else {
      // false (no ALPN) and 'http/1.1' both mean the h1 path.
      relayOverH1(req, res, sock);
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
}

/** `host:port` / `[v6]:port` / bare host → `{host, port}` with `defPort`. */
function splitHostPort(authority: string, defPort: number): { host: string; port: number } | null {
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

/**
 * Parse a complete request head (up to CRLFCRLF) into a forwardable target.
 * Absolute-form `http://h[:port]/x` takes its host from the request line;
 * origin-form/asterisk targets take it from the `Host` header — port defaults
 * to 80 in both cases. Returns null for anything that isn't a routable
 * plain-HTTP request (https absolute-form included — that is a CONNECT's job).
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

  if (/^http:\/\//i.test(target)) {
    try {
      const parsed = new URL(target);
      return {
        method,
        url: target,
        host: parsed.hostname,
        port: parsed.port === '' ? 80 : Number(parsed.port),
      };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return null; // a scheme this listener does not carry (https absolute-form)
  }

  // Origin-form / asterisk-form — the Host header is the authority.
  let hostHeader: string | null = null;
  for (const line of head.slice(lineEnd + 2).split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep > 0 && line.slice(0, sep).trim().toLowerCase() === 'host') {
      hostHeader = line.slice(sep + 1).trim();
      break;
    }
  }
  if (hostHeader === null) {
    return null;
  }
  const resolved = splitHostPort(hostHeader, 80);
  if (resolved === null) {
    return null;
  }
  return { method, url: `http://${hostHeader}${target}`, ...resolved };
}

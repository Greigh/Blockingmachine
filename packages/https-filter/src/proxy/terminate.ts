/**
 * TLS termination — the MITM core (design spec §5.3, plan Task 5).
 *
 * An allowed flow reaches this module after the listener already peeked its
 * ClientHello and gated the SNI (`isValidSni` — `forgeLeaf` throws otherwise).
 * The peeked bytes are replayed with `socket.unshift(head)`, then the raw
 * socket is handed to a per-flow `http2.createSecureServer` via
 * `server.emit('connection', socket)`. The server's own TLS layer performs
 * the handshake — consuming the replayed ClientHello — against a
 * `SecureContext` minted from the forged leaf, with `SNICallback` resolving
 * the leaf cache for the announced name, and ALPN negotiating `h2` or
 * `http/1.1`. HTTP/1.1 requests surface on `'request'` as compat
 * `IncomingMessage`/`ServerResponse`; HTTP/2 requests surface on the same
 * event as `Http2ServerRequest`/`Http2ServerResponse` — one handler covers
 * both protocols (registering a raw `'stream'` listener as well would
 * double-dispatch every h2 request).
 *
 * Pin learning (spec §5.3/§7): the pinning signal is a client distrusting the
 * forged leaf — observed here as `tlsClientError` or the socket dying before
 * `secureConnection` ever fired (handshake never completed). A
 * `clientError`/`sessionError` before the first request means the completed
 * TLS session wasn't speaking HTTP — the spec's non-HTTP auto-demote, same
 * store. A *clean close after a completed handshake* is NOT a pinning signal —
 * browsers abandon speculative/preconnect sockets exactly that way, and
 * treating it as one also hands any local process a pin-anything evasion
 * (`CONNECT victim.example` → hello → close → pinned). Either real trigger
 * fires the `onHandshakeAbort` hook exactly once.
 */

import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import http2 from 'node:http2';
import type net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import { normalizeSni, type CertAuthority } from '../ca/certAuthority.js';

/**
 * One decrypted request. `url` is the request-target exactly as received —
 * origin-form (`/x`) for h1 and h2 `:path`, or absolute-form
 * (`https://h/x`) when an h1 client sends one; `host` is the `Host` header
 * (h1) or `:authority` (h2). `body` streams the request payload.
 */
export interface TerminatedRequest {
  method: string;
  url: string;
  host: string;
  headers: IncomingHttpHeaders;
  body: Readable;
  protocol: 'h1' | 'h2';
}

/**
 * The downstream response, uniform over h1 `ServerResponse` and h2 compat
 * `Http2ServerResponse`. `respond` writes a synthetic terminal response (the
 * verdict path); `begin` writes relayed headers and returns the writable the
 * upstream body pipes into. Headers given to `begin` must already be stripped
 * of hop-by-hop fields — h2 `writeHead` rejects `connection`, `keep-alive`,
 * `transfer-encoding`, etc.
 */
export interface RelayResponse {
  readonly protocol: 'h1' | 'h2';
  readonly headersSent: boolean;
  respond(status: number, headers?: OutgoingHttpHeaders, body?: string | Buffer): void;
  begin(status: number, headers: OutgoingHttpHeaders): Writable;
  destroy(): void;
  /** Register a downstream-death hook — the relay kills the upstream dial. */
  onClose(cb: () => void): void;
}

export type HttpHandler = (req: TerminatedRequest, res: RelayResponse) => void;

export interface TerminateContext {
  /** Peeked ClientHello bytes to replay into the socket before TLS. */
  head?: Buffer;
  /** Normalized, `isValidSni`-gated name the default leaf is forged for. */
  sni: string;
  /** Called once if the flow dies before its first request — the pinning signal. */
  onHandshakeAbort?: () => void;
}

class CompatRelayResponse implements RelayResponse {
  constructor(
    private readonly res: http.ServerResponse | http2.Http2ServerResponse,
    readonly protocol: 'h1' | 'h2',
  ) {
    // The response object surfaces socket-level failures as 'error' — an
    // unhandled one is an uncaughtException on the whole engine. Destruction
    // is the only sane answer and callers already own teardown.
    this.res.on('error', () => {});
  }

  get headersSent(): boolean {
    return this.res.headersSent;
  }

  /**
   * h2 field names must be lowercase — callers pass h1-style casing, so keys
   * are normalized per protocol before `writeHead` sees them.
   */
  private wireHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
    if (this.protocol === 'h1') {
      return headers;
    }
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      out[name.toLowerCase()] = value;
    }
    return out;
  }

  private writeHead(status: number, headers: OutgoingHttpHeaders): void {
    const wire = this.wireHeaders(headers);
    // The union's writeHead overloads are mutually incompatible — instanceof
    // narrows each side to its own signature.
    if (this.res instanceof http.ServerResponse) {
      this.res.writeHead(status, wire);
    } else {
      this.res.writeHead(status, wire);
    }
  }

  respond(status: number, headers: OutgoingHttpHeaders = {}, body?: string | Buffer): void {
    if (this.res.headersSent || this.res.destroyed) {
      return;
    }
    try {
      this.writeHead(status, headers);
      this.res.end(body ?? '');
    } catch {
      this.res.destroy();
    }
  }

  begin(status: number, headers: OutgoingHttpHeaders): Writable {
    this.writeHead(status, headers);
    return this.res;
  }

  destroy(): void {
    this.res.destroy();
  }

  onClose(cb: () => void): void {
    this.res.once('close', cb);
  }
}

/**
 * Terminate the client side of `socket` as an HTTP/1.1+HTTP/2 endpoint
 * serving forged-leaf TLS, dispatching each decrypted request to `onRequest`.
 * Resolves once the socket has been handed to the server — the flow's
 * lifecycle is self-contained from there (the caller's `track()` still owns
 * socket teardown).
 */
export function terminateToHttp(
  socket: net.Socket,
  authority: CertAuthority,
  onRequest: HttpHandler,
  ctx: TerminateContext,
): Promise<void> {
  const leaf = authority.forgeLeaf(ctx.sni);
  const defaultContext = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem });

  // Per-flow secure server: its own TLSSocket wrap is what actually performs
  // the handshake, so the forged leaf goes in through server options.
  // SNICallback covers a wire SNI that disagrees with the peeked name —
  // same-name hits the forged default context, other valid names forge on
  // demand (LRU-cached), invalid names fail the handshake honestly. The wire
  // name is normalized first: a trailing-dot SNI (`name.`) must still match
  // `ctx.sni` — otherwise a perfectly pinnable-looking handshake failure is
  // manufactured out of a normalization miss, learning a false pin.
  const server = http2.createSecureServer({
    allowHTTP1: true,
    secureContext: defaultContext,
    ALPNProtocols: ['h2', 'http/1.1'],
    SNICallback: (servername, cb) => {
      const normalized = normalizeSni(servername);
      if (normalized === ctx.sni) {
        cb(null, defaultContext);
        return;
      }
      try {
        const alt = authority.forgeLeaf(normalized);
        cb(null, tls.createSecureContext({ key: alt.keyPem, cert: alt.certPem }));
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  let sawRequest = false;
  let secure = false;
  let aborted = false;
  const abort = () => {
    if (!aborted) {
      aborted = true;
      ctx.onHandshakeAbort?.();
    }
  };
  server.on('secureConnection', () => {
    secure = true;
  });
  // The pinning signal: the forged handshake is rejected (tlsClientError —
  // the client's cert alert) or the socket dies before secureConnection ever
  // fired — 'end' counts too: a FIN'd client can never finish the handshake.
  // A close *after* a completed handshake is abandonment, not pinning.
  server.on('tlsClientError', abort);
  socket.once('error', () => {
    if (!secure) {
      abort();
    }
  });
  socket.once('close', () => {
    if (!secure) {
      abort();
    }
  });
  socket.once('end', () => {
    if (!secure) {
      abort();
    }
  });
  // The peek resolves inside a 'data' handler — a fast client can FIN/reset
  // the socket before these listeners attach. Catch the already-happened
  // close so the pinning signal is never lost to a registration race.
  if (!secure && (socket.destroyed || socket.readableEnded)) {
    abort();
  }

  // compat parse failure / h2 session error ends the flow honestly — and if
  // no request was ever served, the completed session wasn't speaking HTTP:
  // spec §5.3's non-HTTP-TLS auto-demote lands in the same pin store.
  server.on('clientError', (_err, sock) => {
    if (!sawRequest) {
      abort();
    }
    sock.destroy();
  });
  server.on('sessionError', () => {
    if (!sawRequest) {
      abort();
    }
    socket.destroy();
  });

  server.on(
    'request',
    (
      req: http.IncomingMessage | http2.Http2ServerRequest,
      res: http.ServerResponse | http2.Http2ServerResponse,
    ) => {
      sawRequest = true;
      const protocol = req instanceof http.IncomingMessage ? 'h1' : 'h2';
      const headers = req.headers as IncomingHttpHeaders;
      const authorityHeader = headers[':authority'];
      const host =
        typeof authorityHeader === 'string'
          ? authorityHeader
          : typeof headers.host === 'string'
            ? headers.host
            : '';
      try {
        onRequest(
          {
            method: req.method ?? 'GET',
            url: req.url ?? '/',
            host,
            headers,
            body: req,
            protocol,
          },
          new CompatRelayResponse(res, protocol),
        );
      } catch {
        res.destroy();
        socket.destroy();
      }
    },
  );

  // Replay the bytes the ClientHello peek consumed — the server-side TLS
  // layer reads them as the start of its handshake. Then hand the raw socket
  // over; the server wraps, handshakes, ALPN-dispatches, and serves.
  if (ctx.head !== undefined && ctx.head.length > 0) {
    socket.unshift(ctx.head);
  }
  socket.once('close', () => {
    // Never-listened: close() callbacks an error — swallow it; the sockets
    // this server served are already dead or dying with `socket`.
    server.close(() => {});
  });
  server.emit('connection', socket);
  return Promise.resolve();
}

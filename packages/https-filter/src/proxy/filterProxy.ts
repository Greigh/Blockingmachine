/**
 * Loopback data listener — first-bytes dispatch on `bindHost:dataPort`
 * (design spec §5.2, plan Task 4).
 *
 * One `net.Server` serves three flow shapes, told apart by their opening
 * bytes:
 *
 *  - **PROXY-v2 magic** (`\r\n\r\n\x00\r\nQUIT\n`) — a helper-spliced
 *    transparent flow; the binary frame carries the original destination.
 *  - **ASCII `CONNECT `** — an explicit forward-proxy handshake, the P0
 *    no-privileges path (and the future LAN-hub mode).
 *  - **`0x16 0x03`** — first bytes of a TLS record: a helper-spliced flow
 *    without a PROXY header. Not expected; the ClientHello is still peeked
 *    for consistency, but with no destination header the flow has nowhere to
 *    tunnel — it is closed honestly until Task 5 can terminate it.
 *  - anything else — plain-HTTP absolute-form forwarding lands here in
 *    Task 5; for now the flow closes, counted, never hung.
 *
 * Flow semantics per path:
 *
 *  - CONNECT: literal-IP targets always blind-tunnel (no SNI will ever
 *    arrive — spec §5.2); named targets take a synthetic verdict on
 *    `https://<host>/` — `blocked` answers `403` + `X-Blockingmachine-Rule`,
 *    allowed/exception answers `200`. Pinned/bypassed targets then splice
 *    blind; the rest take a bounded ClientHello peek — non-TLS bytes or
 *    silence close cleanly (never a hung socket), real TLS reaches the
 *    Task-5 termination seam, which today is a blind tunnel.
 *  - PROXY-v2: the same peek decides — non-TLS, missing/invalid SNI, and
 *    pinned/bypassed SNI all blind-tunnel to the header's destination; a
 *    blocked SNI drops the flow silently (no response exists on raw TLS);
 *    allowed reaches the same seam.
 *
 * `reload(rawRules)` rebuilds the evaluator off the hot path and swaps the
 * reference — `RequestEvaluator` is immutable, so in-flight flows finish on
 * the ruleset they started with. `close()` stops accepting and destroys
 * every tracked socket (client and upstream alike).
 *
 * `authority` is a constructor arg for the Task-5 termination seam — no
 * leaf is forged on this task.
 */

import net, { isIP } from 'node:net';
import {
  createRequestEvaluator,
  type RequestEvaluator,
} from '@blockingmachine/core';
import type { CertAuthority } from '../ca/certAuthority.js';
import type { PolicyStore } from '../policy/policyStore.js';
import {
  matchProxyV2Signature,
  parseProxyV2,
  proxyV2FrameLength,
} from './proxyProtocol.js';
import { collectClientHello } from './sniPeek.js';

export interface ProxyStats {
  flowsTotal: number;
  flowsBlocked: number;
  flowsTunneled: number;
  flowsTerminated: number;
  pinsLearned: number;
}

export interface RunningProxy {
  readonly port: number;
  close(): Promise<void>;
  stats(): ProxyStats;
  reload(rawRules: string[]): void;
}

export interface StartProxyOptions {
  bindHost: string;
  dataPort: number;
  /** Consumed by Task 5's termination seam — accepted now so the shape is stable. */
  authority: CertAuthority;
  evaluator: RequestEvaluator;
  policy: PolicyStore;
}

/** Bound on first-bytes dispatch — a connection that never speaks is reaped. */
const DISPATCH_TIMEOUT_MS = 10_000;
/** Bound on the ClientHello peek, spec'd at 10s. */
const PEEK_TIMEOUT_MS = 10_000;
/** Upstream dial deadline for blind tunnels — a blackholed target must not park fds. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
/** CONNECT header block cap — anything past this is not a real proxy client. */
const CONNECT_HEADER_LIMIT = 64 * 1024;

const CONNECT_PREFIX = 'CONNECT ';
const HEADER_END = '\r\n\r\n';

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/**
 * The name a verdict or a policy check runs on: SNI off the wire may carry a
 * trailing dot (FQDN form) — a *normalizable-but-invalid* name that must
 * still be judged, never skipped (a `blocked.com.` ClientHello would
 * otherwise blind-tunnel past `||blocked.com^`). The evaluator's own host
 * parse does the same strip; policy lookups do not.
 */
function normalizeSni(sni: string): string {
  return sni.toLowerCase().replace(/\.+$/, '');
}

/**
 * First-bytes classification. 'undecided' while the buffer is still a
 * possible prefix of any recognized opener.
 */
function classify(buf: Buffer): 'undecided' | 'connect' | 'proxy2' | 'tls' | 'reject' {
  if (buf.length === 0) {
    return 'undecided';
  }
  const signature = matchProxyV2Signature(buf);
  if (signature === 'match') {
    return 'proxy2';
  }
  if (signature === 'partial') {
    return 'undecided';
  }
  if (buf[0] === 0x16) {
    if (buf.length < 2) {
      return 'undecided';
    }
    return buf[1] === 0x03 ? 'tls' : 'reject';
  }
  const text = buf.toString('latin1', 0, Math.min(buf.length, CONNECT_PREFIX.length));
  if (text === CONNECT_PREFIX) {
    return 'connect';
  }
  if (CONNECT_PREFIX.startsWith(text)) {
    return 'undecided';
  }
  return 'reject';
}

/**
 * `CONNECT host:port` target parsing — bracketed IPv6 included. Returns null
 * on anything that isn't a plausible authority.
 */
function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  let host: string;
  let portText: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || authority[close + 1] !== ':') {
      return null;
    }
    host = authority.slice(1, close);
    portText = authority.slice(close + 2);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon < 0) {
      return null;
    }
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
  }
  // Decimal digits only — Number() alone would accept `0x1bb`, `+443`, `4e2`.
  if (!/^\d{1,5}$/.test(portText)) {
    return null;
  }
  const port = Number(portText);
  if (host.length === 0 || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

export function startProxy(opts: StartProxyOptions): Promise<RunningProxy> {
  const { bindHost, dataPort, policy } = opts;
  let evaluator = opts.evaluator;
  // opts.authority is accepted but unused — Task 5 forges leaves at the seam.

  const stats: ProxyStats = {
    flowsTotal: 0,
    flowsBlocked: 0,
    flowsTunneled: 0,
    flowsTerminated: 0,
    pinsLearned: 0,
  };
  const sockets = new Set<net.Socket>();

  function track(sock: net.Socket): void {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
    // Every flow gets an error trap up front — a bare 'error' event on a
    // socket with no listener throws; flows must only ever die by destroy.
    sock.once('error', () => {});
  }

  /**
   * Blind splice: replay `head` (bytes a peek already consumed) into the
   * original destination, then pipe both ways. Either side erroring or
   * closing destroys the other — no half-dead flow, no leaked fds.
   */
  function blindTunnel(client: net.Socket, dstHost: string, dstPort: number, head: Buffer): void {
    // Pause while the upstream dials: the client socket is in flowing mode
    // (dispatch read off it), so a byte arriving between now and `pipe()` has
    // no 'data' listener and would be silently dropped — pausing buffers it
    // for the splice instead.
    client.pause();
    const upstream = net.connect({ host: dstHost, port: dstPort });
    track(upstream);
    // Connect deadline, distinct from socket idle timeouts: the tunnel itself
    // may idle legitimately, but a dial that never answers is a parked fd.
    const connectDeadline = setTimeout(() => {
      client.destroy();
      upstream.destroy();
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    connectDeadline.unref();
    const kill = () => {
      clearTimeout(connectDeadline);
      client.destroy();
      upstream.destroy();
    };
    upstream.once('error', kill);
    client.once('error', kill);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      clearTimeout(connectDeadline);
      // Replay the bytes the peek consumed before splicing — pipe applies
      // backpressure for us, so a slow upstream never loses `head`.
      if (head.length > 0) {
        upstream.write(head);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      stats.flowsTunneled++;
    });
  }

  /**
   * Explicit forward proxy: verdict on the CONNECT authority, then — for
   * allowed non-passthrough hosts — a bounded peek at what follows the 200.
   */
  async function handleConnect(sock: net.Socket, requestHead: Buffer, rest: Buffer): Promise<void> {
    const lineEnd = requestHead.indexOf('\r\n');
    const requestLine = requestHead
      .subarray(0, lineEnd < 0 ? requestHead.length : lineEnd)
      .toString('latin1');
    const parts = requestLine.split(/\s+/);
    const target = parts[1] !== undefined ? parseConnectAuthority(parts[1]) : null;
    if (target === null) {
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const { host, port } = target;

    // A literal IP never carries SNI — nothing to evaluate or peek (Review
    // Focus #1); pinned/bypassed hosts are the policy store's blind-tunnel
    // predicate, honored before any verdict.
    if (isIP(host) !== 0 || policy.isPinned(host) || policy.isBypassed(host)) {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      blindTunnel(sock, host, port, rest);
      return;
    }

    const verdict = evaluator.evaluate(`https://${host}/`);
    if (verdict.action === 'blocked') {
      stats.flowsBlocked++;
      const rule =
        verdict.coveringRule === null
          ? ''
          : `\r\nX-Blockingmachine-Rule: ${sanitizeHeaderValue(verdict.coveringRule)}`;
      sock.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: 0${rule}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }

    // Allowed/exception: answer 200, then peek at what the client actually
    // sends. Non-TLS bytes or silence close cleanly inside the peek bound —
    // Review Focus #2: a scanner or a non-TLS port must never hang a socket.
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const peeked = await collectClientHello(sock, PEEK_TIMEOUT_MS, rest);
    if (!peeked.isTls) {
      sock.destroy();
      return;
    }
    // The announced SNI gets its own verdict when it disagrees with the
    // CONNECT host — a client must not smuggle a blocked name inside an
    // allowed authority.
    if (peeked.sni !== null && peeked.sni.toLowerCase() !== host.toLowerCase()) {
      const sni = normalizeSni(peeked.sni);
      if (evaluator.evaluate(`https://${sni}/`).action === 'blocked') {
        stats.flowsBlocked++;
        sock.destroy();
        return;
      }
      // A pinned/bypassed SNI is the party that pins, not the authority —
      // tunnel to the CONNECT target the client actually dialed.
      if (policy.isPinned(sni) || policy.isBypassed(sni)) {
        blindTunnel(sock, host, port, peeked.head);
        return;
      }
    }
    // P0: blind tunnel — Task 5 terminates here (forged-leaf TLSSocket for
    // `peeked.sni`/`host`, ALPN h2|http/1.1, then the request pipeline).
    // Gate the forge on isValidSni first — `forgeLeaf` throws on invalid SNI,
    // and a missing/garbage name must stay on this blind path.
    blindTunnel(sock, host, port, peeked.head);
  }

  /**
   * Transparent flow: PROXY-v2 gives `target`; a spliced flow without the
   * header passes null — peeked for consistency but unroutable, so it closes
   * until Task 5 can terminate it (no destination exists to tunnel to).
   */
  async function handleTransparent(
    sock: net.Socket,
    target: { dstHost: string; dstPort: number } | null,
    rest: Buffer,
  ): Promise<void> {
    const peeked = await collectClientHello(sock, PEEK_TIMEOUT_MS, rest);
    if (target === null) {
      // Head cannot be replayed anywhere — no destination was announced.
      sock.destroy();
      return;
    }
    const { dstHost, dstPort } = target;
    // Non-TLS bytes forward honestly — helpers also redirect port 80.
    if (!peeked.isTls) {
      blindTunnel(sock, dstHost, dstPort, peeked.head);
      return;
    }
    const sni = peeked.sni;

    // The verdict runs on the *normalized* name whenever one was announced —
    // validity is not a gate: `blocked.com.` must drop, and pinned/bypassed
    // checks apply to the name rules and users actually write. Only an
    // absent SNI skips judgment entirely.
    if (sni !== null) {
      const normalized = normalizeSni(sni);
      if (policy.isPinned(normalized) || policy.isBypassed(normalized)) {
        blindTunnel(sock, dstHost, dstPort, peeked.head);
        return;
      }
      if (evaluator.evaluate(`https://${normalized}/`).action === 'blocked') {
        stats.flowsBlocked++;
        // No response exists on raw TLS — the close itself is the verdict.
        sock.destroy();
        return;
      }
    }

    // P0: blind tunnel — Task 5 terminates here, but ONLY when
    // isValidSni(sni) — `forgeLeaf` throws on invalid/absent names, and a
    // normalizable-but-invalid or missing SNI keeps this blind tunnel.
    blindTunnel(sock, dstHost, dstPort, peeked.head);
  }

  /**
   * Accepted-socket dispatch: accumulate until the opening bytes decide, with
   * a hard deadline so silence can never hang a socket. Buffer handoff keeps
   * `rest` (bytes already read past the dispatch point) for the next stage.
   */
  function onConnection(sock: net.Socket): void {
    track(sock);
    stats.flowsTotal++;
    const chunks: Buffer[] = [];
    let mode: 'dispatch' | 'connect' | 'proxy2' = 'dispatch';

    const timer = setTimeout(() => sock.destroy(), DISPATCH_TIMEOUT_MS);
    sock.once('close', () => clearTimeout(timer));

    const handOff = (fn: () => void) => {
      clearTimeout(timer);
      // Same dropped-byte window as blindTunnel: the socket stays in flowing
      // mode after this listener detaches, so pause until the next stage
      // takes over (`collectClientHello`'s own 'data' listener re-flows it,
      // and a destroy/response path never needs reads again).
      sock.pause();
      sock.off('data', onData);
      fn();
    };

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (mode === 'dispatch') {
        const cls = classify(buf);
        if (cls === 'undecided') {
          return;
        }
        if (cls === 'reject') {
          // Task 5: plain-HTTP absolute-form (`GET http://h/x`) lands here.
          handOff(() => sock.destroy());
          return;
        }
        if (cls === 'tls') {
          handOff(() => {
            void handleTransparent(sock, null, buf).catch(() => sock.destroy());
          });
          return;
        }
        mode = cls;
      }
      if (mode === 'proxy2') {
        const frameLength = proxyV2FrameLength(buf);
        if (frameLength === null || buf.length < frameLength) {
          return;
        }
        const target = parseProxyV2(buf.subarray(0, frameLength));
        const rest = buf.subarray(frameLength);
        handOff(() => {
          if (target === null) {
            sock.destroy(); // malformed/unsupportable frame — honest close
            return;
          }
          void handleTransparent(sock, target, rest).catch(() => sock.destroy());
        });
        return;
      }
      if (mode === 'connect') {
        const end = buf.indexOf(HEADER_END);
        if (end < 0) {
          if (buf.length > CONNECT_HEADER_LIMIT) {
            handOff(() => sock.destroy());
          }
          return;
        }
        const requestHead = buf.subarray(0, end + HEADER_END.length);
        const rest = buf.subarray(end + HEADER_END.length);
        handOff(() => {
          void handleConnect(sock, requestHead, rest).catch(() => sock.destroy());
        });
      }
    };

    sock.on('data', onData);
    sock.resume();
  }

  const server = net.createServer({ pauseOnConnect: true }, onConnection);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(dataPort, bindHost, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : dataPort;
      resolve({
        port,
        stats: () => ({ ...stats }),
        reload(rawRules: string[]) {
          // Rebuild off the hot path, then swap — in-flight flows finish on
          // the evaluator they started with.
          evaluator = createRequestEvaluator(rawRules);
        },
        async close() {
          for (const sock of sockets) {
            sock.destroy();
          }
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
        },
      });
    });
  });
}

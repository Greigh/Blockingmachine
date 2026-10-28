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
 *    without a PROXY header. A valid announced SNI terminates locally and
 *    relays upstream to `sni:443` — the only destination the wire itself
 *    announces; invalid/absent SNI still closes honestly (no header, no
 *    routable destination).
 *  - anything else — probed for plain-HTTP absolute-form (`GET http://h/x`);
 *    a real request is evaluated and forwarded verbatim to the resolved
 *    host:port (default 80), everything else closes, counted, never hung.
 *
 * Flow semantics per path:
 *
 *  - CONNECT: literal-IP targets always blind-tunnel (no SNI will ever
 *    arrive — spec §5.2); named targets take a synthetic verdict on
 *    `https://<host>/` — `blocked` answers `403` + `X-Blockingmachine-Rule`,
 *    allowed/exception answers `200`. Pinned/bypassed targets then splice
 *    blind; the rest take a bounded ClientHello peek — non-TLS bytes or
 *    silence close cleanly (never a hung socket), and real TLS with a valid
 *    SNI terminates at the forged-leaf endpoint (Task 5); absent or invalid
 *    SNI keeps the blind tunnel — `forgeLeaf` throws on those names.
 *  - PROXY-v2: the same peek decides — non-TLS bytes that parse as a
 *    plain-HTTP request take the same dual-authority verdict the dispatch
 *    path applies (flag 93 — helpers redirect :80 too); other non-TLS
 *    bytes, missing/invalid SNI, and pinned/bypassed SNI all blind-tunnel
 *    to the header's destination; a blocked SNI drops the flow silently
 *    (no response exists on raw TLS); allowed + valid SNI terminates.
 *    Per-request verdicts then run on every decrypted request — keep-alive
 *    connections may change Host (Review Focus #4).
 *
 * `reload(rawRules, cosmeticIndex?)` rebuilds the evaluator off the hot path
 * and swaps the reference (the cosmetic index riding alongside when the
 * caller supplies one) — both are immutable, so in-flight flows finish on
 * the ruleset they started with. `setPaused(true)` is the protection toggle
 * the control API drives: every verdict point then blind-tunnels instead of
 * judging or terminating — protection off, connectivity never breaks
 * (in-flight terminated flows finish on the pipe they already have).
 * `close()` stops accepting and destroys every tracked socket (client and
 * upstream alike).
 *
 * Flag 127 — data-port authentication and destination denylist:
 *
 *  - `authToken` set → non-loopback peers authenticate before any flow
 *    handling: CONNECT/plain-HTTP present `Proxy-Authorization`
 *    (`Bearer <token>` or `Basic` with the token as password) and earn an
 *    explicit `407 Proxy Authentication Required` on failure; PROXY-v2
 *    frames carry the token as the pinned `0xE0` TLV (see
 *    `proxyProtocol.ts`) and die on a miss/mismatch — raw TLS has no
 *    response channel, so the close IS the refusal and it precedes the
 *    ClientHello peek (an unauthenticated client can never park the
 *    socket). Headerless TLS splices carry no auth transport: refused
 *    outright for non-loopback peers under a token. Loopback peers stay
 *    exempt — the local capture helper is the trust anchor.
 *  - `authToken` absent → the port is open: the recorded trusted-LAN
 *    fallback for single-user deployments, surfaced as
 *    `dataAuthRequired: false` on `/v1/proxy/status` and logged once at
 *    engine start when the data bind is non-loopback.
 *  - `denyPrivateDestinations` → a non-loopback peer may not aim a flow at
 *    loopback/RFC1918/link-local/CGNAT/ULA/multicast/`localhost` —
 *    403 for HTTP-shaped flows, an honest close on PROXY-v2. Off by
 *    default: a single-user LAN hub proxies to its own LAN legitimately.
 *
 * Flag 129 — `GET /ca.pem` + `GET /v1/proxy/ca.pem` (consolidated-review
 * M2): a read-only, unauthenticated route answering `authority.caCertPem`
 * — the LAN enrollment surface a phone fetches before verifying the
 * fingerprint out-of-band. Both spellings hit the same handler
 * (`SELF_GET_CA_PATHS`): `/ca.pem` shipped first, the `/v1/proxy/`-prefixed
 * spelling is the documented contract the mobile `fetchHubCa` builds. It
 * is deliberately NOT a control surface (one static file; the control API
 * stays loopback-only on :9293) and exempt from every gate — an
 * unenrolled device is the caller it exists for.
 */

import { timingSafeEqual } from 'node:crypto';
import net, { isIP } from 'node:net';
import {
  createRequestEvaluator,
  type CosmeticIndex,
  type RequestEvaluator,
} from '@blockingmachine/core';
import { isValidSni, normalizeSni, type CertAuthority } from '../ca/certAuthority.js';
import { LeafForgeQueue } from '../ca/leafForgeQueue.js';
import type { InjectionBudget, ResponseEvent } from '../pipeline/response.js';
import {
  applyRequestTransforms,
  inferContentType,
  inferThirdParty,
  unionRequestTransforms,
} from '../pipeline/transforms.js';
import type { PolicyStore } from '../policy/policyStore.js';
import {
  absoluteRequestUrl,
  parsePlainHttpTarget,
  probePlainHttp,
  relayRequest,
  splitHostPort,
  type PlainHttpTarget,
  type UpstreamEndpoint,
} from './httpRelay.js';
import {
  matchProxyV2Signature,
  parseProxyV2,
  proxyV2FrameLength,
  type ProxyV2Target,
} from './proxyProtocol.js';
import { collectClientHello } from './sniPeek.js';
import { SELF_GET_CA_MOBILECONFIG_PATHS, SELF_GET_CA_PATHS } from './selfRoutes.js';
import { buildCaMobileConfig } from './caMobileConfig.js';
import { terminateToHttp } from './terminate.js';

export interface ProxyStats {
  flowsTotal: number;
  /** Whole flows refused before any relaying — CONNECT/plain-HTTP verdicts, blocked SNIs. */
  flowsBlocked: number;
  /**
   * Per-request blocks *inside* terminated flows — a keep-alive connection
   * can carry many. Kept apart from `flowsBlocked` so `blockRatePercent`
   * stays a flow rate: chatty keep-alives must not push it past 100.
   */
  requestsBlocked: number;
  /**
   * Per-response blocks inside terminated flows (P2 Task 3) — the
   * response-content-type re-verdict refusing a body the request-side
   * verdict allowed. Kept apart from `requestsBlocked` for the same
   * rate-accounting reason: a response block is a request the upstream
   * answered, not one we refused to send.
   */
  responsesBlocked: number;
  /** Pages whose HTML actually received injected markup (not merely eligible). */
  htmlInjected: number;
  /** Supported scriptlet invocations emitted across all injections. */
  scriptletsInvoked: number;
  /** Scriptlet calls dropped because the name has no runtime implementation. */
  skippedScriptlets: number;
  /**
   * Eligible-HTML responses delivered un-injected: body overflow past
   * `MAX_HTML_BUFFER`, an empty render, or an injector error — all
   * fail-open passes, counted so the gap is observable.
   */
  injectionsSkipped: number;
  /** CSP header values widened for injection (counted only on real changes). */
  cspRewrites: number;
  flowsTunneled: number;
  flowsTerminated: number;
  pinsLearned: number;
  /**
   * Flows refused by the data-port token gate (flag 127): a non-loopback
   * peer with no/absent/wrong `Proxy-Authorization` on CONNECT or
   * plain-HTTP (answered 407), or a PROXY-v2 frame without the pinned auth
   * TLV / a headerless splice with no auth transport (honest close — raw
   * TLS has no 407 to send).
   */
  authRefusals: number;
  /**
   * Rules in the live evaluator — seeded at start, refreshed by `reload()`.
   * `evaluator.size` is otherwise unobservable once a reload swaps it.
   */
  rulesSize: number;
  /**
   * The live cosmetic index's rule populations — its `size()` seeded at
   * start and refreshed by `reload()` alongside `rulesSize`, the same
   * observability contract (the index is immutable and swapped whole).
   * `null` when this engine was started without an index — "no cosmetic
   * layer" must read differently from "0 rules" so the card can tell
   * loaded-but-not-injecting apart from an empty index.
   */
  cosmetic: ReturnType<CosmeticIndex['size']> | null;
}

export interface RunningProxy {
  readonly port: number;
  close(): Promise<void>;
  stats(): ProxyStats;
  /**
   * Swap the ruleset. `cosmeticIndex` rides alongside — the response
   * pipeline's half of the same line file — so both faces of the ruleset
   * change on the same call; omitted (direct `startProxy` callers without
   * cosmetics) leaves the prior index in place.
   */
  reload(rawRules: string[], cosmeticIndex?: CosmeticIndex): void;
  /**
   * Protection pause — the `/v1/proxy/toggle` seam. While paused every
   * verdict point blind-tunnels: no evaluation, no termination, no forge —
   * connectivity is never held hostage to the filter.
   */
  setPaused(paused: boolean): void;
  isPaused(): boolean;
}

export interface StartProxyOptions {
  bindHost: string;
  dataPort: number;
  /**
   * The companion `/v1/proxy/*` control listener's port, when the caller
   * knows it — the self-target guard refuses client-supplied destinations
   * aimed at either own port. Optional for direct `startProxy` callers; an
   * ephemeral (`0`) control port resolves to a port the data listener never
   * learned, which is safe — a client that cannot name the port cannot
   * self-chain through it.
   */
  controlPort?: number;
  /** Forges the leaf each terminated flow serves — required. */
  authority: CertAuthority;
  evaluator: RequestEvaluator;
  /**
   * The cosmetic index for the same ruleset (P2 Task 3) — absent, the
   * response pipeline never sees injectable hosts and every response
   * streams verbatim (still judged for `$csp` and content-type blocks).
   */
  cosmeticIndex?: CosmeticIndex;
  policy: PolicyStore;
  /**
   * Extra PEM roots merged over `tls.rootCertificates` for upstream
   * verification — a deployment/test hook, never a bypass:
   * `rejectUnauthorized: true` holds regardless. Note that passing an
   * explicit `ca` list replaces Node's whole default trust set — including
   * anything `NODE_EXTRA_CA_CERTS` added at process start — so deployments
   * needing env-provided roots must fold them in here.
   */
  upstreamCaCerts?: string[];
  /** Test/deploy knob — the upstream dial deadline (default 15s). */
  upstreamConnectTimeoutMs?: number;
  /**
   * Test/deploy knob — first-byte deadline on the upstream response once the
   * TLS handshake has completed (default 30s). Bounds only the wait for the
   * 'response' event; a streaming body is unaffected.
   */
  upstreamResponseTimeoutMs?: number;
  /** Test knob — the bounded ClientHello peek (default 10s, spec §5.2). */
  peekTimeoutMs?: number;
  /** Test knob — leaf-forge concurrency bound (default 1, serialized). */
  forgeConcurrency?: number;
  /**
   * Proxy-wide bound on concurrent HTML-injection buffers (default 64).
   * Each live injection holds up to `MAX_HTML_BUFFER` bytes while its body
   * accumulates, so an unbounded count is an unbounded memory surface — the
   * sibling of `forgeConcurrency` for response depth (flag 108's sibling).
   * `0` disables injection buffering entirely (every eligible page skips
   * `busy`); negative/absent values take the default.
   */
  injectionBudget?: number;
  /**
   * Shared data-port token (flag 127) — `BM_DATA_TOKEN`. When set, every
   * non-loopback peer must authenticate before any flow handling:
   * CONNECT and plain-HTTP requests carry `Proxy-Authorization` (a
   * `Bearer <token>` value, or `Basic` credentials whose password field is
   * the token) and are refused `407 Proxy Authentication Required`;
   * PROXY-v2 spliced flows carry the token in-band as the pinned `0xE0`
   * TLV (see proxyProtocol.ts) and are closed on a miss/mismatch — raw
   * TLS has no response channel, so the close is the refusal and it must
   * never hang. A headerless TLS splice has no in-band transport at all:
   * non-loopback peers are refused outright under a token. Loopback peers
   * stay exempt (the local capture helper is the trust anchor). Absent or
   * empty → the port is open — the recorded trusted-LAN fallback.
   */
  authToken?: string;
  /**
   * Optional destination denylist (flag 127): when true, a NON-loopback
   * peer may not aim a flow at a loopback, RFC1918, link-local, CGNAT,
   * ULA, multicast/reserved, or `localhost` destination — the SSRF surface
   * a LAN-reachable proxy otherwise carries (the hub's own services
   * included). Literal destinations only — a hostname is the caller's
   * routing answer, not a listener identity. Default off: the single-user
   * LAN hub legitimately proxies to its own LAN services.
   */
  denyPrivateDestinations?: boolean;
  /**
   * Test seam — the loopback-peer predicate `authToken`/`denyPrivate...`
   * consult (`sock.remoteAddress` in, exempt/not out). Default checks the
   * loopback families; suites inject it to exercise the LAN-peer paths
   * without a real second interface.
   */
  isLoopbackPeer?: (remoteAddress: string | undefined) => boolean;
}

/** Default cap on simultaneous injection buffers — ~32 MiB of worst-case held pages. */
const INJECTION_BUDGET_DEFAULT = 64;

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

/**
 * The 407 every unauthenticated CONNECT/plain-HTTP request earns when a
 * data-port token is configured (flag 127) — an explicit refusal, `close`,
 * never a hang. `Proxy-Authenticate` names the realm so a generic proxy
 * client surfaces a credentials prompt rather than a bare error.
 */
const PROXY_AUTH_REQUIRED =
  'HTTP/1.1 407 Proxy Authentication Required\r\n' +
  'Proxy-Authenticate: Basic realm="Blockingmachine"\r\n' +
  'Content-Length: 0\r\nConnection: close\r\n\r\n';

// M2: re-exported so the engine's served CA-route set is pinnable against
// the mobile `fetchHubCa` twin (see selfRoutes.ts).
export { SELF_GET_CA_PATHS };

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/** First `name:` header value in a latin1 request head, or null when absent. */
function requestHeadHeaderValue(head: string, name: string): string | null {
  const lineEnd = head.indexOf('\r\n');
  for (const line of head.slice(lineEnd < 0 ? head.length : lineEnd + 2).split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep > 0 && line.slice(0, sep).trim().toLowerCase() === name) {
      return line.slice(sep + 1).trim();
    }
  }
  return null;
}

/**
 * Constant-time token comparison — a prefix-matching early-exit compare
 * would leak the token's leading bytes through response timing to a LAN
 * peer (the only clients this check exists for).
 */
function tokenEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The CONNECT/plain-HTTP auth check (flag 127): `Proxy-Authorization` must
 * carry the token as `Bearer <token>` or as the password half of a `Basic`
 * credential (`user:token` base64 — any username; what curl emits for
 * `--proxy-user :<token>` and what generic proxy clients send for a
 * proxy-auth challenge). Anything else — absent header, unknown scheme,
 * wrong token — is a refusal.
 */
function proxyAuthorizationOk(requestHead: Buffer, token: string): boolean {
  const raw = requestHeadHeaderValue(requestHead.toString('latin1'), 'proxy-authorization');
  if (raw === null) {
    return false;
  }
  const bearer = /^bearer[ \t]+(\S+)$/i.exec(raw);
  if (bearer !== null) {
    return tokenEquals(bearer[1], token);
  }
  const basic = /^basic[ \t]+(\S+)$/i.exec(raw);
  if (basic !== null) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return tokenEquals(colon < 0 ? decoded : decoded.slice(colon + 1), token);
  }
  return false;
}

/**
 * The default loopback-peer predicate (flag 127): the engine's trust anchor
 * is the local capture helper, so same-host flows stay exempt even when a
 * token is configured. `remoteAddress` is always an IP literal — `localhost`
 * never appears. `::ffff:`-mapped v4 peers (what a v6-capable listener
 * reports for a v4 dial) get the v4 rule.
 */
function defaultIsLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) {
    return false;
  }
  let h = remoteAddress.toLowerCase();
  if (h.startsWith('::ffff:')) {
    h = h.slice('::ffff:'.length);
  }
  const version = isIP(h);
  if (version === 4) {
    return h.startsWith('127.');
  }
  if (version === 6) {
    return h === '::1' || h === '0:0:0:0:0:0:0:1';
  }
  return false;
}

/**
 * Expand a (verified, `isIP`===6) IPv6 literal to its eight hextets —
 * embedded-v4 tails count double, `::` fills with zeros. Null on anything
 * outside that verified shape.
 */
function expandV6(host: string): number[] | null {
  let h = host;
  const tail: number[] = [];
  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon < 0) {
      return null;
    }
    const v4 = h.slice(lastColon + 1);
    if (isIP(v4) !== 4) {
      return null;
    }
    const parts = v4.split('.').map(Number);
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
    h = h.slice(0, lastColon);
  }
  const halves = h.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null;
  if (right === null) {
    if (left.length + tail.length !== 8) {
      return null;
    }
    return [...left.map((g) => parseInt(g, 16)), ...tail];
  }
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 0) {
    return null;
  }
  return [
    ...left.map((g) => parseInt(g, 16)),
    ...new Array<number>(fill).fill(0),
    ...right.map((g) => parseInt(g, 16)),
    ...tail,
  ];
}

/**
 * One inet_aton component — the BSD spelling: `0x`/`0X` is hex, a leading
 * `0` makes the rest octal (an 8 or 9 anywhere fails the WHOLE parse, like
 * libc — never "decimal with a leading zero"), otherwise decimal. Null on
 * anything outside that grammar.
 */
function parseAtonComponent(part: string): number | null {
  if (part.startsWith('0x') || part.startsWith('0X')) {
    const hex = part.slice(2);
    return hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : null;
  }
  if (part.length > 1 && part.startsWith('0')) {
    return /^[0-7]+$/.test(part) ? parseInt(part, 8) : null;
  }
  return /^[0-9]+$/.test(part) ? Number(part) : null;
}

/**
 * The BSD inet_aton grammar `isIP` refuses but getaddrinfo accepts: 1–4
 * dot-separated numeric components where the LAST widens over the bytes the
 * earlier ones left (`127.1` → 127.0.0.1, `2130706433` → 127.0.0.1,
 * `0x7f000001` → 127.0.0.1, `0177.0.0.1` → 127.0.0.1). Returns the canonical
 * dotted quad, or null when the string is not an inet_aton literal at all —
 * an ordinary hostname then, which is the caller's routing answer.
 */
function parseInetAton(host: string): string | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) {
    return null;
  }
  const values: number[] = [];
  for (const part of parts) {
    const n = parseAtonComponent(part);
    if (n === null) {
      return null;
    }
    values.push(n);
  }
  // Non-final components are one byte each; the final spans the rest —
  // 8 bits with four components, 32 with one.
  let addr = 0;
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 0xff) {
      return null;
    }
    addr = addr * 256 + values[i];
  }
  const lastBits = 8 * (5 - values.length);
  if (values[values.length - 1] >= 2 ** lastBits) {
    return null;
  }
  addr = addr * 2 ** lastBits + values[values.length - 1];
  const octet = (shift: number): number => Math.floor(addr / 2 ** shift) % 256;
  return `${octet(24)}.${octet(16)}.${octet(8)}.${octet(0)}`;
}

/**
 * Canonicalize a client-supplied destination literal to the address
 * getaddrinfo actually resolves (consolidated-review M1). `net.isIP` is the
 * strict inet_pton reading, so `127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, and v6-mapped hextets like `::ffff:7f00:1` all read as "not
 * an IP" while net.connect dials them straight to loopback — the
 * self-target and private-destination guards used to judge a different
 * string than the socket connected. Guards and dials run this first so
 * both sides see the same address; a string that is not an IP literal at
 * all passes through untouched (a hostname stays the caller's routing
 * answer). `::ffff:`-mapped v6 collapses to the embedded v4 — on the wire
 * it IS that address.
 */
export function canonicalizeIpLiteral(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  const version = isIP(h);
  if (version === 4) {
    return h;
  }
  if (version === 6) {
    const groups = expandV6(h);
    if (groups !== null) {
      if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      }
      if (groups.every((g) => g === 0)) {
        return '::';
      }
      if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
        return '::1';
      }
    }
    return h;
  }
  return parseInetAton(h) ?? h;
}

/**
 * The optional non-loopback-peer destination denylist (flag 127): the SSRF
 * surface a LAN-reachable proxy carries — loopback (the hub's own services),
 * RFC1918, link-local, CGNAT, ULA, `::`, multicast/reserved, `localhost`.
 * Literal destinations only; a hostname is the caller's routing answer.
 */
function isPrivateDestinationHost(host: string): boolean {
  // M1: judge the address getaddrinfo resolves, not the spelling — `10.1`,
  // `0x0a000001`, `::ffff:0a00:1` all land inside denied ranges while
  // reading as "not an IP" to the strict parser.
  const h = canonicalizeIpLiteral(host);
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }
  const version = isIP(h);
  if (version === 4) {
    const a = h.split('.').map(Number);
    return (
      a[0] === 0 || // "this network"
      a[0] === 10 ||
      a[0] === 127 ||
      (a[0] === 169 && a[1] === 254) || // link-local
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || // CGNAT 100.64/10
      a[0] >= 224 // multicast (224/4) + reserved (240/4), broadcast included
    );
  }
  if (version === 6) {
    const groups = expandV6(h);
    if (groups === null) {
      return false;
    }
    if (groups.every((g) => g === 0)) {
      return true; // :: — the wildcard
    }
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
      return true; // ::1
    }
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      // ::ffff:a.b.c.d — a mapped v4 destination takes the v4 rules.
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      return isPrivateDestinationHost(v4);
    }
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return true; // fe80::/10 link-local
    }
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return true; // fc00::/7 ULA
    }
    if ((groups[0] & 0xff00) === 0xff00) {
      return true; // ff00::/8 multicast
    }
  }
  return false;
}

/**
 * The hostname an absolute request URL resolves to — the authority the
 * evaluator judged and the cosmetic index keys on. Unparseable (never seen
 * in practice — the URL was just evaluated) falls back to the header
 * authority stripped of its port.
 */
function urlHost(url: string, fallbackAuthority: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return splitHostPort(fallbackAuthority, 443)?.host ?? fallbackAuthority;
  }
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
  const { bindHost, dataPort, policy, authority } = opts;
  const controlPort = opts.controlPort;
  const peekTimeoutMs = opts.peekTimeoutMs ?? PEEK_TIMEOUT_MS;
  // `dataPort: 0` resolves to an ephemeral port at listen time — the
  // self-target guard must compare the *bound* port, captured below.
  let boundDataPort = dataPort;
  let evaluator = opts.evaluator;
  // Flag-127 posture: an absent/empty token is the recorded trusted-LAN
  // fallback (open port); a configured token makes non-loopback peers
  // authenticate before any destination work (loopback stays exempt — the
  // local capture helper is the trust anchor). The denylist opts in to
  // refusing private/loopback destinations for those same non-loopback
  // peers; both gates consult the peer once, at accept time.
  const authToken =
    opts.authToken !== undefined && opts.authToken.length > 0 ? opts.authToken : undefined;
  const denyPrivate = opts.denyPrivateDestinations === true;
  const isLoopbackPeer = opts.isLoopbackPeer ?? defaultIsLoopbackPeer;
  // Snapshotted per flow next to `flowEvaluator` — a mid-flow reload must
  // not swap the cosmetic payload under in-flight responses either.
  let cosmeticIndex = opts.cosmeticIndex;
  let paused = false;
  /**
   * Engine teardown in progress — set by `close()` before the tracked
   * sockets are destroyed. A socket dying before `secureConnection` is the
   * pinning signal ONLY when the client chose to die on the forged leaf;
   * shutdown kills read identically on the wire, so the abort hook consults
   * this flag and never lets teardown mint a persistent pin.
   */
  let closing = false;
  // Dedupe + serialize the synchronous RSA-2048 leaf forge (flag 94): one
  // keygen per name under a spray, and queued bursts yield the loop between
  // mints instead of chaining them inside one synchronous drain.
  const forgeQueue = new LeafForgeQueue(authority, { concurrency: opts.forgeConcurrency });
  // The response-depth sibling of the forge bound: every live injection
  // buffer may hold up to MAX_HTML_BUFFER bytes, so simultaneous buffers
  // are capped proxy-wide — an eligible response that finds the budget
  // spent streams verbatim (`inject-skip` `busy`) rather than queueing
  // unbounded memory.
  const injectionBudget: InjectionBudget = {
    inflight: 0,
    max: opts.injectionBudget ?? INJECTION_BUDGET_DEFAULT,
  };

  const stats: ProxyStats = {
    flowsTotal: 0,
    flowsBlocked: 0,
    requestsBlocked: 0,
    responsesBlocked: 0,
    htmlInjected: 0,
    scriptletsInvoked: 0,
    skippedScriptlets: 0,
    injectionsSkipped: 0,
    cspRewrites: 0,
    flowsTunneled: 0,
    flowsTerminated: 0,
    pinsLearned: 0,
    authRefusals: 0,
    rulesSize: evaluator.size,
    cosmetic: cosmeticIndex?.size() ?? null,
  };
  const sockets = new Set<net.Socket>();

  /**
   * The response pipeline's stat/ledger sink — the relay emits
   * {@link ResponseEvent}s; counters bump here, and the ledgerable kinds
   * (block / inject / csp-rewrite) land one `proxy_event` line per host per
   * session (the store dedupes — the journal is an audit trail, not a
   * counter). `inject-skip` is a counter only: expected noise, not an audit
   * fact.
   */
  const ledgerEvent = (host: string, reason: string): void => {
    // An empty host is a relay-side guard path, not a ledger fact — and
    // `recordEvent` (rightly) refuses it.
    if (host === '') {
      return;
    }
    try {
      policy.recordEvent(host, reason);
    } catch {
      // Audit must NEVER throw into the data path: `host` is client bytes
      // (the request URL's authority) and `requireHost` refuses past the
      // 253-char hostname cap — an unguarded throw propagates out of the
      // response handler as an uncaughtException and takes the engine.
      // A skipped audit line, never a dead flow.
    }
  };
  const onResponseEvent = (event: ResponseEvent): void => {
    switch (event.kind) {
      case 'response-block':
        stats.responsesBlocked++;
        // The covering rule is list text (like a learned pin's reason tag),
        // never page data — hostname-only still holds.
        ledgerEvent(
          event.host,
          `response-block${event.rule !== null && event.rule !== '' ? ` ${event.rule}` : ''}`,
        );
        return;
      case 'html-inject':
        stats.htmlInjected++;
        stats.scriptletsInvoked += event.scriptlets;
        stats.skippedScriptlets += event.skippedScriptlets;
        ledgerEvent(event.host, 'html-inject');
        return;
      case 'csp-rewrite':
        stats.cspRewrites += event.count;
        ledgerEvent(event.host, 'csp-rewrite');
        return;
      case 'inject-skip':
        stats.injectionsSkipped++;
        // A `no-known-content` skip carries the unknown-name count — the
        // card's skipped-scriptlets figure must see scriptlets even when no
        // known co-passenger earned an `html-inject` line.
        if (event.skippedScriptlets !== undefined) {
          stats.skippedScriptlets += event.skippedScriptlets;
        }
        return;
    }
  };

  function track(sock: net.Socket): void {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
    // Every flow gets an error trap up front — a bare 'error' event on a
    // socket with no listener throws; flows must only ever die by destroy.
    sock.once('error', () => {});
  }

  /**
   * Is `host:port` one of this engine's own listeners? Every client-supplied
   * destination — CONNECT authority, plain-HTTP Host/absolute-form, PROXY-v2
   * frame (the magic is just bytes any local process can write) — is checked
   * against this: a target resolving to the bound data or control port on a
   * local address tunnels back into this same listener, where the spliced
   * bytes re-dispatch and spawn the next flow until fds run out — and a
   * same-host web page can drive it (`fetch('http://127.0.0.1:<port>/')` is
   * a simple cross-origin request). "Local" means loopback (127.0.0.0/8,
   * ::1 — expanded and ::ffff:-mapped forms included — `localhost`), the
   * wildcard addresses every stack loops back (0.0.0.0, ::), or the bindHost
   * itself. A hostname that merely *resolves* to loopback is out of scope —
   * that is the caller's routing answer, not a listener identity.
   */
  function isSelfTarget(host: string, port: number): boolean {
    if (port !== boundDataPort && (controlPort === undefined || port !== controlPort)) {
      return false;
    }
    // M1: canonicalize FIRST — guard and dial must judge the same literal:
    // `CONNECT 127.1:<port>` dials 127.0.0.1 through getaddrinfo whether or
    // not isIP recognizes the spelling.
    const h = canonicalizeIpLiteral(host);
    if (h === 'localhost' || h === bindHost.toLowerCase()) {
      return true;
    }
    const version = isIP(h);
    if (version === 4) {
      return h.startsWith('127.') || h === '0.0.0.0';
    }
    if (version === 6) {
      if (h.startsWith('::ffff:')) {
        const mapped = h.slice('::ffff:'.length);
        return isIP(mapped) === 4 && (mapped.startsWith('127.') || mapped === '0.0.0.0');
      }
      return h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::' || h === '0:0:0:0:0:0:0:0';
    }
    return false;
  }

  /**
   * The self-route parser the read-only surfaces share (flag 129 `/ca.pem`,
   * P7 `/proxy.pac`): a GET in origin form (`GET /x`) answers its path
   * verbatim; an absolute-form target (`GET http://<this listener>/x`) only
   * answers when the authority is THIS listener — a foreign authority is
   * ordinary proxy traffic, never a self-route. The request's own authority
   * (Host header, else the absolute-form authority) rides back so the PAC
   * body can emit the address the client actually used — a LAN-hub fetch
   * gets the LAN answer, not 127.0.0.1.
   */
  function parseSelfGetRequest(buf: Buffer): { path: string; authority: string | null } | null {
    const headEnd = buf.indexOf('\r\n\r\n');
    const head = buf.subarray(0, headEnd < 0 ? buf.length : headEnd).toString('latin1');
    const lineEnd = head.indexOf('\r\n');
    const requestLine = lineEnd < 0 ? head : head.slice(0, lineEnd);
    const match = /^([A-Z][A-Z0-9_-]{0,15})\s+(\S+)\s+HTTP\/\d+(?:\.\d+)?$/.exec(requestLine);
    if (match === null || match[1] !== 'GET') {
      return null;
    }
    const target = match[2];
    const hostHeader = /\r\nhost:\s*(\S+)/i.exec(head)?.[1] ?? null;
    if (target.startsWith('/') && !target.startsWith('//')) {
      return { path: target.split('?')[0], authority: hostHeader };
    }
    if (/^http:\/\//i.test(target)) {
      try {
        const parsed = new URL(target);
        const port = parsed.port === '' ? 80 : Number(parsed.port);
        if (!isSelfTarget(parsed.hostname, port)) {
          return null;
        }
        return { path: parsed.pathname, authority: hostHeader ?? parsed.host };
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * The PAC body (P7): `FindProxyForURL` sends LAN/intranet-shaped
   * destinations DIRECT and everything else to `PROXY <authority>; DIRECT`
   * — the fallback tail is the fail-open: a stopped engine degrades to
   * direct connectivity instead of holding it. The authority is the
   * request's own (Host header or bound address), so a PAC fetched off a
   * LAN bind names the LAN address the client dialed.
   */
  function buildPacFile(authority: string): string {
    return [
      '// Blockingmachine HTTPS filter — system-proxy PAC (P7, flag 123)',
      'function FindProxyForURL(url, host) {',
      '  host = host.toLowerCase();',
      '  if (isPlainHostName(host) ||',
      '      host === "localhost" || host === "::1" ||',
      '      dnsDomainIs(host, ".local") ||',
      '      isInNet(host, "127.0.0.0", "255.0.0.0") ||',
      '      isInNet(host, "10.0.0.0", "255.0.0.0") ||',
      '      isInNet(host, "172.16.0.0", "255.240.0.0") ||',
      '      isInNet(host, "192.168.0.0", "255.255.0.0") ||',
      '      isInNet(host, "169.254.0.0", "255.255.0.0")) {',
      '    return "DIRECT";',
      '  }',
      `  return "PROXY ${authority}; DIRECT";`,
      '}',
    ].join('\r\n');
  }

  /**
   * Blind splice: replay `head` (bytes a peek already consumed) into the
   * original destination, then pipe both ways. Either side erroring or
   * closing destroys the other — no half-dead flow, no leaked fds.
   */
  function blindTunnel(client: net.Socket, dstHost: string, dstPort: number, head: Buffer): void {
    // M1: the dial sees the same canonical literal the guards judged — a
    // shorthand spelling (`127.1`, `0x7f000001`) resolves identically here
    // and inside the checks, so no guard can be ducked by orthography.
    const dialHost = canonicalizeIpLiteral(dstHost);
    // Backstop self-target refusal: every splice converges here, so the
    // guard holds even on paths that skip a verdict point (paused flows,
    // the headerless-splice sni:443 fallback). HTTP-shaped callers already
    // answered 400; at this level the honest move is just to close.
    if (isSelfTarget(dialHost, dstPort)) {
      client.destroy();
      return;
    }
    // Pause while the upstream dials: the client socket is in flowing mode
    // (dispatch read off it), so a byte arriving between now and `pipe()` has
    // no 'data' listener and would be silently dropped — pausing buffers it
    // for the splice instead.
    client.pause();
    const upstream = net.connect({ host: dialHost, port: dstPort });
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
   * Forge + terminate a flow, then serve decrypted requests through the
   * verdict/relay chain. Callers must have already run the policy/verdict
   * checks and `isValidSni` gate — `sni` here is the normalized leaf name.
   * `upstream` is where every request in this flow is dialed.
   *
   * Per-request evaluation (Review Focus #4): the handler evaluates the
   * absolute URL of EVERY request — one keep-alive connection may carry
   * different Host headers, so verdicts are never per-connection. The
   * evaluator is snapshotted at flow start: a mid-flow `reload` must not
   * swap rules under in-flight requests.
   */
  function terminateFlow(flow: {
    sock: net.Socket;
    head: Buffer;
    sni: string;
    upstream: UpstreamEndpoint;
  }): void {
    // A terminated flow dials `upstream` per request — the same self-target
    // refusal a blind tunnel gets (the headerless-splice path derives
    // upstream as `sni:443`, which is this listener when dataPort is 443).
    // M1: the guarded host and the dialed host are the same canonical
    // literal — `relayRequest` connects to what this check judged.
    const upstream: UpstreamEndpoint = {
      ...flow.upstream,
      host: canonicalizeIpLiteral(flow.upstream.host),
    };
    if (isSelfTarget(upstream.host, upstream.port)) {
      flow.sock.destroy();
      return;
    }
    stats.flowsTerminated++;
    const flowEvaluator = evaluator;
    const flowCosmeticIndex = cosmeticIndex;
    // The pinning signal is the CLIENT refusing the forged leaf — a close
    // before `secureConnection` that the client chose. A close this engine
    // chose reads identically on the wire but is not distrust: `close()`
    // destroys every tracked socket (flagged by `closing`), and a
    // `terminateToHttp` rejection — a forge failure above all — lands in the
    // `.catch` below, which flags before destroying. Both suppressions live
    // here rather than inside the TLS layer because the hook's owner knows
    // which deaths it caused; real client aborts still pin.
    let pinSuppressed = false;
    void terminateToHttp(
      flow.sock,
      forgeQueue,
      (req, res) => {
        const url = absoluteRequestUrl(req, 'https');
        const contentType = inferContentType(req.headers);
        // `sec-fetch-site` is the one initiator signal a proxy can see —
        // client-volunteered fetch metadata, tri-stated by inferThirdParty
        // (cross-site → true; same-site/same-origin/none → false — same-site
        // shares the registrable domain, first-party under ABP's reading;
        // else undefined).
        const thirdParty = inferThirdParty(req.headers);
        // The client-declared resource type and site relation may only
        // TIGHTEN a verdict, never relax it. `sec-fetch-dest`/`accept`/
        // `sec-fetch-site` are attacker-controlled bytes: evaluated alone,
        // a typed `@@||h^$image`-style exception under a fabricated
        // `dest: image` — or a `@@…$~third-party` exception under a
        // fabricated `site: same-origin` — would flip an untyped block into
        // an exception, the declared signal arming a suppression. So a
        // declared contentType OR thirdParty earns a second, untyped
        // evaluation: a block on EITHER wins, and when both block the typed
        // verdict stands — its coveringRule is the more specific match.
        // Only when neither blocks does the typed verdict govern the
        // ACTION — and even then its transform set is UNIONED with the
        // untyped pass's, because a `@@…$image,removeparam=x`-style
        // exception suppresses coverage only inside typed scope: the same
        // can't-relax invariant applied to rewrites, not just blocks.
        // Undeclared signals → one evaluation: untyped and typed are the
        // same run, so the double pass is skipped.
        const typed = flowEvaluator.evaluate(url, {
          method: req.method,
          contentType,
          thirdParty,
        });
        let verdict = typed;
        if (
          (contentType !== undefined || thirdParty !== undefined) &&
          typed.action !== 'blocked'
        ) {
          const untyped = flowEvaluator.evaluate(url, { method: req.method });
          if (untyped.action === 'blocked') {
            verdict = untyped;
          } else {
            // The typed exception semantics govern the action, but a
            // suppression that exists only in typed scope must not relax
            // what the untyped pass collected — union keeps both.
            verdict = {
              ...typed,
              transforms: unionRequestTransforms(untyped.transforms, typed.transforms),
            };
          }
        }
        if (verdict.action === 'blocked') {
          // Per-request unit — keep-alive flows carry many requests, so
          // this must not land in flowsBlocked (a flow counter) and inflate
          // blockRatePercent past 100.
          stats.requestsBlocked++;
          const headers: Record<string, string> = { 'content-length': '0' };
          if (verdict.coveringRule !== null) {
            headers['X-Blockingmachine-Rule'] = sanitizeHeaderValue(verdict.coveringRule);
          }
          res.respond(403, headers);
          return;
        }
        // allowed/exception both relay — request-side transforms (removeparam/
        // removeheader) run first. `transforms.csp` is a response-header
        // rewrite: it rides the `response` context into the relay, where the
        // response-head seam applies it (P2 Task 3) alongside the
        // content-type re-verdict and cosmetic injection.
        const transformed = applyRequestTransforms(
          req.url,
          req.headers,
          verdict.transforms,
        );
        relayRequest({ ...req, url: transformed.url, headers: transformed.headers }, res, upstream, {
          upstreamCaCerts: opts.upstreamCaCerts,
          connectTimeoutMs: opts.upstreamConnectTimeoutMs,
          responseTimeoutMs: opts.upstreamResponseTimeoutMs,
          response: {
            url,
            // The verdict-judged authority is the absolute URL's hostname —
            // absolute-form can override `Host`, and the port must come off
            // either way (the cosmetic index keys on bare hostnames).
            host: urlHost(url, req.host),
            method: req.method,
            verdict,
            requestContentType: contentType,
            cosmeticIndex: flowCosmeticIndex,
            injectionBudget,
            // The evaluator's (url, ctx) call adapted to the pipeline's
            // context-object signature — same URL/method, content-type from
            // the response's real media type, third-party from the request's
            // own `sec-fetch-site` (it can only tighten — the pipeline uses
            // a 'blocked' outcome only).
            evaluateTyped: (ctx) =>
              flowEvaluator.evaluate(ctx.url, {
                method: ctx.method,
                contentType: ctx.contentType,
                thirdParty,
              }),
            onEvent: onResponseEvent,
          },
        });
      },
      {
        head: flow.head,
        sni: flow.sni,
        onHandshakeAbort: () => {
          // The pinning signal — pin-check itself ran upstream of this seam;
          // there is no unlearn path out of a terminated flow. An abort the
          // engine caused (teardown, the forge failure this `.catch` cleans
          // up after) is suppressed above — it reads as client distrust but
          // is not, and a false pin is persistent.
          if (closing || pinSuppressed) {
            return;
          }
          policy.learnPin(flow.sni, 'handshake-abort');
          stats.pinsLearned++;
        },
      },
    ).catch(() => {
      // terminateToHttp threw before serving — a forge rejection, most of
      // all. Flag BEFORE destroying so the close this causes cannot learn a
      // pin: the socket's death is ours, whatever its listeners observe.
      pinSuppressed = true;
      flow.sock.destroy();
    });
  }

  /**
   * The dual-authority verdict both plain-HTTP entry points share (RFC 7230
   * §5.4): an absolute-form target disagreeing with the `Host` header gets
   * BOTH authorities evaluated — a block on either answers 403; two
   * individually-allowed names that disagree answer 400, since forwarding
   * the pair would smuggle one unjudged authority past the splice.
   */
  function plainHttpVerdict(
    parsed: PlainHttpTarget,
  ): { action: 'blocked'; rule: string | null } | { action: 'mismatch' } | { action: 'allowed' } {
    const verdict = evaluator.evaluate(parsed.url, { method: parsed.method });
    let hostRule: string | null = null;
    if (parsed.authorityMismatch && parsed.hostHeader !== null) {
      const hostVerdict = evaluator.evaluate(`http://${parsed.hostHeader}/`, {
        method: parsed.method,
      });
      if (hostVerdict.action === 'blocked') {
        hostRule = hostVerdict.coveringRule;
      }
    }
    if (verdict.action === 'blocked' || hostRule !== null) {
      // The request-target's covering rule leads when it blocked — it is
      // the authority the request line named — but a Host-only block still
      // emits its own rule, so a 403 always says which list decided it.
      return { action: 'blocked', rule: verdict.coveringRule ?? hostRule };
    }
    return parsed.authorityMismatch ? { action: 'mismatch' } : { action: 'allowed' };
  }

  /**
   * The bypass predicate both plain-HTTP entry points share: the
   * request-target host, and the Host header's host when it names a
   * different authority. A bypassed authority escapes judgment — the
   * verdict never runs and the flow tunnels like a pinned one would. Pins
   * are leaf-distrust learned on TLS handshakes — no leaf is ever served
   * on :80, so a pin cannot apply here.
   */
  function plainHttpAuthorityBypassed(parsed: PlainHttpTarget): boolean {
    const hostAuthority =
      parsed.hostHeader === null ? null : splitHostPort(parsed.hostHeader, 80);
    return (
      policy.isBypassed(parsed.host) ||
      (hostAuthority !== null && policy.isBypassed(hostAuthority.host))
    );
  }

  /**
   * Plain-HTTP forward (Review Focus #3): the request head is already
   * accumulated; parse the target, evaluate once, then splice the whole
   * buffered stream verbatim — headers and body untouched. The verdict is
   * per-connection here (a blind splice cannot re-evaluate pipelined
   * requests); per-request evaluation is the terminated path's job.
   */
  function handlePlainHttp(sock: net.Socket, buf: Buffer, peerLoopback: boolean): void {
    // `GET /ca.pem` (flag 129) + `GET /ca.mobileconfig` (iOS install) +
    // `GET /proxy.pac` (P7) — the read-only self-routes, exempt from auth
    // and the denylist alike: an unenrolled device / an OS PAC fetcher IS
    // the caller these exist for. Static files, never a control surface.
    const selfGet = parseSelfGetRequest(buf);
    if (selfGet !== null && SELF_GET_CA_PATHS.includes(selfGet.path)) {
      const body = Buffer.from(authority.caCertPem, 'utf8');
      sock.end(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/x-pem-file\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Connection: close\r\n\r\n' +
          authority.caCertPem,
      );
      return;
    }
    if (selfGet !== null && SELF_GET_CA_MOBILECONFIG_PATHS.includes(selfGet.path)) {
      // iOS's install surface — Safari turns this MIME into "Profile
      // Downloaded". The profile wraps the same CA PEM; fail closed (500)
      // rather than emit a half-written profile if it ever won't parse.
      const profile = buildCaMobileConfig(authority.caCertPem);
      if (profile === null) {
        sock.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        return;
      }
      const body = Buffer.from(profile, 'utf8');
      sock.end(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/x-apple-aspen-config\r\n' +
          'Content-Disposition: attachment; filename="blockingmachine-hub-ca.mobileconfig"\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Connection: close\r\n\r\n' +
          profile,
      );
      return;
    }
    if (selfGet?.path === '/proxy.pac') {
      // The authority the PAC emits is the one the client used to fetch it —
      // a LAN-hub PAC names the LAN address, a loopback fetch the loopback.
      // It is still client-supplied header bytes landing inside JavaScript
      // the OS proxy evaluator runs, so it must parse as a clean
      // host[:port] — anything else falls back to the bound listener
      // (consolidated-review N13: no quoting/whitespace/injection games in
      // FindProxyForURL's output).
      const requested = selfGet.authority;
      const requestedParts =
        requested !== null ? splitHostPort(requested, boundDataPort) : null;
      const authority =
        requested !== null &&
        requestedParts !== null &&
        requestedParts.port >= 1 &&
        requestedParts.port <= 65535 &&
        /^[a-z0-9.:%_-]+$/i.test(requestedParts.host)
          ? requested
          : `${bindHost}:${boundDataPort}`;
      const body = Buffer.from(buildPacFile(authority), 'utf8');
      // Headers as a latin1 write, then the Buffer verbatim — a latin1
      // round-trip inside one end(string) would re-encode ≥0x80 bytes as
      // two-byte UTF-8 and overrun Content-Length (strict clients see
      // HPE_CLOSED_CONNECTION on the em-dash in the PAC's comment header).
      sock.write(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/x-ns-proxy-autoconfig\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Connection: close\r\n\r\n',
        'latin1',
      );
      sock.end(body);
      return;
    }
    // Flag 127 token gate — ahead of the self-target refusal too: an
    // unauthenticated request earns 407 and learns nothing about the
    // listener's own ports.
    if (authToken !== undefined && !peerLoopback && !proxyAuthorizationOk(buf, authToken)) {
      stats.authRefusals++;
      sock.end(PROXY_AUTH_REQUIRED);
      return;
    }
    const parsed = parsePlainHttpTarget(buf);
    // Unparseable → 400. Absolute-form target disagreeing with the Host
    // header (RFC 7230 §5.4): evaluate BOTH authorities — a block on either
    // answers 403, otherwise the flow can't be forwarded without smuggling
    // one unjudged name past the splice → 400.
    if (parsed === null) {
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    // Self-target refusal ahead of everything — paused included, because
    // dumb transit is exactly what self-chains: `GET /` + `Host:
    // 127.0.0.1:<dataPort>` would tunnel back into this listener, each flow
    // spawning the next until fds run out, and a same-host web page can
    // drive it cross-origin (`fetch('http://127.0.0.1:9294/')` is a simple
    // request — no preflight, no origin wall on this listener).
    // M1: canonicalize the parsed host once so the guard, the bypass check
    // and the blind-tunnel dial all see the address getaddrinfo resolves —
    // `Host: 0177.0.0.1:<port>` cannot dress loopback in shorthand.
    parsed.host = canonicalizeIpLiteral(parsed.host);
    if (isSelfTarget(parsed.host, parsed.port)) {
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    // Flag 127 denylist: a LAN peer asking this listener to dial the
    // network's own private services gets a 403 — opted-in only, since a
    // single-user LAN hub legitimately proxies to its own LAN.
    if (denyPrivate && !peerLoopback && isPrivateDestinationHost(parsed.host)) {
      stats.flowsBlocked++;
      sock.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'X-Blockingmachine-Refused: private-destination\r\n' +
          'Content-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    // Paused: verdicts off — forward verbatim like the allowed path, including
    // the authority-mismatch guard (nothing is being judged anyway).
    if (paused) {
      blindTunnel(sock, parsed.host, parsed.port, buf);
      return;
    }
    // The same bypass gate the PROXY-v2 :80 path applies — a bypassed
    // authority must not be judged just because the client aimed the
    // request straight at the port instead of riding a helper redirect.
    if (plainHttpAuthorityBypassed(parsed)) {
      blindTunnel(sock, parsed.host, parsed.port, buf);
      return;
    }
    const judged = plainHttpVerdict(parsed);
    if (judged.action === 'blocked') {
      stats.flowsBlocked++;
      const rule =
        judged.rule === null
          ? ''
          : `\r\nX-Blockingmachine-Rule: ${sanitizeHeaderValue(judged.rule)}`;
      sock.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: 0${rule}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    if (judged.action === 'mismatch') {
      // Both authorities individually allow — but forwarding absolute-form
      // verbatim would still deliver a Host the splice never re-checks.
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    blindTunnel(sock, parsed.host, parsed.port, buf);
  }

  /**
   * PROXY-v2 non-TLS verdict (flag 93): helpers redirect :80 flows too, so a
   * peeked head that is not TLS may still be a judgeable HTTP request — the
   * transparent-:80 gap this closes. A parseable request takes the same
   * dual-authority verdict handlePlainHttp applies; a paused proxy or a
   * bypassed authority stays dumb transit, and an unparseable head tunnels
   * verbatim exactly as before. The upstream dial is always the v2-announced
   * destination — the parsed authorities only feed the verdict, never the
   * dial (the client already told us where its bytes were headed).
   */
  function handleTransparentPlainHttp(
    sock: net.Socket,
    target: { dstHost: string; dstPort: number },
    head: Buffer,
  ): void {
    // A pause landing mid-peek owns this flow — verdicts off, dumb transit.
    if (paused) {
      blindTunnel(sock, target.dstHost, target.dstPort, head);
      return;
    }
    // Only a COMPLETE request head gets judged — the dispatch path waits
    // for \r\n\r\n before parsing, and judging a torn head could turn a
    // truncated Host line into a false authority verdict. 'no' can never
    // be an HTTP request; a partial head tunnels as before.
    if (probePlainHttp(head) === 'no' || !head.includes('\r\n\r\n')) {
      blindTunnel(sock, target.dstHost, target.dstPort, head);
      return;
    }
    const parsed = parsePlainHttpTarget(head);
    if (parsed === null) {
      blindTunnel(sock, target.dstHost, target.dstPort, head);
      return;
    }
    // A bypassed authority escapes judgment — the shared gate covers the
    // request-target host and a disagreeing Host header alike. Pins stay
    // unconsulted: no leaf is ever served on :80, so leaf-distrust cannot
    // apply here.
    if (plainHttpAuthorityBypassed(parsed)) {
      blindTunnel(sock, target.dstHost, target.dstPort, head);
      return;
    }
    const judged = plainHttpVerdict(parsed);
    if (judged.action === 'blocked') {
      stats.flowsBlocked++;
      const rule =
        judged.rule === null
          ? ''
          : `\r\nX-Blockingmachine-Rule: ${sanitizeHeaderValue(judged.rule)}`;
      sock.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: 0${rule}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    if (judged.action === 'mismatch') {
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    blindTunnel(sock, target.dstHost, target.dstPort, head);
  }

  /**
   * Explicit forward proxy: verdict on the CONNECT authority, then — for
   * allowed non-passthrough hosts — a bounded peek at what follows the 200.
   */
  async function handleConnect(
    sock: net.Socket,
    requestHead: Buffer,
    rest: Buffer,
    peerLoopback: boolean,
  ): Promise<void> {
    // Flag 127 token gate FIRST — before the authority parse: a refused
    // request must not leak which targets were valid, and must never hang.
    if (
      authToken !== undefined &&
      !peerLoopback &&
      !proxyAuthorizationOk(requestHead, authToken)
    ) {
      stats.authRefusals++;
      sock.end(PROXY_AUTH_REQUIRED);
      return;
    }
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
    // M1: the CONNECT authority dials through getaddrinfo, which accepts
    // the BSD shorthand `isIP` rejects — canonicalize once so the
    // self-target refusal, the denylist, the literal-IP shortcut and the
    // verdict all judge the same address the wire resolves.
    const host = canonicalizeIpLiteral(target.host);
    const port = target.port;
    // The same self-target refusal the plain-HTTP path has: a tunnel to our
    // own listener re-dispatches the spliced bytes and chains flows (the
    // CONNECT flavor is technically self-limiting — the inner flow would
    // terminate and its upstream verify fail — but only after paying
    // accept+dial per level). 400, and dial nothing.
    if (isSelfTarget(host, port)) {
      sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    // Flag 127 denylist — the CONNECT twin of the plain-HTTP check.
    if (denyPrivate && !peerLoopback && isPrivateDestinationHost(host)) {
      stats.flowsBlocked++;
      sock.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'X-Blockingmachine-Refused: private-destination\r\n' +
          'Content-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }

    // A literal IP never carries SNI — nothing to evaluate or peek (Review
    // Focus #1); pinned/bypassed hosts are the policy store's blind-tunnel
    // predicate, honored before any verdict; a paused proxy tunnels
    // everything — protection off, connectivity never breaks. Note this
    // tunnels on the CONNECT *authority* alone — a flow whose peeked
    // ClientHello later names a different (blocked) SNI still rides this
    // splice; per spec's fail-open posture that recheck gap is accepted for
    // P0 and recorded for P1.
    if (paused || isIP(host) !== 0 || policy.isPinned(host) || policy.isBypassed(host)) {
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
    const peeked = await collectClientHello(sock, peekTimeoutMs, rest);
    if (!peeked.isTls) {
      // A mid-peek pause still owns this flow: splice whatever arrived to the
      // CONNECT target — a paused proxy is dumb transit, never a verdict.
      if (paused) {
        blindTunnel(sock, host, port, peeked.head);
        return;
      }
      sock.destroy();
      return;
    }
    // Mid-peek pause — the same re-check handleTransparent performs: a toggle
    // landing inside the collectClientHello window must splice blind, not
    // reach terminateFlow. No forge while protection is off.
    if (paused) {
      blindTunnel(sock, host, port, peeked.head);
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
    // Termination seam: the leaf name is the announced SNI when there is one,
    // else the CONNECT authority. `forgeLeaf` throws on invalid/absent names,
    // so anything that fails `isValidSni` keeps the blind tunnel it had.
    const leafName = peeked.sni !== null ? normalizeSni(peeked.sni) : host.toLowerCase();
    if (!isValidSni(leafName)) {
      blindTunnel(sock, host, port, peeked.head);
      return;
    }
    terminateFlow({
      sock,
      head: peeked.head,
      sni: leafName,
      upstream: { host, port, servername: leafName },
    });
  }

  /**
   * Transparent flow: PROXY-v2 gives `target`; a spliced flow without the
   * header passes null — a valid announced SNI still terminates (upstream is
   * `sni:443`, the only destination the wire announces); anything else has
   * nowhere to go and closes honestly.
   */
  async function handleTransparent(
    sock: net.Socket,
    target: ProxyV2Target | null,
    rest: Buffer,
    peerLoopback: boolean,
  ): Promise<void> {
    // Flag 127 token gate: a configured token requires the pinned `0xE0`
    // TLV on the v2 frame (target === null is the headerless-splice path —
    // it has no in-band auth transport at all, so a non-loopback peer gets
    // refused outright). Raw TLS carries no 407 — the prompt close IS the
    // refusal, and it happens before the ClientHello peek so an
    // unauthenticated client can never park the socket on a byte deadline.
    if (authToken !== undefined && !peerLoopback) {
      const presented =
        target !== null &&
        target.authToken !== undefined &&
        tokenEquals(target.authToken, authToken);
      if (!presented) {
        stats.authRefusals++;
        sock.destroy();
        return;
      }
    }
    // A PROXY-v2 destination is still client-supplied bytes — the v2 magic
    // is a wire prefix any local process can write — so the self-target
    // refusal applies before the paused shortcut too. Raw TLS has no honest
    // 400 to send; the close is the answer.
    // M1: the announced dstHost is canonicalized before every guard and dial
    // — a helper spelling it `127.1` cannot smuggle loopback past the checks
    // while getaddrinfo resolves it back.
    if (target !== null) {
      target.dstHost = canonicalizeIpLiteral(target.dstHost);
    }
    if (target !== null && isSelfTarget(target.dstHost, target.dstPort)) {
      sock.destroy();
      return;
    }
    // Flag 127 denylist — the PROXY-v2 twin: the frame's announced
    // destination is the dial target the same way CONNECT's authority is.
    if (
      denyPrivate &&
      !peerLoopback &&
      target !== null &&
      isPrivateDestinationHost(target.dstHost)
    ) {
      stats.flowsBlocked++;
      sock.destroy();
      return;
    }
    // Paused: protection off — splice to the announced destination untouched.
    // A PROXY-v2 frame carries it; skip the peek entirely and replay the
    // dispatch buffer verbatim.
    if (paused && target !== null) {
      blindTunnel(sock, target.dstHost, target.dstPort, rest);
      return;
    }
    const peeked = await collectClientHello(sock, peekTimeoutMs, rest);
    // Non-TLS bytes: with an announced destination a parseable HTTP request
    // takes the same verdict the dispatch path applies (helpers redirect :80
    // too — flag 93); anything else forwards honestly. No header means no
    // destination and nothing to judge against — honest close.
    if (!peeked.isTls) {
      if (target === null) {
        sock.destroy();
        return;
      }
      handleTransparentPlainHttp(sock, target, peeked.head);
      return;
    }
    const sni = peeked.sni;

    // Mid-peek pause: prefer the PROXY-v2 announced destination when one
    // exists — a redirected flow must reach its real endpoint, not a guess at
    // sni:443. The SNI fallback covers only the headerless splice.
    if (paused) {
      if (target !== null) {
        blindTunnel(sock, target.dstHost, target.dstPort, peeked.head);
        return;
      }
      const normalized = sni !== null ? normalizeSni(sni) : null;
      if (normalized !== null && isValidSni(normalized)) {
        // N16: an SNI-derived destination is client-supplied too — the
        // denylist applies to it the same way it did to the v2 dstHost, even
        // while paused (a pause relaxes verdicts, never the SSRF guard).
        if (denyPrivate && !peerLoopback && isPrivateDestinationHost(normalized)) {
          stats.flowsBlocked++;
          sock.destroy();
        } else {
          blindTunnel(sock, normalized, 443, peeked.head);
        }
      } else {
        sock.destroy();
      }
      return;
    }

    // The verdict runs on the *normalized* name whenever one was announced —
    // validity is not a gate: `blocked.com.` must drop, and pinned/bypassed
    // checks apply to the name rules and users actually write. Only an
    // absent SNI skips judgment entirely.
    if (sni !== null) {
      const normalized = normalizeSni(sni);
      // N16: on the headerless-splice path the SNI IS the destination —
      // terminateFlow dials `sni:443` — so the denylist must judge it the
      // same way it judged the v2 dstHost above. When a v2 destination
      // exists the SNI is only a leaf name: the dial target was already
      // checked and a pinned/bypassed or private spelling changes nothing
      // the socket connects to.
      if (denyPrivate && !peerLoopback && target === null && isPrivateDestinationHost(normalized)) {
        stats.flowsBlocked++;
        sock.destroy();
        return;
      }
      if (policy.isPinned(normalized) || policy.isBypassed(normalized)) {
        if (target === null) {
          sock.destroy();
        } else {
          blindTunnel(sock, target.dstHost, target.dstPort, peeked.head);
        }
        return;
      }
      if (evaluator.evaluate(`https://${normalized}/`).action === 'blocked') {
        stats.flowsBlocked++;
        // No response exists on raw TLS — the close itself is the verdict.
        sock.destroy();
        return;
      }
      // Termination seam — gated on isValidSni: `forgeLeaf` throws on
      // invalid/absent names, and those keep the blind tunnel (or the honest
      // close when no destination was ever announced).
      if (isValidSni(normalized)) {
        const upstream: UpstreamEndpoint =
          target === null
            ? { host: normalized, port: 443, servername: normalized }
            : { host: target.dstHost, port: target.dstPort, servername: normalized };
        terminateFlow({ sock, head: peeked.head, sni: normalized, upstream });
        return;
      }
    }

    if (target === null) {
      // Head cannot be replayed anywhere — no destination was announced.
      sock.destroy();
      return;
    }
    blindTunnel(sock, target.dstHost, target.dstPort, peeked.head);
  }

  /**
   * Accepted-socket dispatch: accumulate until the opening bytes decide, with
   * a hard deadline so silence can never hang a socket. Buffer handoff keeps
   * `rest` (bytes already read past the dispatch point) for the next stage.
   */
  function onConnection(sock: net.Socket): void {
    track(sock);
    stats.flowsTotal++;
    // Flag 127: the peer's loopback-ness is decided once, at accept —
    // remoteAddress is fixed for the socket's life, and both flag gates
    // (the token requirement and the destination denylist) exempt loopback
    // peers because the local capture helper is the trust anchor.
    const peerLoopback = isLoopbackPeer(sock.remoteAddress);
    const chunks: Buffer[] = [];
    let mode: 'dispatch' | 'connect' | 'proxy2' | 'http' = 'dispatch';

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
          // Not CONNECT/PROXY-v2/TLS — maybe plain HTTP (Review Focus #3).
          // 'possible' stays in dispatch until the request line decides;
          // 'no' closes immediately so garbage still dies promptly. 'yes'
          // falls through into the http branch below on this same buffer —
          // the whole head may already have arrived in one chunk.
          const probe = probePlainHttp(buf);
          if (probe === 'no') {
            handOff(() => sock.destroy());
            return;
          }
          if (probe === 'possible') {
            return;
          }
          mode = 'http';
        } else if (cls === 'tls') {
          handOff(() => {
            void handleTransparent(sock, null, buf, peerLoopback).catch(() => sock.destroy());
          });
          return;
        } else {
          mode = cls;
        }
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
          void handleTransparent(sock, target, rest, peerLoopback).catch(() => sock.destroy());
        });
        return;
      }
      if (mode === 'http') {
        const end = buf.indexOf(HEADER_END);
        if (end < 0) {
          if (buf.length > CONNECT_HEADER_LIMIT) {
            handOff(() => sock.destroy());
          }
          return;
        }
        handOff(() => handlePlainHttp(sock, buf, peerLoopback));
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
          void handleConnect(sock, requestHead, rest, peerLoopback).catch(() => sock.destroy());
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
      boundDataPort = port;
      resolve({
        port,
        stats: () => ({ ...stats }),
        reload(rawRules: string[], newCosmeticIndex?: CosmeticIndex) {
          // Rebuild off the hot path, then swap — in-flight flows finish on
          // the evaluator and cosmetic index they started with.
          evaluator = createRequestEvaluator(rawRules);
          if (newCosmeticIndex !== undefined) {
            cosmeticIndex = newCosmeticIndex;
            // The stats half of the index swap — same contract as
            // rulesSize: the surface must name the ruleset now live,
            // not the one that booted.
            stats.cosmetic = newCosmeticIndex.size();
          }
          stats.rulesSize = evaluator.size;
        },
        setPaused(next: boolean) {
          paused = next;
        },
        isPaused: () => paused,
        async close() {
          // Flag first: the destroys below fire 'close' on sockets that may
          // be parked in the forge wait or mid-handshake — a death before
          // `secureConnection` is the pinning signal, and teardown must not
          // mint persistent false pins on its way down.
          closing = true;
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

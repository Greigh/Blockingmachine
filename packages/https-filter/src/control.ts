/**
 * Control API — the `/v1/proxy/*` surface on `127.0.0.1:9293` (design spec
 * §5.7, plan Task 7).
 *
 * The browser-boundary posture mirrors the system daemon's control server
 * (`packages/system-daemon/src/index.ts`) verbatim — a loopback port's real
 * adversary is a web page on the same machine, not a LAN host:
 *
 *  - ACAO `*` with `Access-Control-Allow-Methods: GET, OPTIONS` — the
 *    preflight deliberately never offers POST, so a cross-origin page cannot
 *    carry a JSON content type to a mutation route.
 *  - Origin/Referer allowlist: no-Origin native callers (daemonManager,
 *    curl) are trusted; browser origins must be loopback (`localhost`,
 *    `127.0.0.1`) or extension schemes (`chrome-extension:`,
 *    `moz-extension:`). `.local` is deliberately NOT trusted — any LAN
 *    device can claim an mDNS name.
 *  - Every POST requires `Content-Type: application/json` → 415 otherwise;
 *    a browser's only cross-origin JSON route preflights into the refusal
 *    above.
 *  - Unknown path → 404; a known path under a wrong method → 405 (+Allow).
 *
 * The envelope follows the daemon: reads return bare objects, mutations
 * return `{success:true, …}`, failures `{success:false, error}` (404/400 use
 * the daemon's `{error}` shape). Payloads carry hostnames, counts, and rule
 * text only — never bodies, headers, or query strings (the learned-shadow
 * privacy convention).
 */

import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import type { CertAuthority } from './ca/certAuthority.js';
import {
  normalizeHost,
  POLICY_HOST_MAX_LENGTH,
  type PolicyEntry,
  type PolicyStore,
} from './policy/policyStore.js';
import type { RunningProxy } from './proxy/filterProxy.js';

export interface ControlApiDeps {
  /**
   * Always loopback — this must never follow a non-loopback data bind
   * (see `FilterProxyConfig.bindHost` in index.ts): the origin guard only
   * filters browser callers, and no-Origin clients are trusted by design.
   */
  bindHost: string;
  controlPort: number;
  proxy: RunningProxy;
  authority: CertAuthority;
  policy: PolicyStore;
  /**
   * Re-reads the rules file and hot-swaps the proxy's evaluator; resolves to
   * the live rule count (`proxy.stats().rulesSize`). Throws when no rules
   * source is configured or the read fails — the route answers 500.
   */
  reloadRules: () => Promise<number>;
  /**
   * True when `PolicyStore.open` failed and the store fell back to
   * ephemeral — surfaced in status/stats so the degraded state is visible
   * rather than logged once and forgotten.
   */
  policyDegraded: boolean;
  /**
   * Invoked (deferred — the reply flushes first) by POST /v1/proxy/shutdown.
   * `startFilterProxy` wires the engine's own close() here; the spawned
   * entry (main.ts) substitutes its signal-path shutdown so the process
   * exits too. Same trust model as /v1/proxy/toggle: ANY loopback caller
   * can stop the engine — including the launchd capture instance, for which
   * `launchctl bootout` is the honest verb but this answers the same way
   * (KeepAlive relaunches it). Deliberate, and documented in the route.
   */
  shutdown: () => void;
}

export interface RunningControl {
  server: http.Server;
  /** The bound port — `controlPort: 0` resolves to the ephemeral pick. */
  port: number;
}

/** POST bodies are small JSON documents — past 1MB is hostile (daemon parity). */
const BODY_LIMIT = 1e6;

/**
 * A bypass `reason` lands verbatim on a permanent ledger line — it is a
 * short operator note like 'handshake-abort', not a document.
 */
const MAX_REASON_LENGTH = 200;

const ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  '/v1/proxy/status': new Set(['GET']),
  '/v1/proxy/stats': new Set(['GET']),
  '/v1/proxy/ca': new Set(['GET']),
  '/v1/proxy/ca/rotate': new Set(['POST']),
  '/v1/proxy/pins': new Set(['GET']),
  '/v1/proxy/pins/bypass': new Set(['POST']),
  '/v1/proxy/pins/remove': new Set(['POST']),
  '/v1/proxy/reload': new Set(['POST']),
  '/v1/proxy/shutdown': new Set(['POST']),
  '/v1/proxy/toggle': new Set(['POST']),
};

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startControlServer(deps: ControlApiDeps): Promise<RunningControl> {
  const { proxy, authority, policy } = deps;
  const startedAt = Date.now();
  // Resolved at listen time — `controlPort: 0` reports the ephemeral pick.
  let boundPort = deps.controlPort;

  /** The CA identity block — shared by GET /v1/proxy/ca and the rotate reply. */
  const caInfo = () => {
    const certPem = authority.caCertPem;
    const x509 = new X509Certificate(certPem);
    return {
      certPem,
      // Colon-paired uppercase hex of sha256(DER) — openssl's
      // `x509 -fingerprint -sha256` rendering.
      sha256Fingerprint: x509.fingerprint256,
      notAfter: x509.validTo,
      // At-rest posture of the CA private key — false means legacy 0600
      // plaintext (no OS backend available).
      keyWrapped: authority.keyWrapped,
      keyWrapBackend: authority.keyWrapBackend,
    };
  };

  /**
   * The appended ledger line a mutation just wrote — chain internals stay
   * stripped (list() shape). `null` rather than the wrong entry when the
   * store's fail-soft append left the journal unwritten: the live sets still
   * applied, so `pinned`/`bypassed` in the reply stay honest either way.
   */
  const lastEntry = (host: string, action: 'bypass' | 'remove'): PolicyEntry | null => {
    // listPolicy, not list: `proxy_event` audit lines sit in the same journal
    // but are not mutations — a response-pipeline event landing after a
    // bypass must not shadow the mutation this reply is supposed to echo.
    const entries = policy.listPolicy();
    const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
    return last !== undefined && last.host === host && last.action === action ? last : null;
  };

  /**
   * The `{host, reason?}` body the pins mutations share. Host validation
   * delegates to the store's own normalization — the same trim+lowercase a
   * learned pin or a ledger replay applies — and its hostname bound, so a
   * name the store would refuse never reaches it. `reason` is optional but,
   * when present, must be a short string: it lands verbatim on a permanent
   * ledger line, so a type error or a megabyte payload is a 400, not a
   * journal entry. Answers the request and returns null on any failure.
   */
  const readPinMutation = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<{ host: string; reason?: string } | null> => {
    let body = '';
    try {
      body = await readBody(req);
    } catch {
      // Oversize — readBody already destroyed the request; mirror toggle.
      res.destroy();
      return null;
    }
    let parsed: unknown;
    try {
      parsed = body === '' ? {} : JSON.parse(body);
    } catch {
      json(res, 400, { success: false, error: 'Bad Request: body must be a JSON object' });
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { success: false, error: 'Bad Request: body must be a JSON object' });
      return null;
    }
    const payload = parsed as Record<string, unknown>;
    const host = typeof payload.host === 'string' ? normalizeHost(payload.host) : '';
    if (host === '' || host.length > POLICY_HOST_MAX_LENGTH) {
      json(res, 400, {
        success: false,
        error: `host must be a non-empty hostname of at most ${POLICY_HOST_MAX_LENGTH} characters`,
      });
      return null;
    }
    if (payload.reason !== undefined) {
      if (typeof payload.reason !== 'string' || payload.reason.length > MAX_REASON_LENGTH) {
        json(res, 400, {
          success: false,
          error: `reason must be a string of at most ${MAX_REASON_LENGTH} characters`,
        });
        return null;
      }
      return { host, reason: payload.reason };
    }
    return { host };
  };

  const server = http.createServer(async (req, res) => {
    // CORS headers for local control & dashboard access. POST is deliberately
    // absent from the preflight: a cross-origin page cannot carry a JSON
    // content type without preflighting, and this preflight now refuses it.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url || '/', `http://${deps.bindHost}:${deps.controlPort}`).pathname;
    } catch {
      json(res, 400, { error: 'Bad Request: Malformed URL' });
      return;
    }

    const originHeader =
      req.headers.origin ||
      (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
    // No-Origin native callers (daemonManager, curl) are trusted; browser
    // origins must be loopback or an extension scheme. `.local` is
    // deliberately NOT trusted — any LAN device can claim an mDNS name, and a
    // page served from one can reach this loopback port from the same browser.
    const isSafeOrigin = (): boolean => {
      if (!originHeader) return true;
      try {
        const u = new URL(originHeader);
        return (
          u.hostname === 'localhost' ||
          u.hostname === '127.0.0.1' ||
          u.protocol === 'chrome-extension:' ||
          u.protocol === 'moz-extension:'
        );
      } catch {
        return false;
      }
    };

    // Stats carry flow counters and the pin ledger carries hostnames — with
    // ACAO:* an arbitrary same-host web page could read them.
    if (!isSafeOrigin()) {
      json(res, 403, { success: false, error: 'Forbidden' });
      return;
    }

    // Every POST route consumes a JSON body (or none at all). A browser can
    // only send application/json cross-origin through a preflight this server
    // refuses — so this is the second wall against text/plain simple-request
    // drive-bys alongside the origin check above.
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        json(res, 415, {
          success: false,
          error: 'Unsupported Media Type — POST endpoints require Content-Type: application/json',
        });
        return;
      }
    }

    const allowedMethods = ROUTES[pathname];
    if (allowedMethods === undefined) {
      json(res, 404, { error: 'Not Found' });
      return;
    }
    if (!allowedMethods.has(req.method ?? '')) {
      res.setHeader('Allow', [...allowedMethods].join(', '));
      json(res, 405, { success: false, error: 'Method Not Allowed' });
      return;
    }

    try {
      switch (pathname) {
        case '/v1/proxy/status': {
          const stats = proxy.stats();
          const paused = proxy.isPaused();
          json(res, 200, {
            status: paused ? 'paused' : 'running',
            dataPort: proxy.port,
            controlPort: boundPort,
            protectionEnabled: !paused,
            paused,
            policyDegraded: deps.policyDegraded,
            rulesLoaded: stats.rulesSize,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            corruptLineCount: policy.corruptLineCount,
            stats: {
              ...stats,
              blockRatePercent:
                stats.flowsTotal > 0
                  ? Math.round((stats.flowsBlocked / stats.flowsTotal) * 1000) / 10
                  : 0,
            },
          });
          return;
        }

        case '/v1/proxy/stats': {
          json(res, 200, {
            ...proxy.stats(),
            paused: proxy.isPaused(),
            corruptLineCount: policy.corruptLineCount,
            policyDegraded: deps.policyDegraded,
          });
          return;
        }

        case '/v1/proxy/ca': {
          json(res, 200, caInfo());
          return;
        }

        case '/v1/proxy/ca/rotate': {
          req.resume(); // the body is ignored — drain it for keep-alive
          // rotate() persists before swapping — a failed write leaves the
          // previous (working) CA live, so a throw here is honest.
          await authority.rotate();
          json(res, 200, { success: true, ...caInfo() });
          return;
        }

        case '/v1/proxy/pins': {
          // `proxy_event` audit lines share the journal but are not policy —
          // the pins contract stays `pin`/`bypass`/`remove` only.
          json(res, 200, {
            pins: policy.listPolicy(),
            corruptLineCount: policy.corruptLineCount,
          });
          return;
        }

        // User-directed bypass (spec §5.6, flags 95/98): tunnels `host`
        // without a verdict — the same blind-tunnel predicate auto-learned
        // pins take — and lands a chained 'bypass' line in the ledger.
        case '/v1/proxy/pins/bypass': {
          const mutation = await readPinMutation(req, res);
          if (mutation === null) {
            return;
          }
          policy.addBypass(mutation.host, mutation.reason);
          json(res, 200, {
            success: true,
            host: mutation.host,
            pinned: policy.isPinned(mutation.host),
            bypassed: policy.isBypassed(mutation.host),
            entry: lastEntry(mutation.host, 'bypass'),
          });
          return;
        }

        // Retract whatever policy covers `host` — learned pin or bypass;
        // `PolicyStore.remove` clears both sets and appends a chained
        // 'remove' line so later lines can re-pin cleanly on replay.
        case '/v1/proxy/pins/remove': {
          const mutation = await readPinMutation(req, res);
          if (mutation === null) {
            return;
          }
          policy.remove(mutation.host, mutation.reason);
          json(res, 200, {
            success: true,
            host: mutation.host,
            pinned: policy.isPinned(mutation.host),
            bypassed: policy.isBypassed(mutation.host),
            entry: lastEntry(mutation.host, 'remove'),
          });
          return;
        }

        case '/v1/proxy/reload': {
          req.resume(); // body ignored — the rules source is the file, not the request
          const loadedCount = await deps.reloadRules();
          json(res, 200, {
            success: true,
            message: `Reloaded ${loadedCount} rules`,
            rulesLoaded: loadedCount,
            rulesSize: loadedCount,
          });
          return;
        }

        // Graceful remote shutdown — the route the app's FilterProxyManager
        // uses to retire an orphaned user-context engine (one it never
        // spawned and cannot kill). Same trust model as toggle: a loopback
        // caller can stop protection, so a loopback caller can stop the
        // process — the launchd capture engine answers it too, for which
        // launchd's bootout (or KeepAlive) is the governing verb.
        case '/v1/proxy/shutdown': {
          req.resume(); // the body is ignored — drain it for keep-alive
          json(res, 200, { success: true, message: 'shutting down' });
          // Never run the teardown inside the response path: close() calls
          // server.closeAllConnections(), which would destroy THIS socket
          // before the reply reached the caller. A short deferral lets the
          // kernel hand the bytes over first.
          setTimeout(() => {
            try {
              deps.shutdown();
            } catch {
              // A teardown failure has nowhere honest to report to — the
              // reply already left. The caller's own close remains valid.
            }
          }, 25);
          return;
        }

        case '/v1/proxy/toggle': {
          let body = '';
          try {
            body = await readBody(req);
          } catch {
            res.destroy();
            return;
          }
          // Daemon parity: an absent/unparseable body flips the current state;
          // an explicit boolean wins.
          let enable = proxy.isPaused();
          try {
            if (body) {
              const parsed = JSON.parse(body);
              if (typeof parsed.enabled === 'boolean') {
                enable = parsed.enabled;
              }
            }
          } catch {
            // ignore JSON parse error, toggle instead
          }
          proxy.setPaused(!enable);
          json(res, 200, { success: true, protectionEnabled: enable, paused: !enable });
          return;
        }
      }
    } catch (err) {
      json(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : 'internal error',
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.controlPort, deps.bindHost, () => {
      const address = server.address();
      boundPort =
        typeof address === 'object' && address !== null ? address.port : deps.controlPort;
      resolve({ server, port: boundPort });
    });
  });
}

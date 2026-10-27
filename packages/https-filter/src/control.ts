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
import type { PolicyStore } from './policy/policyStore.js';
import type { RunningProxy } from './proxy/filterProxy.js';

export interface ControlApiDeps {
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
}

export interface RunningControl {
  server: http.Server;
  /** The bound port — `controlPort: 0` resolves to the ephemeral pick. */
  port: number;
}

/** POST bodies are small JSON documents — past 1MB is hostile (daemon parity). */
const BODY_LIMIT = 1e6;

const ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  '/v1/proxy/status': new Set(['GET']),
  '/v1/proxy/stats': new Set(['GET']),
  '/v1/proxy/ca': new Set(['GET']),
  '/v1/proxy/ca/rotate': new Set(['POST']),
  '/v1/proxy/pins': new Set(['GET']),
  '/v1/proxy/reload': new Set(['POST']),
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
    };
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
          json(res, 200, { pins: policy.list(), corruptLineCount: policy.corruptLineCount });
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

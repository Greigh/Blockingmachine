/**
 * Spawnable engine entry — the file two launchers run as a plain Node script:
 *
 *  - electron-app's `filterProxyManager.start()` spawns it under
 *    `ELECTRON_RUN_AS_NODE` as the user-context engine (CONNECT/dev/no-capture
 *    posture — the default before capture is installed, and permanently on
 *    non-darwin), bundled as `.webpack/main/filterProxy.cjs`.
 *  - The macOS capture service's launchd plist (`com.blockingmachine.proxy`,
 *    P1 Task 3) runs this same file as `_blockingmachine` — the dedicated user
 *    the pf anchor's `user != _blockingmachine` route-to rules carve out of
 *    capture (pf allows user matching on filter rules only — the exemption
 *    cannot live on the rdr rules themselves).
 *
 * Configuration is env-only so neither launcher needs argv plumbing:
 *
 *   BM_STORE_DIR     required — CA + policy-ledger root (engine exits 2 without it)
 *   BM_RULES_PATH    optional — compiled request-rules file the evaluator loads
 *                    at boot and `/v1/proxy/reload` re-reads; unset starts empty
 *   BM_DATA_PORT     CONNECT/PROXY-v2/plain-HTTP listener (default 9294)
 *   BM_CONTROL_PORT  /v1/proxy/* listener (default 9293) — carries
 *                    POST /v1/proxy/shutdown, which retires the engine
 *                    through the same close+exit path the signals take
 *   BM_BIND_HOST     bind host for the DATA listener only (default
 *                    127.0.0.1) — a LAN address here is the P4 hub posture:
 *                    the data port then accepts flows from the network
 *                    (unauthenticated — trusted-LAN deployments only). It
 *                    can never drag the control API along: /v1/proxy/* is
 *                    loopback by construction, not by convention.
 *   BM_CONTROL_BIND_HOST  control listener bind (default 127.0.0.1) — must
 *                    be a loopback address; anything else is refused at
 *                    config time, because a LAN-exposed control port would
 *                    let the network pause protection, rotate the CA, or
 *                    unpin hosts. Exists for loopback-family variation
 *                    (::1, another 127.x alias), never for LAN exposure.
 *   BM_KEYWRAP       CA key-wrap backend pin — 'off'/'none'/'0' forces
 *                    `keyWrapBackend: null` (0600 `ca.key.pem`, `keyWrapped:
 *                    false`, zero OS-keystore contact); unset or any other
 *                    value auto-resolves the platform keystore. Test/dev
 *                    rigs that must never touch a real keychain set 'off'.
 *
 * Garbage port values fall back to the defaults rather than binding a surprise
 * port. One stderr line announces the bound ports on success — that line is how
 * the spawning parent learns the engine came up, so it carries addresses only,
 * never payload data. A startup failure (bind conflict, corrupt CA keystore)
 * exits 1; only a config refusal (missing BM_STORE_DIR) exits 2.
 */

import {
  isLoopbackBindHost,
  startFilterProxy,
  type FilterProxyConfig,
  type RunningFilterProxy,
} from './index.js';

const TAG = '[https-filter]';

function stderrLine(message: string): void {
  process.stderr.write(`${TAG} ${message}\n`);
}

export interface SpawnedProxyConfig {
  storeDir: string;
  rulesPath?: string;
  /** DATA listener bind — `BM_BIND_HOST`; a LAN address is the hub posture. */
  bindHost: string;
  /** CONTROL listener bind — `BM_CONTROL_BIND_HOST`; loopback only, enforced. */
  controlBindHost: string;
  dataPort: number;
  controlPort: number;
  /**
   * `null` pins key-wrap off (BM_KEYWRAP=off|none|0); absent auto-resolves
   * the OS keystore. Env can only express the pin — callers that need a
   * bespoke backend construct `FilterProxyConfig` directly.
   */
  keyWrapBackend?: null;
}

export type EnvParse = { ok: true; config: SpawnedProxyConfig } | { ok: false; error: string };

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_DATA_PORT = 9294;
const DEFAULT_CONTROL_PORT = 9293;

/**
 * `parseInt` alone turns '9293junk' into 9293 and 'junk' into NaN — the first
 * silently binds a port the operator never picked, the second crashes listen.
 * `Number()` is no better: it accepts '0x10', '+443' and '4e2'. Same idiom as
 * the CONNECT authority parser — decimal digits only, then the range check;
 * anything else takes `fallback`.
 */
function envPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const parsed = Number(text);
  return parsed <= 65535 ? parsed : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv): EnvParse {
  const storeDir = env.BM_STORE_DIR?.trim();
  if (!storeDir) {
    return { ok: false, error: 'BM_STORE_DIR is required — the engine has nowhere to keep its CA and policy ledger' };
  }
  const rulesPath = env.BM_RULES_PATH?.trim();
  const bindHost = env.BM_BIND_HOST?.trim();
  const controlBindHost = env.BM_CONTROL_BIND_HOST?.trim();
  // The control bind is refused at CONFIG time, not left for the listen to
  // fail: a non-loopback value is the one posture this surface must never
  // take (mutations unauthenticated on the network), so the refusal names
  // the env var rather than surfacing as a generic bind error.
  if (controlBindHost && !isLoopbackBindHost(controlBindHost)) {
    return {
      ok: false,
      error:
        `BM_CONTROL_BIND_HOST must be a loopback address (got '${controlBindHost}') — ` +
        `the /v1/proxy/* API is loopback by construction; BM_BIND_HOST covers the data listener only`,
    };
  }
  const keyWrap = env.BM_KEYWRAP?.trim().toLowerCase();
  return {
    ok: true,
    config: {
      storeDir,
      ...(rulesPath ? { rulesPath } : {}),
      bindHost: bindHost || DEFAULT_BIND_HOST,
      controlBindHost: controlBindHost || DEFAULT_BIND_HOST,
      dataPort: envPort(env.BM_DATA_PORT, DEFAULT_DATA_PORT),
      controlPort: envPort(env.BM_CONTROL_PORT, DEFAULT_CONTROL_PORT),
      ...(keyWrap === 'off' || keyWrap === 'none' || keyWrap === '0'
        ? { keyWrapBackend: null }
        : {}),
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderrLine(`fatal: ${parsed.error}`);
    process.exit(2);
  }
  // `running`/`shutdown` are declared before startFilterProxy so the config
  // can hand the control API's shutdown route the same close+exit path the
  // signals take — the route can only fire once the control port listens,
  // which is after `running` is assigned.
  let running: RunningFilterProxy;
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return; // a second signal during close must not re-enter it
    closing = true;
    stderrLine(`${signal} received — shutting down`);
    running
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        stderrLine(`fatal: close failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  };

  const cfg: FilterProxyConfig = {
    ...parsed.config,
    onShutdownRequest: () => shutdown('/v1/proxy/shutdown'),
  };

  try {
    running = await startFilterProxy(cfg);
  } catch (err) {
    // Bind/CA failures land here — one stderr line, then a nonzero exit so a
    // supervisor (or the app's spawn poll) sees the honest failure.
    stderrLine(`fatal: startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // The single "came up" line the parent watches for — ports only. The two
  // binds are different postures (control loopback, data possibly LAN), so
  // each reports its own address.
  stderrLine(
    `listening: control ${parsed.config.controlBindHost}:${running.controlPort} data ${parsed.config.bindHost}:${running.proxy.port}`,
  );

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // detached + unref'd children outlive the app's terminal — SIGHUP then means
  // "owner gone", which is a clean-stop trigger, not a reason to linger.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (err) => {
    stderrLine(`fatal: unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

// Auto-start only when spawned — a jest/ts-node import of this module must not
// boot an engine beside the suite. Mirrors the system-daemon's argv guard: the
// bare dist entry and the `filterProxy.cjs` webpack bundle both self-start.
if (process.argv[1]?.endsWith('main.js') || process.argv[1]?.endsWith('filterProxy.cjs')) {
  void main();
}

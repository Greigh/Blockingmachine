/**
 * Spawnable engine entry — the file two launchers run as a plain Node script:
 *
 *  - electron-app's `filterProxyManager.start()` spawns it under
 *    `ELECTRON_RUN_AS_NODE` as the user-context engine (CONNECT/dev/no-capture
 *    posture — the default before capture is installed, and permanently on
 *    non-darwin), bundled as `.webpack/main/filterProxy.cjs`.
 *  - The macOS capture service's launchd plist (`com.blockingmachine.proxy`,
 *    P1 Task 3) runs this same file as `_blockingmachine` — the dedicated user
 *    the pf anchor's `no rdr … user = _blockingmachine` exemption needs.
 *
 * Configuration is env-only so neither launcher needs argv plumbing:
 *
 *   BM_STORE_DIR     required — CA + policy-ledger root (engine exits 2 without it)
 *   BM_RULES_PATH    optional — compiled request-rules file the evaluator loads
 *                    at boot and `/v1/proxy/reload` re-reads; unset starts empty
 *   BM_DATA_PORT     CONNECT/PROXY-v2/plain-HTTP listener (default 9294)
 *   BM_CONTROL_PORT  /v1/proxy/* listener (default 9293)
 *   BM_BIND_HOST     bind host for both listeners (default 127.0.0.1)
 *
 * Garbage port values fall back to the defaults rather than binding a surprise
 * port. One stderr line announces the bound ports on success — that line is how
 * the spawning parent learns the engine came up, so it carries addresses only,
 * never payload data. A startup failure (bind conflict, corrupt CA keystore)
 * exits 1; only a config refusal (missing BM_STORE_DIR) exits 2.
 */

import { startFilterProxy, type FilterProxyConfig } from './index.js';

const TAG = '[https-filter]';

function stderrLine(message: string): void {
  process.stderr.write(`${TAG} ${message}\n`);
}

export interface SpawnedProxyConfig {
  storeDir: string;
  rulesPath?: string;
  bindHost: string;
  dataPort: number;
  controlPort: number;
}

export type EnvParse = { ok: true; config: SpawnedProxyConfig } | { ok: false; error: string };

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_DATA_PORT = 9294;
const DEFAULT_CONTROL_PORT = 9293;

/**
 * `parseInt` alone turns '9293junk' into 9293 and 'junk' into NaN — the first
 * silently binds a port the operator never picked, the second crashes listen.
 * Only a clean integer in port range survives; anything else takes `fallback`.
 */
function envPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv): EnvParse {
  const storeDir = env.BM_STORE_DIR?.trim();
  if (!storeDir) {
    return { ok: false, error: 'BM_STORE_DIR is required — the engine has nowhere to keep its CA and policy ledger' };
  }
  const rulesPath = env.BM_RULES_PATH?.trim();
  const bindHost = env.BM_BIND_HOST?.trim();
  return {
    ok: true,
    config: {
      storeDir,
      ...(rulesPath ? { rulesPath } : {}),
      bindHost: bindHost || DEFAULT_BIND_HOST,
      dataPort: envPort(env.BM_DATA_PORT, DEFAULT_DATA_PORT),
      controlPort: envPort(env.BM_CONTROL_PORT, DEFAULT_CONTROL_PORT),
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderrLine(`fatal: ${parsed.error}`);
    process.exit(2);
  }
  const cfg: FilterProxyConfig = parsed.config;

  let running;
  try {
    running = await startFilterProxy(cfg);
  } catch (err) {
    // Bind/CA failures land here — one stderr line, then a nonzero exit so a
    // supervisor (or the app's spawn poll) sees the honest failure.
    stderrLine(`fatal: startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // The single "came up" line the parent watches for — ports only.
  stderrLine(
    `listening: control ${cfg.bindHost}:${running.controlPort} data ${cfg.bindHost}:${running.proxy.port}`,
  );

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

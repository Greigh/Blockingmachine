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
 *                    (token-gated per BM_DATA_TOKEN; absent = the recorded
 *                    trusted-LAN fallback). It can never drag the control
 *                    API along: /v1/proxy/* is loopback by construction,
 *                    not by convention.
 *   BM_DATA_TOKEN    shared data-port token (flag 127): when set,
 *                    non-loopback peers authenticate — CONNECT and
 *                    plain-HTTP present `Proxy-Authorization`
 *                    (`Bearer <token>`, or `Basic` with the token as the
 *                    password) and earn a 407 on failure; PROXY-v2 spliced
 *                    flows carry the token in-band as the pinned `0xE0`
 *                    TLV (see proxyProtocol.ts) and are closed on a
 *                    miss/mismatch. Loopback peers stay exempt — the local
 *                    capture helper is the trust anchor. Absent/empty →
 *                    open port, the recorded trusted-LAN fallback (logged
 *                    once on a LAN bind, surfaced as `dataAuthRequired:
 *                    false` on /v1/proxy/status).
 *   BM_DENY_PRIVATE_DESTINATIONS
 *                    '1'/'true'/'on'/'yes' opts in the flag-127 SSRF
 *                    guard: non-loopback peers may not aim flows at
 *                    loopback/RFC1918/link-local/CGNAT/ULA/multicast/
 *                    `localhost` destinations. Default off — a single-user
 *                    LAN hub legitimately proxies to its own LAN.
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
 *   BM_PARENT_PID    optional — decimal pid of the spawning parent, probed
 *                    with signal 0 once at boot then every ~10 s on an
 *                    unref'd interval: ESRCH (parent gone) runs the same
 *                    graceful shutdown the signals and /v1/proxy/shutdown
 *                    take; EPERM (alive, another euid) keeps going. The app
 *                    sets it on the detached child it spawns so an app quit
 *                    cannot orphan an engine still holding both listeners
 *                    and the unauthenticated shutdown route (flag 101 —
 *                    the bound is ~10 s, not "until the next stop()"). The
 *                    launchd plist never sets it: launchd IS the supervisor
 *                    and KeepAlive governs. Garbage reads as unset — a
 *                    misparsed pid must never arm a watchdog against a
 *                    healthy engine. Residual: a pid recycled into another
 *                    live process reads alive — reuse postpones the bound,
 *                    it cannot break it.
 *
 * Garbage port values fall back to the defaults rather than binding a surprise
 * port. One stderr line announces the bound ports on success — that line is how
 * the spawning parent learns the engine came up, so it carries addresses only,
 * never payload data. A startup failure (bind conflict, corrupt CA keystore)
 * exits 1; only a config refusal (missing BM_STORE_DIR) exits 2.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CertAuthority,
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
   * `BM_PARENT_PID` — pid of the spawning parent, watched by the flag-101
   * watchdog (`startParentWatchdog`); absent or unparseable leaves the
   * field unset and no watchdog arms.
   */
  parentPid?: number;
  /**
   * `null` pins key-wrap off (BM_KEYWRAP=off|none|0); absent auto-resolves
   * the OS keystore. Env can only express the pin — callers that need a
   * bespoke backend construct `FilterProxyConfig` directly.
   */
  keyWrapBackend?: null;
  /**
   * `BM_DATA_TOKEN` — the flag-127 shared data-port credential. Set,
   * non-loopback peers must authenticate (CONNECT `Proxy-Authorization`
   * `Bearer <token>`/`Basic` password, or the pinned PROXY-v2 `0xE0` TLV);
   * absent/empty → open port, the recorded trusted-LAN fallback.
   */
  dataAuthToken?: string;
  /**
   * `BM_DENY_PRIVATE_DESTINATIONS` — '1'/'true'/'on'/'yes' opts the flag-127
   * SSRF guard in: non-loopback peers may not aim flows at
   * loopback/RFC1918/link-local/CGNAT/ULA/multicast destinations. Anything
   * else (including absent) is off.
   */
  denyPrivateDestinations?: boolean;
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

/**
 * Decimal pid or nothing — `parseInt`/`Number` would accept '123abc'/'0x10'
 * the same way they butcher ports, so digits only and ≥ 1 (pid 0 probes the
 * caller's own process GROUP, never a parent). Garbage reads as unset: a
 * misparsed value must never arm a watchdog against a healthy engine.
 */
function envPid(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const pid = Number(text);
  return pid >= 1 ? pid : undefined;
}

/** Watchdog cadence — the flag-101 orphan bound is this interval. */
const PARENT_WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Signal-0 liveness of the watched parent pid. Only ESRCH reads "gone":
 * EPERM means the pid lives but is owned by another euid — a live parent
 * the engine merely may not signal — and any other probe failure must
 * never retire a healthy engine. `kill` is injectable so the semantics
 * pin deterministically without platform-specific fixtures.
 */
export function parentPidAlive(
  parentPid: number,
  kill: (pid: number, signal?: number | string) => boolean = process.kill,
): boolean {
  try {
    kill(parentPid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface ParentWatchdog {
  /** Disarms the probe — the shutdown paths call it as they run. */
  stop(): void;
}

/**
 * Arms the BM_PARENT_PID watchdog (flag 101): probes once immediately — a
 * parent that died during the (slow, CA-minting) boot must not wait a full
 * interval to be noticed — then every `intervalMs` on an unref'd timer so
 * the watchdog itself never holds the engine's event loop open.
 * `onParentGone` is the idempotent shutdown the signals and the control
 * route share; it fires at most once per watchdog.
 */
export function startParentWatchdog(
  parentPid: number,
  onParentGone: () => void,
  intervalMs: number = PARENT_WATCHDOG_INTERVAL_MS,
  kill: (pid: number, signal?: number | string) => boolean = process.kill,
): ParentWatchdog {
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    fired = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const probe = (): void => {
    if (!fired && !parentPidAlive(parentPid, kill)) {
      stop();
      onParentGone();
    }
  };
  probe(); // boot-time check — catches a parent already gone
  if (!fired) {
    timer = setInterval(probe, intervalMs);
    timer.unref();
  }
  return { stop };
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
  const parentPid = envPid(env.BM_PARENT_PID);
  // Flag 127: the token passes through verbatim (whitespace-trimmed; an
  // empty value is no token — the open-port fallback), the denylist reads
  // the same truthy set envPort uses elsewhere in spirit (digits-only is
  // the port contract; booleans get the word forms).
  const dataAuthToken = env.BM_DATA_TOKEN?.trim();
  const denyPrivateRaw = env.BM_DENY_PRIVATE_DESTINATIONS?.trim().toLowerCase();
  const denyPrivate =
    denyPrivateRaw === '1' ||
    denyPrivateRaw === 'true' ||
    denyPrivateRaw === 'on' ||
    denyPrivateRaw === 'yes';
  return {
    ok: true,
    config: {
      storeDir,
      ...(rulesPath ? { rulesPath } : {}),
      bindHost: bindHost || DEFAULT_BIND_HOST,
      controlBindHost: controlBindHost || DEFAULT_BIND_HOST,
      dataPort: envPort(env.BM_DATA_PORT, DEFAULT_DATA_PORT),
      controlPort: envPort(env.BM_CONTROL_PORT, DEFAULT_CONTROL_PORT),
      ...(parentPid !== undefined ? { parentPid } : {}),
      ...(keyWrap === 'off' || keyWrap === 'none' || keyWrap === '0'
        ? { keyWrapBackend: null }
        : {}),
      ...(dataAuthToken ? { dataAuthToken } : {}),
      ...(denyPrivate ? { denyPrivateDestinations: true } : {}),
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderrLine(`fatal: ${parsed.error}`);
    process.exit(2);
  }
  // A parent already gone is caught before any CA/store work — the "came
  // up" contract exists for the parent's sake, and a dead parent cannot
  // hear it. Exit 0: nothing failed, the contract just never existed.
  if (parsed.config.parentPid !== undefined && !parentPidAlive(parsed.config.parentPid)) {
    stderrLine(`BM_PARENT_PID ${parsed.config.parentPid} is already gone — exiting without startup`);
    process.exit(0);
  }
  // `running`/`shutdown` are declared before startFilterProxy so the config
  // can hand the control API's shutdown route the same close+exit path the
  // signals take — the route can only fire once the control port listens,
  // which is after `running` is assigned.
  let running: RunningFilterProxy;
  let closing = false;
  let watchdog: ParentWatchdog | undefined;
  const shutdown = (signal: string) => {
    if (closing) return; // a second signal during close must not re-enter it
    closing = true;
    watchdog?.stop(); // the probe's job ends when ANY teardown begins
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

  // Flag-101 bound: a detached + unref'd child outlives an app quit holding
  // both listeners and the unauthenticated shutdown route — until now that
  // orphan lived until the next stop(). The watchdog retires it on ESRCH
  // through the same idempotent shutdown the signals and the route share.
  if (parsed.config.parentPid !== undefined) {
    const parentPid = parsed.config.parentPid;
    watchdog = startParentWatchdog(parentPid, () => shutdown(`BM_PARENT_PID ${parentPid} gone`));
  }

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

/**
 * `--export-ca <dir>` — flag 100's CA handoff across the launchd/app engine
 * boundary. Opens BM_STORE_DIR as the current account (whose keystore alone
 * unwraps a `ca.key.enc` envelope — this is why the install/uninstall
 * scripts invoke it via `sudo -u <store owner>`) and writes a plaintext
 * `ca.pem` + `ca.key.pem` pair into <dir>, mode 0600. The receiving store
 * re-wraps under its own backend on the next `CertAuthority.open`, so the
 * same CA identity keeps answering whichever engine posture runs — no
 * re-trust prompt across the boundary. Refuses to overwrite an existing
 * pair in <dir>: adoption is additive, never clobbering.
 */
export async function exportCaPair(destDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderrLine(`fatal: ${parsed.error}`);
    process.exit(2);
  }
  const certDest = join(destDir, 'ca.pem');
  const keyDest = join(destDir, 'ca.key.pem');
  if (existsSync(certDest) || existsSync(keyDest)) {
    stderrLine(`fatal: ${destDir} already holds a CA pair — refusing to overwrite`);
    process.exit(2);
  }
  const authority = await CertAuthority.open({
    storeDir: parsed.config.storeDir,
    ...(parsed.config.keyWrapBackend === null ? { keyWrapBackend: null } : {}),
  });
  const { certPem, keyPem } = authority.exportCaPairPem();
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  await writeFile(certDest, certPem, { mode: 0o600 });
  await writeFile(keyDest, keyPem, { mode: 0o600 });
  await chmod(certDest, 0o600);
  await chmod(keyDest, 0o600);
  stderrLine(`exported CA pair to ${destDir}`);
}

// Auto-start only when spawned — a jest/ts-node import of this module must not
// boot an engine beside the suite. Mirrors the system-daemon's argv guard: the
// bare dist entry and the `filterProxy.cjs` webpack bundle both self-start.
// `--export-ca` is the one argv the engine reads: a handoff op that exits
// instead of binding.
if (process.argv[1]?.endsWith('main.js') || process.argv[1]?.endsWith('filterProxy.cjs')) {
  const exportIdx = process.argv.indexOf('--export-ca');
  if (exportIdx !== -1) {
    const dest = process.argv[exportIdx + 1];
    if (!dest) {
      stderrLine('fatal: --export-ca needs a destination directory');
      process.exit(2);
    }
    exportCaPair(dest).catch((err) => {
      stderrLine(`fatal: export failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  } else {
    void main();
  }
}

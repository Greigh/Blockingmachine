/**
 * `@blockingmachine/https-filter` — the loopback HTTPS filtering engine
 * (design spec §5, P0 plan). `startFilterProxy` is the public entrypoint —
 * the same call the future `filterProxy.cjs` webpack bundle wraps when
 * `daemonManager` spawns it under `ELECTRON_RUN_AS_NODE` (P1). Wiring order:
 * CA → policy → evaluator → data listener → control API; `close()` tears the
 * whole stack down.
 */

import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import { join } from 'node:path';
import { createCosmeticIndex, createRequestEvaluator } from '@blockingmachine/core';
import { CertAuthority } from './ca/certAuthority.js';
import type { KeyWrapBackend } from './ca/keyWrap.js';
import { startControlServer } from './control.js';
import { PolicyStore } from './policy/policyStore.js';
import { startProxy, type RunningProxy } from './proxy/filterProxy.js';
import type { RunningControl } from './control.js';

export { CertAuthority, isValidSni, normalizeSni } from './ca/certAuthority.js';
export type { CertAuthorityOpenOptions, LeafMaterial } from './ca/certAuthority.js';
export { CaKeyUnwrapError, resolveBackend } from './ca/keyWrap.js';
export type { KeyWrapBackend } from './ca/keyWrap.js';
export { PolicyStore } from './policy/policyStore.js';
export type { PolicyAction, PolicyEntry } from './policy/policyStore.js';
export { startProxy } from './proxy/filterProxy.js';
export type { ProxyStats, RunningProxy, StartProxyOptions } from './proxy/filterProxy.js';
export { startControlServer } from './control.js';
export type { ControlApiDeps, RunningControl } from './control.js';

/** Default listeners — loopback only, never 0.0.0.0 (Global Constraints). */
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_DATA_PORT = 9294;
const DEFAULT_CONTROL_PORT = 9293;

export interface FilterProxyConfig {
  /**
   * Loopback bind host for BOTH listeners today — there is deliberately one
   * knob. HAZARD for a future LAN-hub mode (design spec §9): a non-loopback
   * DATA bind must never drag CONTROL along with it. The origin allowlist is
   * a browser-boundary guard, not authentication — no-Origin clients (curl,
   * a LAN neighbor) are trusted by design, so a LAN-exposed `/v1/proxy/*`
   * would let any LAN client toggle protection off, read the pin ledger, or
   * rotate the CA. When the data listener learns a `0.0.0.0` bind, the
   * control listener stays loopback-pinned (or gains its own config).
   */
  bindHost?: string;
  /** CONNECT/PROXY-v2/plain-HTTP data listener — default 9294; 0 for ephemeral. */
  dataPort?: number;
  /** /v1/proxy/* control listener — default 9293; 0 for ephemeral. */
  controlPort?: number;
  /**
   * Root of on-device state: `<storeDir>/ca/` holds `ca.pem` + the CA key —
   * `ca.key.enc` (AES-256-GCM under the OS key-wrap backend, spec §5.1) or
   * 0600 `ca.key.pem` when no backend exists — under a 0700 dir.
   * `<storeDir>/policy.jsonl` is the pin/bypass ledger.
   */
  storeDir: string;
  /**
   * Compiled request-rules file (one rule per line) — read at boot and
   * re-read by `POST /v1/proxy/reload`. Absent or unreadable → the engine
   * starts with an empty ruleset and reload reports the failure.
   */
  rulesPath?: string;
  /**
   * CA key-wrap backend override — `undefined` auto-resolves the OS keystore
   * (production), an injected backend forces it (tests should pass `null` so
   * suite CAs never touch the real keychain).
   */
  keyWrapBackend?: KeyWrapBackend | null;
  /**
   * Called (deferred — after the reply flushes) when POST /v1/proxy/shutdown
   * lands on the control API. Absent → the engine's own close() runs, which
   * reaps the listeners but leaves the process up; the spawned entry
   * (main.ts) substitutes its signal-path shutdown so the process exits too.
   */
  onShutdownRequest?: () => void;
  /**
   * Proxy-wide cap on concurrent HTML-injection buffers (default 64 ≈ 32 MiB
   * of worst-case held pages). A saturated budget streams eligible pages
   * verbatim rather than queueing unbounded memory — passed straight through
   * to `startProxy`.
   */
  injectionBudget?: number;
}

export interface RunningFilterProxy {
  /** The data listener — dispatch, stats, reload, pause. */
  readonly proxy: RunningProxy;
  /** The `/v1/proxy/*` control server. */
  readonly control: http.Server;
  /** The control server's bound port. */
  readonly controlPort: number;
  /** The per-device MITM authority — for CA export/trust-install flows. */
  readonly authority: CertAuthority;
  /** The pin/bypass ledger — real, or degraded-ephemeral (see below). */
  readonly policy: PolicyStore;
  /**
   * True when `PolicyStore.open` failed and the ledger fell back to an
   * in-memory store — pin learning and bypasses still apply for the session,
   * nothing persists. Also surfaced as `policyDegraded` on status/stats.
   */
  readonly policyDegraded: boolean;
  /** Tears down control → data listener → policy, in that order. */
  close(): Promise<void>;
}

export async function startFilterProxy(config: FilterProxyConfig): Promise<RunningFilterProxy> {
  const bindHost = config.bindHost ?? DEFAULT_BIND_HOST;
  const dataPort = config.dataPort ?? DEFAULT_DATA_PORT;
  const controlPort = config.controlPort ?? DEFAULT_CONTROL_PORT;

  // CA first: a corrupt keystore refuses to start (spec §7) — never mint over
  // it or silently fall back to passthrough.
  const authority = await CertAuthority.open({
    storeDir: join(config.storeDir, 'ca'),
    keyWrapBackend: config.keyWrapBackend,
  });

  // Policy second, log-free on failure (Task 3 review): an ephemeral store
  // keeps pins/bypasses toggleable in memory — just unpersisted — and the
  // `policyDegraded` flag carries the failure onto status/stats instead of a
  // one-shot log line.
  let policy: PolicyStore;
  let policyDegraded = false;
  try {
    policy = await PolicyStore.open(join(config.storeDir, 'policy.jsonl'));
  } catch {
    policy = PolicyStore.ephemeral();
    policyDegraded = true;
  }

  // Evaluator third: a missing ruleset is an empty evaluator, not a failed
  // start — same posture as the daemon's baseline fallback, and reload
  // recovers the moment the file lands.
  let rules: string[] = [];
  if (config.rulesPath !== undefined) {
    try {
      rules = (await readFile(config.rulesPath, 'utf8')).split('\n');
    } catch (err) {
      console.warn(
        `[https-filter] rules file ${config.rulesPath} unreadable — starting with an empty ruleset:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const proxy = await startProxy({
    bindHost,
    dataPort,
    // The data listener's self-target guard covers the control port too —
    // a client pointing a flow back at either listener gets refused. With
    // `controlPort: 0` the real pick is still unknown here; that is safe
    // (a client that cannot name the port cannot self-chain through it).
    controlPort,
    authority,
    evaluator: createRequestEvaluator(rules),
    // Same rule file, second face: the cosmetic index the response
    // pipeline consults per host. One index build feeds both — a reload
    // swaps them together.
    cosmeticIndex: createCosmeticIndex(rules),
    injectionBudget: config.injectionBudget,
    policy,
  });

  const reloadRules = async (): Promise<number> => {
    if (config.rulesPath === undefined) {
      throw new Error('no rulesPath configured');
    }
    const lines = (await readFile(config.rulesPath, 'utf8')).split('\n');
    proxy.reload(lines, createCosmeticIndex(lines));
    return proxy.stats().rulesSize;
  };

  let control: RunningControl;
  // One teardown, idempotent — the caller's close(), the shutdown control
  // route, and (in main.ts) the signal handlers all funnel here.
  let closed = false;
  const closeAll = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Control first so no mutation lands mid-teardown, then the data
    // listener (destroys every tracked socket), then the ledger.
    const server = control.server;
    const done = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeAllConnections(); // keep-alive probes must not park shutdown
    await done;
    await proxy.close();
    policy.close();
  };
  try {
    control = await startControlServer({
      bindHost,
      controlPort,
      proxy,
      authority,
      policy,
      reloadRules,
      policyDegraded,
      // The route schedules this past the reply flush; the caller's hook
      // (main.ts adds the process exit) wins over the default close.
      shutdown: config.onShutdownRequest ?? (() => void closeAll()),
    });
  } catch (err) {
    // The data listener is already bound — release it (and the ledger hook)
    // before propagating, or a control-port failure leaks a live proxy no
    // caller has a handle to close.
    await proxy.close();
    policy.close();
    throw err;
  }

  return {
    proxy,
    control: control.server,
    controlPort: control.port,
    authority,
    policy,
    policyDegraded,
    close: closeAll,
  };
}

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

// `__dirname` is the real bundle dir under webpack's CJS output (the config's
// `node.__dirname: false` keeps it that way — daemonManager relies on it), but
// ts-jest compiles this module as ESM where `__dirname` is undefined.
// `import.meta.url` is the portable spelling there; webpack never evaluates the
// fallback because its `__dirname` is always a string.
const moduleDir =
  typeof __dirname === 'string' ? __dirname : fileURLToPath(new URL('.', import.meta.url));

/**
 * The state the Deploy Hub pane (P1 Task 5) renders: 'stopped' is a dead
 * control port, 'starting' is a spawned child that has not answered yet,
 * 'running'/'paused' come from the engine's own payload, and 'degraded' is a
 * running engine whose policy ledger fell back to ephemeral (the engine
 * reports `policyDegraded`; the union member keeps it pill-visible).
 */
export interface FilterProxyStatus {
  status: 'stopped' | 'starting' | 'running' | 'degraded' | 'paused';
  /** CONNECT/PROXY-v2/plain-HTTP data listener port. */
  port: number;
  controlPort: number;
  rulesLoaded: number;
  protectionEnabled: boolean;
  /** Ledger fell back to in-memory — pins apply for the session, nothing persists. */
  policyDegraded: boolean;
  uptimeSeconds: number;
  /** True when this manager spawned the answering engine (vs launchd/external). */
  managedByApp: boolean;
  /**
   * True when the macOS capture service (`com.blockingmachine.proxy`) is
   * installed — on darwin the engine answering the control port then belongs
   * to launchd's `_blockingmachine` instance, and `start()` must report it
   * rather than racing a second engine onto the same ports.
   */
  captureServiceInstalled: boolean;
  corruptLineCount?: number;
  stats?: {
    flowsTotal: number;
    flowsBlocked: number;
    requestsBlocked: number;
    flowsTunneled: number;
    flowsTerminated: number;
    pinsLearned: number;
    rulesSize: number;
    blockRatePercent: number;
  };
}

/** GET /v1/proxy/ca payload — Task 4's trust ops need certPem + fingerprint. */
export interface FilterProxyCaInfo {
  certPem: string;
  sha256Fingerprint: string;
  notAfter: string;
  keyWrapped: boolean;
  /** Absent (JSON drops undefined) when no OS key-wrap backend is live. */
  keyWrapBackend?: string;
}

/**
 * One applied ledger line from `GET /v1/proxy/pins` — the engine's own
 * PolicyEntry shape: `pin` (learned on a client handshake abort), `bypass`
 * (user-directed tunnel), `remove` (a retraction — the pane collapses the
 * stream to per-host effective state rather than showing the journal).
 */
export interface FilterProxyPinEntry {
  ts: number;
  host: string;
  action: 'pin' | 'bypass' | 'remove';
  reason?: string;
}

const LAUNCHD_PLIST = '/Library/LaunchDaemons/com.blockingmachine.proxy.plist';

export class FilterProxyManager {
  private childProcess: ChildProcess | null = null;
  /** True between spawn() and the child's first control answer or exit. */
  private starting = false;
  private controlPort = 9293;
  private dataPort = 9294; // CONNECT/PROXY-v2 listener; the launchd capture plist uses the same
  private bindHost = '127.0.0.1';
  private storeDir?: string;
  private rulesPath?: string;
  private entryPath?: string;

  constructor(options?: {
    controlPort?: number;
    dataPort?: number;
    storeDir?: string;
    rulesPath?: string;
    /** Test/custom-install seam — when set it is THE spawn target (no candidate scan). */
    entryPath?: string;
  }) {
    if (options?.controlPort) this.controlPort = options.controlPort;
    if (options?.dataPort) this.dataPort = options.dataPort;
    if (options?.storeDir) this.storeDir = options.storeDir;
    if (options?.rulesPath) this.rulesPath = options.rulesPath;
    if (options?.entryPath) this.entryPath = options.entryPath;
  }

  /**
   * Probes the `/v1/proxy/status` control API on port 9293 to determine whether
   * the engine is running. Answers identically whether the responder is our
   * spawned child or the launchd capture instance — `managedByApp` +
   * `captureServiceInstalled` carry which case it is.
   */
  async getStatus(): Promise<FilterProxyStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const captureServiceInstalled = this.isCaptureServiceInstalled();

    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/status`, {
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        const paused = data.paused === true || data.status === 'paused';
        const policyDegraded = data.policyDegraded === true;
        return {
          status: paused ? 'paused' : policyDegraded ? 'degraded' : 'running',
          port: data.dataPort || this.dataPort,
          controlPort: data.controlPort || this.controlPort,
          rulesLoaded: data.rulesLoaded || 0,
          protectionEnabled: data.protectionEnabled ?? !paused,
          policyDegraded,
          uptimeSeconds: data.uptimeSeconds || 0,
          managedByApp: this.childProcess !== null,
          captureServiceInstalled,
          corruptLineCount: data.corruptLineCount,
          stats: data.stats,
        };
      }
    } catch {
      // Control API is unreachable
    } finally {
      clearTimeout(timeout);
    }

    const base = {
      port: this.dataPort,
      controlPort: this.controlPort,
      rulesLoaded: 0,
      protectionEnabled: false,
      policyDegraded: false,
      uptimeSeconds: 0,
      managedByApp: false,
      captureServiceInstalled,
    };
    // A spawned child that has not answered its control port yet is starting,
    // not stopped — the launch poll (and the UI) must not read it as a death.
    if (this.childProcess !== null && this.starting) {
      return { ...base, status: 'starting', managedByApp: true };
    }
    return { ...base, status: 'stopped' };
  }

  /**
   * True when the macOS capture install (P1 Task 3) owns the engine. The
   * plist's presence is the whole signal — `/Library/LaunchDaemons` services
   * live in the SYSTEM domain, which a user-context `launchctl list` cannot
   * see, so a probing `launchctl` could never report the service anyway.
   * Checked per call so installing or removing capture mid-session reports
   * honestly on the next probe.
   */
  private isCaptureServiceInstalled(): boolean {
    if (process.platform !== 'darwin') return false;
    return existsSync(LAUNCHD_PLIST);
  }

  /** Ordered spawn-target candidates — daemonManager's join set verbatim. */
  candidateEntryPaths(): string[] {
    return [
      // Packaged builds ship the engine as the `filterProxy.cjs` webpack bundle
      // — `asarUnpack`'d beside the workers and the daemon bundle, so the spawn
      // target is a real file, not an asar virtual path.
      ...(process.resourcesPath
        ? [path.join(process.resourcesPath, 'app.asar.unpacked', '.webpack', 'main', 'filterProxy.cjs')]
        : []),
      // The `packages/...` entries stay for the dev monorepo.
      path.resolve(moduleDir, '../../https-filter/dist/main.js'),
      // Forge dev: moduleDir lands in packages/electron-app/.webpack/main and the
      // cwd is the package dir, so repo-root joins miss the workspace build.
      path.resolve(moduleDir, '../../../https-filter/dist/main.js'),
      path.resolve(process.cwd(), '../https-filter/dist/main.js'),
      path.resolve(moduleDir, '../packages/https-filter/dist/main.js'),
      path.resolve(process.cwd(), 'packages/https-filter/dist/main.js'),
      path.resolve(process.cwd(), 'node_modules/@blockingmachine/https-filter/dist/main.js'),
    ];
  }

  resolveEntryPath(): string | null {
    // An explicit entryPath is authoritative: a stale custom path must fail
    // honestly ("could not find") rather than silently spawn whichever dist
    // build happens to exist — the caller asked for a specific binary.
    if (this.entryPath !== undefined) {
      return existsSync(this.entryPath) ? this.entryPath : null;
    }
    return this.candidateEntryPaths().find((p) => existsSync(p)) ?? null;
  }

  /**
   * The compiled request-rules file the engine loads. The compile writes
   * `<outputDir>/browser.txt` — the FULL-URL segregation (adblock path rules,
   * `|url` anchors, `$removeparam`) beside `processed_rules.txt`; `dns.txt`
   * holds only host-level rules and cannot express what request matching
   * needs. Callers holding the store (index.ts, Task 5) pass
   * `join(dirname(savePath), 'browser.txt')` explicitly; the fallbacks here
   * cover the default Documents/Blockingmachine output dir and the dev repo.
   * An env-exported `BM_RULES_PATH` still wins over the fallbacks.
   */
  private resolveRulesPath(explicit?: string): string | undefined {
    if (explicit) return explicit;
    if (this.rulesPath) return this.rulesPath;
    if (process.env.BM_RULES_PATH) return undefined; // inherited via the env spread
    let documentsDir: string | null = null;
    try {
      documentsDir = app.getPath('documents');
    } catch {
      documentsDir = null;
    }
    const candidates = [
      ...(documentsDir
        ? [
            path.join(documentsDir, 'Blockingmachine', 'browser.txt'),
            path.join(documentsDir, 'Blockingmachine', 'adguardBrowser.txt'),
          ]
        : []),
      path.resolve(process.cwd(), 'packages/browser-extension/rules/browser.txt'),
      path.resolve(process.cwd(), 'packages/browser-extension/rules/adguardBrowser.txt'),
    ];
    // Prefer a file that exists, but settle on the canonical path even when it
    // does not: without a configured rulesPath the engine's /v1/proxy/reload
    // has nothing to re-read, so the path is named before the compile writes it.
    return candidates.find((p) => existsSync(p)) ?? candidates[0];
  }

  private resolveStoreDir(explicit?: string): string | null {
    if (explicit) return explicit;
    if (this.storeDir) return this.storeDir;
    try {
      return path.join(app.getPath('userData'), 'https-filter');
    } catch {
      return null; // not under Electron — the caller must name storeDir
    }
  }

  /**
   * Spawns a background process running the filter-proxy engine if not already
   * active. This is the USER-context engine — CONNECT/dev/no-capture posture.
   * When the macOS capture install exists, launchd runs the engine as
   * `_blockingmachine` instead and answers :9293 itself; the status-first probe
   * below reports that instance rather than double-spawning (daemonManager's
   * already-active convention).
   */
  async start(options?: { storeDir?: string; rulesPath?: string }): Promise<{ success: boolean; message: string }> {
    // The latch drops BEFORE the status probe: two concurrent start() calls
    // would otherwise both await getStatus(), both read 'stopped', and both
    // spawn. Once held, it stays down until the child answers its control
    // port or exits — the 'starting' status union exists to report that gap.
    if (this.starting) {
      return { success: true, message: 'Filter proxy engine is already starting.' };
    }
    this.starting = true;

    const current = await this.getStatus();
    if (current.status === 'starting') {
      // A spawned child exists but has not answered yet — its start is still
      // in flight and owns the latch (its exit handler does the clear).
      return { success: true, message: 'Filter proxy engine is already starting.' };
    }
    if (current.status !== 'stopped') {
      this.starting = false;
      const owner = current.managedByApp
        ? 'this app'
        : current.captureServiceInstalled
          ? 'the macOS capture service'
          : 'an external process';
      return { success: true, message: `Filter proxy engine is already active on port ${current.port} (managed by ${owner}).` };
    }

    const storeDir = this.resolveStoreDir(options?.storeDir);
    if (!storeDir) {
      this.starting = false;
      return {
        success: false,
        message: 'No storeDir available — construct FilterProxyManager with one or pass start({storeDir}).',
      };
    }

    const entryPath = this.resolveEntryPath();
    if (!entryPath) {
      this.starting = false;
      return {
        success: false,
        message: 'Could not find built @blockingmachine/https-filter entry. Please run npm run build.',
      };
    }

    const rulesPath = this.resolveRulesPath(options?.rulesPath);
    const env = {
      ...process.env,
      // The spawn target is the Electron binary — run the engine's Node entry
      // as plain Node rather than booting a second app instance for it.
      ELECTRON_RUN_AS_NODE: '1',
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(this.dataPort),
      BM_CONTROL_PORT: String(this.controlPort),
      BM_BIND_HOST: this.bindHost,
      ...(rulesPath ? { BM_RULES_PATH: rulesPath } : {}),
    };

    try {
      this.childProcess = spawn(process.execPath, [entryPath], {
        env,
        // stderr is piped so a bind failure or startup crash reaches the app
        // log — 'ignore' hid exactly those, and the caller then read a dead
        // spawn as success. The engine's own contract keeps that stream to
        // lifecycle lines only (the bound-ports announcement), never payloads.
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });

      const child = this.childProcess;
      let childExit: number | null = null;
      child.once('exit', (code) => {
        childExit = code;
        this.starting = false;
        if (this.childProcess === child) this.childProcess = null;
      });
      let errTail = '';
      let sawListening = false;
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        console.error(`[FilterProxy] ${text.trimEnd()}`);
        // `listening:` is the engine's own "came up" contract — printed only
        // after BOTH listeners bind. Chunks can split mid-line, so match
        // against a rolling tail rather than the single chunk.
        errTail = (errTail + text).slice(-2048);
        if (errTail.includes('listening:')) sawListening = true;
      });
      child.unref();
      (child.stderr as { unref?: () => void } | null)?.unref?.();

      // "Started" means an up-signal, not spawn() returning: the stderr
      // `listening:` line (authoritative — both listeners are bound by the
      // time it prints) or a control-API answer (fallback for engines that
      // don't print it). First-boot CA mints — RSA keygen + a keychain
      // probe — can run well past a few seconds, so the bound is ~30s
      // overall; a child exit fails immediately either way.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (childExit !== null) {
          this.starting = false;
          return {
            success: false,
            message: `Filter proxy exited during startup (code ${childExit}) — check for a port conflict on ${this.dataPort}/${this.controlPort}.`,
          };
        }
        const status = await this.getStatus();
        if (status.status !== 'stopped' && status.status !== 'starting') {
          this.starting = false;
          return { success: true, message: `Filter proxy engine started successfully on port ${status.port}` };
        }
        if (sawListening) {
          this.starting = false;
          return { success: true, message: `Filter proxy engine started successfully on port ${this.dataPort}` };
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      this.starting = false;
      return {
        success: false,
        message: `Filter proxy spawned but its control API never answered — something else may hold port ${this.dataPort} or ${this.controlPort}.`,
      };
    } catch (err: any) {
      this.starting = false;
      return { success: false, message: `Failed to spawn filter proxy: ${err?.message || err}` };
    }
  }

  /**
   * Stops the engine process if managed by this app. A launchd-owned engine
   * (capture install) is refused with the launchctl pointer — killing the
   * `_blockingmachine` process under KeepAlive would just relaunch it.
   */
  async stop(): Promise<{ success: boolean; message: string }> {
    if (this.childProcess) {
      try {
        this.childProcess.kill('SIGTERM');
        this.childProcess = null;
        this.starting = false;
        return { success: true, message: 'Filter proxy process stopped.' };
      } catch (err: any) {
        return { success: false, message: `Failed to terminate filter proxy: ${err?.message || err}` };
      }
    }

    if (this.isCaptureServiceInstalled()) {
      return {
        success: false,
        message: 'Filter proxy is managed by the macOS capture service — unload com.blockingmachine.proxy via launchctl (or the Task 3 uninstaller).',
      };
    }
    return {
      success: false,
      message: 'Filter proxy is running externally or not running. Stop it from its owning process.',
    };
  }

  /**
   * Toggles protection on or off — POST /v1/proxy/toggle. While paused every
   * verdict point blind-tunnels, so this never holds connectivity hostage.
   */
  async toggle(enabled?: boolean): Promise<{ success: boolean; protectionEnabled: boolean }> {
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof enabled === 'boolean' ? { enabled } : {}),
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, protectionEnabled: data.protectionEnabled };
      }
    } catch {
      // ignore
    }
    return { success: false, protectionEnabled: false };
  }

  /**
   * Hot-reloads the request-rules file without dropping active flows — the
   * compile pipeline's write of browser.txt is picked up the same way the DNS
   * daemon's reload picks up dns.txt.
   */
  async reloadRules(): Promise<{ success: boolean; rulesLoaded: number; message: string }> {
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        const data = await res.json();
        return {
          success: true,
          rulesLoaded: data.rulesLoaded || 0,
          message: data.message || `Successfully reloaded ${data.rulesLoaded || 0} rules`,
        };
      }
      return { success: false, rulesLoaded: 0, message: `Filter proxy responded with HTTP ${res.status}` };
    } catch (err: any) {
      return { success: false, rulesLoaded: 0, message: `Failed to reach filter proxy control API: ${err?.message || err}` };
    }
  }

  /**
   * GET /v1/proxy/ca — the per-device CA identity (PEM + sha256 fingerprint +
   * key-wrap posture). Task 4's trust ops and Task 5's CA row both consume it.
   * Null when the engine is unreachable — never a throw for a dead port.
   */
  async getCaInfo(): Promise<FilterProxyCaInfo | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/ca`, {
        signal: controller.signal,
      });
      if (res.ok) {
        return (await res.json()) as FilterProxyCaInfo;
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }

  /**
   * GET /v1/proxy/pins — the pin/bypass ledger, oldest first (the pane
   * derives "currently pinned/bypassed" itself: a host's LAST action wins,
   * and `remove` rows are the retractions, not entries to list). Null when
   * the engine is unreachable — getCaInfo's dead-port convention.
   */
  async getPins(): Promise<{ pins: FilterProxyPinEntry[]; corruptLineCount: number } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/pins`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return {
          pins: Array.isArray(data.pins) ? data.pins : [],
          corruptLineCount: typeof data.corruptLineCount === 'number' ? data.corruptLineCount : 0,
        };
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }

  /**
   * POST /v1/proxy/pins/remove — retract whatever policy covers `host`
   * (learned pin, user bypass, or both — `PolicyStore.remove` clears both
   * sets, which is why the CLI's unpin and bypass-remove ride this one
   * route). Host validation lives at the control API and the IPC edge; the
   * manager forwards verbatim like the CLI does.
   */
  async removePin(host: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/proxy/pins/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        return { success: true, message: `Policy for ${host} removed.` };
      }
      return {
        success: false,
        message: (data && typeof data.error === 'string' && data.error) ||
          `Filter proxy responded with HTTP ${res.status}`,
      };
    } catch (err: any) {
      return { success: false, message: `Failed to reach filter proxy control API: ${err?.message || err}` };
    }
  }
}

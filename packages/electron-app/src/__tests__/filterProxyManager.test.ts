/**
 * FilterProxyManager — daemonManager's shape for the HTTPS filter engine.
 *
 * The electron module is mocked exactly like learnedShadow's suites do so
 * `app.getPath` lands in a temp dir. Control-API interactions use the
 * established `jest.spyOn(globalThis, 'fetch')` stub (ProxyCommand's idiom)
 * for payload mapping and already-active detection, and a tiny real Node
 * fixture covers the actual spawn/poll/kill path — asserting the spawn
 * contract against a stub would test the stub, not the manager.
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpBase = mkdtempSync(join(tmpdir(), 'bm-filter-proxy-manager-'));

jest.unstable_mockModule('electron', () => ({
  app: {
    // Store/rules defaults resolve under userData/documents — both land in the
    // temp dir so a test never touches the real profile.
    getPath: (name: string) => join(tmpBase, name),
  },
}));

const { FilterProxyManager } = await import('../filterProxyManager');

const managers: Array<{ stop: () => Promise<unknown> }> = [];

function tracked<T extends { stop: () => Promise<unknown> }>(m: T): T {
  managers.push(m);
  return m;
}

afterEach(async () => {
  jest.restoreAllMocks();
  while (managers.length) {
    try {
      await managers.pop()!.stop();
    } catch {
      // fixture already gone
    }
  }
});

// The temp dir holds fake engines + stores for the whole suite run.
process.on('exit', () => rmSync(tmpBase, { recursive: true, force: true }));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATUS_PAYLOAD = {
  status: 'running',
  dataPort: 9294,
  controlPort: 9293,
  protectionEnabled: true,
  paused: false,
  policyDegraded: false,
  rulesLoaded: 42,
  uptimeSeconds: 7,
};

/**
 * A minimal stand-in for `dist/main.js`: answers `/v1/proxy/status` on
 * BM_CONTROL_PORT with BM_DATA_PORT echoed back, exits 0 on SIGTERM. Written
 * into the temp dir at run time so the test has no fixture file to keep in
 * sync — and, being CJS, it runs identically under node and
 * ELECTRON_RUN_AS_NODE'd electron.
 */
function writeFakeEngine(dir: string): string {
  const file = join(dir, 'fake-engine.cjs');
  writeFileSync(
    file,
    [
      "const http = require('node:http');",
      'const port = Number(process.env.BM_CONTROL_PORT || 0);',
      'const data = Number(process.env.BM_DATA_PORT || 0);',
      "http.createServer((req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'application/json' });",
      '  res.end(JSON.stringify({ status: \'running\', dataPort: data, controlPort: port,',
      '    protectionEnabled: true, paused: false, policyDegraded: false,',
      '    rulesLoaded: 3, uptimeSeconds: 1 }));',
      "}).listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => process.exit(0));",
      '',
    ].join('\n'),
  );
  return file;
}

describe('FilterProxyManager', () => {
  test('reports stopped with default ports when nothing answers', async () => {
    const manager = tracked(new FilterProxyManager({ controlPort: 65431, dataPort: 65432 }));
    const status = await manager.getStatus();

    expect(status.status).toBe('stopped');
    expect(status.port).toBe(65432);
    expect(status.controlPort).toBe(65431);
    expect(status.rulesLoaded).toBe(0);
    expect(status.managedByApp).toBe(false);
    expect(typeof status.captureServiceInstalled).toBe('boolean');
  });

  test('maps a running engine payload onto the status union', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(200, STATUS_PAYLOAD));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431, dataPort: 65432 }));
    const status = await manager.getStatus();

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:65431/v1/proxy/status');
    expect(status.status).toBe('running');
    expect(status.port).toBe(9294);
    expect(status.rulesLoaded).toBe(42);
    expect(status.protectionEnabled).toBe(true);
    expect(status.policyDegraded).toBe(false);
    // Answered but never spawned — an external/launchd engine, not ours.
    expect(status.managedByApp).toBe(false);
  });

  test('maps paused and policy-degraded payloads', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(200, { ...STATUS_PAYLOAD, status: 'paused', paused: true, protectionEnabled: false }));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    expect((await manager.getStatus()).status).toBe('paused');

    fetchMock.mockResolvedValue(jsonResponse(200, { ...STATUS_PAYLOAD, policyDegraded: true }));
    expect((await manager.getStatus()).status).toBe('degraded');
  });

  test('a non-ok control response reads as stopped', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'x' }));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    expect((await manager.getStatus()).status).toBe('stopped');
  });

  test('start() refuses to double-spawn when an engine already answers', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(200, STATUS_PAYLOAD));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.start({ storeDir: join(tmpBase, 'store-a') });

    expect(result.success).toBe(true);
    expect(result.message).toContain('already active');
    // The status probe answered but the manager never spawned: not ours.
    expect((await manager.getStatus()).managedByApp).toBe(false);
  });

  test('candidate paths name the packaged bundle first, then the dev monorepo joins', () => {
    const manager = new FilterProxyManager();
    const candidates = manager.candidateEntryPaths();

    const packaged = candidates.find((p) => p.includes('app.asar.unpacked'));
    if (process.resourcesPath) {
      // Inside a packaged/electron context the asar-unpacked bundle leads.
      expect(packaged).toBeDefined();
      expect(packaged).toContain('filterProxy.cjs');
      expect(candidates[0]).toBe(packaged);
    } else {
      expect(packaged).toBeUndefined();
    }
    expect(candidates.some((p) => p.endsWith(join('https-filter', 'dist', 'main.js')))).toBe(true);
    expect(candidates.some((p) => p.includes(join('node_modules', '@blockingmachine', 'https-filter')))).toBe(true);
  });

  test('an explicit entryPath is authoritative — a stale one fails honestly', async () => {
    const manager = tracked(new FilterProxyManager({ entryPath: join(tmpBase, 'no-such-entry.cjs') }));
    expect(manager.resolveEntryPath()).toBeNull();

    const result = await manager.start({ storeDir: join(tmpBase, 'store-b') });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Could not find built @blockingmachine/https-filter entry');
  });

  test('start() spawns the entry under ELECTRON_RUN_AS_NODE with BM_* env, and stop() kills it', async () => {
    const dir = mkdtempSync(join(tmpBase, 'spawn-'));
    const entry = writeFakeEngine(dir);
    const controlPort = await freePort();
    const dataPort = await freePort();

    const manager = tracked(
      new FilterProxyManager({
        controlPort,
        dataPort,
        storeDir: join(dir, 'store'),
        entryPath: entry,
      }),
    );

    const started = await manager.start();
    expect(started.success).toBe(true);
    expect(started.message).toContain(String(dataPort));

    const status = await manager.getStatus();
    expect(status.status).toBe('running');
    expect(status.port).toBe(dataPort);
    expect(status.rulesLoaded).toBe(3);
    expect(status.managedByApp).toBe(true);

    const stopped = await manager.stop();
    expect(stopped.success).toBe(true);
    // SIGTERM reaps the fixture on the OS's schedule, not kill()'s — poll the
    // probe until the dead listener reads stopped (or the test times out).
    let last = await manager.getStatus();
    for (let i = 0; i < 25 && last.status !== 'stopped'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      last = await manager.getStatus();
    }
    expect(last.status).toBe('stopped');
  });

  test('concurrent start() calls collapse to a single spawn', async () => {
    const dir = mkdtempSync(join(tmpBase, 'spawn-race-'));
    const entry = writeFakeEngine(dir);
    const controlPort = await freePort();
    const dataPort = await freePort();

    const manager = tracked(
      new FilterProxyManager({
        controlPort,
        dataPort,
        storeDir: join(dir, 'store'),
        entryPath: entry,
      }),
    );

    // The latch drops before the status probe, so the second call is refused
    // synchronously — a real second spawn would instead EADDRINUSE on the
    // already-bound control port and come back a startup failure.
    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.message).toContain('already starting');

    const status = await manager.getStatus();
    expect(status.status).toBe('running');
    expect(status.managedByApp).toBe(true);
  });

  test('stop() without a managed child reports external ownership', async () => {
    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.stop();
    expect(result.success).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  test('toggle() POSTs {enabled} to /v1/proxy/toggle', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, protectionEnabled: false, paused: true }));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.toggle(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:65431/v1/proxy/toggle');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
    expect(result).toEqual({ success: true, protectionEnabled: false });
  });

  test('getPins() maps the ledger payload and tolerates missing fields', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const entries = [
      { ts: 1, host: 'a.example', action: 'pin', reason: 'handshake-abort' },
      { ts: 2, host: 'b.example', action: 'bypass' },
      { ts: 3, host: 'a.example', action: 'remove' },
    ];
    fetchMock.mockResolvedValue(jsonResponse(200, { pins: entries, corruptLineCount: 2 }));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const res = await manager.getPins();

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:65431/v1/proxy/pins');
    expect(res?.pins).toEqual(entries);
    expect(res?.corruptLineCount).toBe(2);

    // A payload with no pins array normalises to empty rather than throwing.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const empty = await manager.getPins();
    expect(empty).toEqual({ pins: [], corruptLineCount: 0 });
  });

  test('getPins() is null when the engine is unreachable or non-ok', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'down' }));
    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    expect(await manager.getPins()).toBeNull();

    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await manager.getPins()).toBeNull();
  });

  test('removePin() POSTs {host} to /v1/proxy/pins/remove', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, host: 'a.example', pinned: false, bypassed: false }),
    );

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.removePin('a.example');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:65431/v1/proxy/pins/remove');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ host: 'a.example' });
    expect(result.success).toBe(true);
  });

  test('removePin() surfaces the control API error body and transport failures', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(jsonResponse(400, { success: false, error: 'host must be a non-empty hostname' }));
    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const bad = await manager.removePin('');
    expect(bad.success).toBe(false);
    expect(bad.message).toContain('non-empty hostname');

    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const down = await manager.removePin('a.example');
    expect(down.success).toBe(false);
    expect(down.message).toContain('control API');
  });
});

describe('FilterProxyManager — one-engine lifecycle gates', () => {
  test('start() refuses to squat under an installed-but-unanswered capture service', async () => {
    // The probe reads 'stopped' (a transient KeepAlive gap), not a free
    // port — a user-euid spawn on the launchd ports would self-capture, so
    // the refusal must fire before resolveStoreDir/resolveEntryPath/spawn.
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const manager = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        dataPort: 65432,
        captureServiceInstalled: () => true,
        platform: 'darwin',
      }),
    );
    const result = await manager.start({ storeDir: join(tmpBase, 'store-capped') });

    expect(result.success).toBe(false);
    expect(result.message).toContain('capture service owns');
    expect(result.message).toContain('KeepAlive');
    // The spawn was never reached — no child, and the only fetch attempted
    // was the status probe (no control mutation rode it).
    expect((manager as unknown as { childProcess: unknown }).childProcess).toBeNull();
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith('/v1/proxy/status'))).toBe(true);
  });

  test('stop() retires an orphaned engine via POST /v1/proxy/shutdown — not a kill', async () => {
    // An engine answers that this manager never spawned (a detached child
    // that outlived an app exit). The retire rides the control API, and the
    // bounded poll then sees the port go dead.
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    let engineDead = false;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/proxy/shutdown')) {
        engineDead = true;
        return jsonResponse(200, { success: true, message: 'shutting down' });
      }
      if (url.endsWith('/v1/proxy/status')) {
        return engineDead
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : jsonResponse(200, STATUS_PAYLOAD);
      }
      return jsonResponse(404, { error: 'unknown route' });
    });

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.stop();

    expect(result.success).toBe(true);
    const shutdownCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/proxy/shutdown'));
    expect(shutdownCall).toBeDefined();
    expect((shutdownCall![1] as RequestInit).method).toBe('POST');
    // Nothing was killed — there is no child to kill; the route is the verb.
    expect((manager as unknown as { childProcess: unknown }).childProcess).toBeNull();
  });

  test('stop() refuses the launchd-owned engine — bootout is the verb, never the route', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const manager = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        captureServiceInstalled: () => true,
        platform: 'darwin',
      }),
    );
    const result = await manager.stop();

    expect(result.success).toBe(false);
    expect(result.message).toContain('launchd');
    expect(result.message).toContain('bootout');
    // The shutdown route must never fire against the capture engine.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith('/v1/proxy/shutdown')),
    ).toBe(false);
  });

  test('stop() answers not-running when nothing answers the control port', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const manager = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const result = await manager.stop();

    expect(result.success).toBe(false);
    expect(result.message).toContain('not running');
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith('/v1/proxy/shutdown')),
    ).toBe(false);
  });

  test('getCaptureInstallCommand renders absolute script/bundle/runner/rulesPath', () => {
    const dir = mkdtempSync(join(tmpBase, 'install-cmd-'));
    const entry = writeFakeEngine(dir);

    const manager = new FilterProxyManager({ entryPath: entry, platform: 'darwin' });
    const res = manager.getCaptureInstallCommand(join(dir, 'rules', 'browser.txt'));

    expect(res.success).toBe(true);
    const cmd = res.command!;
    expect(cmd).toContain('install-macos-capture.sh');
    expect(cmd).toContain(entry); // the resolved engine bundle — absolute
    expect(cmd).toContain(process.execPath); // the runner — absolute
    expect(cmd).toContain(join(dir, 'rules', 'browser.txt')); // the rulesPath — absolute
    // A repo-relative invocation is exactly what this must not render.
    expect(cmd).not.toContain(' scripts/install-macos-capture.sh');
    expect(cmd.startsWith('sudo')).toBe(true);

    // An unresolvable engine bundle fails honestly rather than printing a
    // half-rendered line.
    const noEntry = new FilterProxyManager({ entryPath: join(tmpBase, 'no-such-entry.cjs') });
    const failed = noEntry.getCaptureInstallCommand();
    expect(failed.success).toBe(false);
    expect(failed.message).toBeTruthy();
  });

  test('isCaptureServiceInstalled probes per-platform via the injected seams', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    // linux: presence of the rendered systemd unit file — the exact analog
    // of the darwin plist check, driven by the fileExists seam.
    const linuxInstalled = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'linux',
        fileExists: (p) => p === '/etc/systemd/system/blockingmachine-proxy.service',
      }),
    );
    expect((await linuxInstalled.getStatus()).captureServiceInstalled).toBe(true);

    // flag 118: the openrc/sysvinit legs land the proxy service under
    // /etc/init.d — same file-presence idiom, different supervisor.
    const linuxInitd = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'linux',
        fileExists: (p) => p === '/etc/init.d/blockingmachine-proxy',
      }),
    );
    expect((await linuxInitd.getStatus()).captureServiceInstalled).toBe(true);

    // A half-enabled openrc install (script written, rc-update failed)
    // still reports via the runlevel symlink probe.
    const linuxRunlevel = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'linux',
        fileExists: (p) => p === '/etc/runlevels/default/blockingmachine-proxy',
      }),
    );
    expect((await linuxRunlevel.getStatus()).captureServiceInstalled).toBe(true);

    const linuxAbsent = tracked(
      new FilterProxyManager({ controlPort: 65431, platform: 'linux', fileExists: () => false }),
    );
    expect((await linuxAbsent.getStatus()).captureServiceInstalled).toBe(false);

    // win32: `sc.exe query` — a STATE line means the service object exists
    // in any run state; error 1060 is the honest not-installed answer.
    const winInstalled = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'win32',
        serviceQuery: (svc) => ({
          status: 0,
          stdout: `SERVICE_NAME: ${svc}\n        STATE              : 4  RUNNING\n`,
          stderr: '',
        }),
      }),
    );
    expect((await winInstalled.getStatus()).captureServiceInstalled).toBe(true);

    const winStopped = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'win32',
        serviceQuery: () => ({
          status: 0,
          stdout: 'SERVICE_NAME: BlockingmachineProxy\n        STATE              : 1  STOPPED\n',
          stderr: '',
        }),
      }),
    );
    expect((await winStopped.getStatus()).captureServiceInstalled).toBe(true); // exists ≠ running

    const winAbsent = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'win32',
        serviceQuery: () => ({
          status: 1060,
          stdout: '',
          stderr:
            '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\n' +
            'The specified service does not exist as an installed service.',
        }),
      }),
    );
    expect((await winAbsent.getStatus()).captureServiceInstalled).toBe(false);

    // A spawn-level failure (no sc.exe at all) must read as not-installed,
    // never as capture-owned.
    const winBroken = tracked(
      new FilterProxyManager({
        controlPort: 65431,
        platform: 'win32',
        serviceQuery: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
      }),
    );
    expect((await winBroken.getStatus()).captureServiceInstalled).toBe(false);

    // A platform with no capture adapter answers false plainly.
    const other = tracked(
      new FilterProxyManager({ controlPort: 65431, platform: 'freebsd', fileExists: () => true }),
    );
    expect((await other.getStatus()).captureServiceInstalled).toBe(false);
  });

  test('getCaptureInstallCommand renders the per-platform installer line', () => {
    const dir = mkdtempSync(join(tmpBase, 'install-cmd-plat-'));
    const entry = writeFakeEngine(dir);
    const rules = join(dir, 'rules', 'browser.txt');

    // linux → the same `sudo bash <sh>` shape as darwin, linux script name.
    const linux = new FilterProxyManager({ entryPath: entry, platform: 'linux' });
    const lres = linux.getCaptureInstallCommand(rules);
    expect(lres.success).toBe(true);
    expect(lres.command!).toContain('install-linux-capture.sh');
    expect(lres.command!.startsWith('sudo bash')).toBe(true);
    expect(lres.command!).toContain(entry);
    expect(lres.command!).toContain(rules);

    // win32 → powershell -File with double-quoted absolute paths; there is
    // no sudo verb — the card names the elevated-PowerShell requirement.
    const win = new FilterProxyManager({ entryPath: entry, platform: 'win32' });
    const wres = win.getCaptureInstallCommand(rules);
    expect(wres.success).toBe(true);
    expect(wres.command!).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File');
    expect(wres.command!).toContain('install-windows-capture.ps1');
    expect(wres.command!).toContain(`"${entry}"`);
    expect(wres.command!).toContain(`"${rules}"`);
    // Default ports render no -Port params — the installer's own defaults
    // carry them (same constants), so the command stays byte-stable.
    expect(wres.command!).not.toMatch(/-(HelperPort|EnginePort|ControlPort)/);

    // A manager on non-default ports must spell them — a rendered command
    // that silently reverts to the script defaults would install capture
    // pointed at ports the app's engine never binds.
    const winCustom = new FilterProxyManager({
      entryPath: entry,
      platform: 'win32',
      controlPort: 65001,
      dataPort: 65002,
      helperPort: 65003,
    });
    const wcres = winCustom.getCaptureInstallCommand(rules);
    expect(wcres.success).toBe(true);
    expect(wcres.command!).toContain('-HelperPort 65003');
    expect(wcres.command!).toContain('-EnginePort 65002');
    expect(wcres.command!).toContain('-ControlPort 65001');

    // No adapter for the platform → an honest failure naming it.
    const other = new FilterProxyManager({ entryPath: entry, platform: 'freebsd' });
    const ores = other.getCaptureInstallCommand(rules);
    expect(ores.success).toBe(false);
    expect(ores.message).toContain('freebsd');
  });

  test('caDrift flags a changed answering fingerprint against the trusted record', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/proxy/ca')) {
        return jsonResponse(200, {
          certPem: 'pem',
          sha256Fingerprint: 'BB:BB:BB',
          notAfter: 'Jan  1 00:00:00 2036 GMT',
          keyWrapped: false,
        });
      }
      return jsonResponse(200, STATUS_PAYLOAD);
    });

    // Recorded trust for a DIFFERENT fingerprint → drift.
    const drifted = tracked(
      new FilterProxyManager({ controlPort: 65431, trustedCaFingerprint: () => 'AA:AA:AA' }),
    );
    expect((await drifted.getStatus()).caDrift).toBe(true);

    // Same fingerprint → no drift.
    const same = tracked(
      new FilterProxyManager({ controlPort: 65431, trustedCaFingerprint: () => 'BB:BB:BB' }),
    );
    expect((await same.getStatus()).caDrift).toBe(false);

    // No recorded trust → the check is inert and never even probes /ca.
    const none = tracked(new FilterProxyManager({ controlPort: 65431 }));
    const before = fetchMock.mock.calls.length;
    expect((await none.getStatus()).caDrift).toBe(false);
    expect(
      fetchMock.mock.calls.slice(before).some(([u]) => String(u).endsWith('/v1/proxy/ca')),
    ).toBe(false);
  });
});

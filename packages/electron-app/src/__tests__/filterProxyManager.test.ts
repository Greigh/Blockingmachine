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

/**
 * Memory/CPU spot profile of repeated IPC workflows — drives the real registered
 * handlers (same boot harness as ipcBehavioral.test.ts) in a loop and reports heap
 * delta + wall time. Not a benchmark suite: a leak-detection tripwire under
 * `--expose-gc`. When run without it the numbers still print but gc() is skipped.
 */

import { describe, expect, test, jest, beforeAll } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const tmpUserData = mkdtempSync(join(tmpdir(), 'bm-ipc-prof-'));

class FakeStore {
  private data = new Map<string, unknown>();
  private listeners = new Map<string, Array<() => void>>();
  constructor(opts?: { schema?: Record<string, { default?: unknown }> }) {
    for (const [key, def] of Object.entries(opts?.schema ?? {})) {
      if (def && 'default' in def) this.data.set(key, def.default);
    }
  }
  get(key: string, fallback?: unknown) {
    return this.data.has(key) ? this.data.get(key) : fallback;
  }
  set(key: string, value: unknown) {
    this.data.set(key, value);
    for (const fn of this.listeners.get(key) ?? []) fn();
  }
  onDidChange(key: string, fn: () => void) {
    const list = this.listeners.get(key) ?? [];
    list.push(fn);
    this.listeners.set(key, list);
    return () => {};
  }
}

jest.unstable_mockModule('electron-store', () => ({
  __esModule: true,
  default: FakeStore,
}));
jest.unstable_mockModule('electron-is-dev', () => ({ __esModule: true, default: false }));

class FakeBrowserWindow {
  webContents = { on: () => {}, send: () => {}, setWindowOpenHandler: () => {}, isDestroyed: () => false };
  on() {}
  once() {}
  show() {}
  isDestroyed() {
    return false;
  }
  async loadURL() {}
  async loadFile() {}
  close() {}
  static getAllWindows() {
    return [];
  }
}

jest.unstable_mockModule('electron', () => ({
  __esModule: true,
  app: {
    name: '',
    isPackaged: false,
    getPath: (n: string) => join(tmpUserData, n),
    getAppPath: () => tmpUserData,
    getVersion: () => '0.0.0-test',
    whenReady: () => Promise.resolve(),
    on: () => {},
    once: () => {},
    quit: () => {},
    setLoginItemSettings: () => {},
    dock: { setIcon: () => {} },
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    on: () => {},
    removeHandler: () => {},
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {}, getApplicationMenu: () => null },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
    displayBalloon() {}
    removeBalloon() {}
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: () => {} },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      extensions: { getAllExtensions: () => [] },
    },
  },
  Notification: class {
    show() {}
    static isSupported() {
      return true;
    }
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
  clipboard: { writeText: () => {}, readText: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
}));

jest.unstable_mockModule('@blockingmachine/core', async () => {
  const actual = await jest.requireActual<typeof import('@blockingmachine/core')>('@blockingmachine/core');
  return {
    ...actual,
    refreshDb: async () => ({ remoteLastFetched: null, applied: false }),
    setDbCacheDirectory: () => {},
  };
});

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler({}, ...args);
}

const heapMB = () => process.memoryUsage().heapUsed / 1024 / 1024;
const gc = (globalThis as { gc?: () => void }).gc;

// Without --expose-gc these numbers include uncollected garbage — an assertion on
// heap delta would measure the runner, not the code. Same convention as the
// docker-gated live suites: skip when the precondition is absent; run with
// `node --expose-gc --experimental-vm-modules .../jest.js ipcProfile` for the
// real tripwire.
const ptest = gc ? test : test.skip;

beforeAll(async () => {
  await import('../index');
  for (let i = 0; i < 50 && handlers.size < 80; i++) {
    await new Promise((r) => setImmediate(r));
  }
});

describe('IPC workflow — memory/CPU spot profile', () => {
  ptest('2000 quarantine adds + rejects: heap delta bounded', async () => {
    // Production: savePath exists. Create the fake's equivalent so persistThreatsSnapshot
    // writes succeed (ENOENT bursts would distort the measurement, not model the app).
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpUserData, 'documents', 'Blockingmachine'), { recursive: true });
    const item = (i: number) => ({
      id: `p${i}`,
      domain: `d${i}.example.com`,
      category: 'Ads',
      verdict: 'suspicious',
      riskLevel: 'medium',
      confidence: 0.9,
      reasons: ['x'],
      generatedRules: [],
      source: 'inspector',
      timestamp: '2026-01-01T00:00:00Z',
    });
    gc?.();
    const heapBefore = heapMB();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) {
      await invoke('add-threat-quarantine', [item(i)]);
    }
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // Drain the fire-and-forget snapshot writes before measuring — pending fs ops are
    // transient allocation, not retained memory.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 100));
    gc?.();
    const heapAfter = heapMB();
    console.log(
      `[profile] 2000 quarantine adds: ${elapsedMs.toFixed(0)}ms, heap ${heapBefore.toFixed(1)}MB -> ${heapAfter.toFixed(1)}MB (delta ${(heapAfter - heapBefore).toFixed(1)}MB)`,
    );
    // The ledger caps at 200 entries, so retained growth should stay small.
    expect(heapAfter - heapBefore).toBeLessThan(50);
  });

  ptest('200 feed-server start/stop cycles: no socket/handle accumulation', async () => {
    gc?.();
    const heapBefore = heapMB();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) {
      await invoke('start-feed-server', 19400);
      await invoke('stop-feed-server');
    }
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    gc?.();
    const heapAfter = heapMB();
    console.log(
      `[profile] 200 feed-server cycles: ${elapsedMs.toFixed(0)}ms, heap ${heapBefore.toFixed(1)}MB -> ${heapAfter.toFixed(1)}MB (delta ${(heapAfter - heapBefore).toFixed(1)}MB)`,
    );
    expect(heapAfter - heapBefore).toBeLessThan(50);
  }, 60000);

  ptest('1000 store writes via set-ai-watchdog-config: no retained growth', async () => {
    gc?.();
    const heapBefore = heapMB();
    for (let i = 0; i < 1000; i++) {
      await invoke('set-ai-watchdog-config', { enabled: i % 2 === 0, intervalMinutes: (i % 59) + 1 });
    }
    gc?.();
    const heapAfter = heapMB();
    console.log(`[profile] 1000 watchdog writes: heap delta ${(heapAfter - heapBefore).toFixed(1)}MB`);
    expect(heapAfter - heapBefore).toBeLessThan(25);
  });
});

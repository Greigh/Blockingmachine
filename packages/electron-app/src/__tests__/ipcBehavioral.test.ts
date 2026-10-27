/**
 * Behavioral IPC tests — the real `registerIPCHandlers` from `index.ts`, booted under a
 * mocked Electron, exercised with hostile payloads instead of trusted on faith.
 *
 * The earlier pass pinned these boundaries structurally (`ipcBoundary.test.ts`); this suite
 * invokes the registered handler functions and asserts what actually lands in the store —
 * the difference between "the code contains a call to sanitizeX" and "a malicious payload
 * is refused end-to-end".
 */

import { describe, expect, test, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const tmpUserData = mkdtempSync(join(tmpdir(), 'bm-ipc-test-'));
// An existing config file is what marks this boot as an *existing install* —
// `installHadPriorState` keys on it (never on token absence), so the harness
// exercises the legacy token-optional posture by default and the secured
// modes are flipped explicitly per test.
writeFileSync(join(tmpUserData, 'config.json'), '{}');

/** Minimal in-memory stand-in for electron-store: defaults come from the real schema. */
class FakeStore {
  static lastInstance: FakeStore | null = null;
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
  // writeSecret clears the alternate key form via `store.delete` — electron-store
  // has it, so the fake must too.
  delete(key: string) {
    this.data.delete(key);
    for (const fn of this.listeners.get(key) ?? []) fn();
  }
  onDidChange(key: string, fn: () => void) {
    const list = this.listeners.get(key) ?? [];
    list.push(fn);
    this.listeners.set(key, list);
    return () => {};
  }
  snapshot() {
    return new Map(this.data);
  }
  // electron-store's own `path` — `installHadPriorState` existsSync's it at
  // construction. Pointed at the config.json seeded above so this harness is
  // an *existing* install.
  get path() {
    return join(tmpUserData, 'config.json');
  }
}

/** The store instance captured from the module under test. */
const capturedStoreRef: { current: FakeStore | null } = { current: null };

jest.unstable_mockModule('electron-store', () => ({
  __esModule: true,
  default: class extends FakeStore {
    constructor(opts?: { schema?: Record<string, { default?: unknown }> }) {
      super(opts);
      FakeStore.lastInstance = this;
      capturedStoreRef.current = this;
    }
  },
}));

jest.unstable_mockModule('electron-is-dev', () => ({ __esModule: true, default: false }));

const fakeWebContents = () => ({
  on: () => {},
  send: () => {},
  setWindowOpenHandler: () => {},
  isDestroyed: () => false,
});

class FakeBrowserWindow {
  webContents = fakeWebContents();
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
    getPath: (name: string) => join(tmpUserData, name),
    getAppPath: () => tmpUserData,
    getVersion: () => '0.0.0-test',
    whenReady: () => Promise.resolve(),
    on: () => {},
    once: () => {},
    quit: () => {},
    requestSingleInstanceLock: () => true,
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }),
    dock: { setIcon: () => {}, show: () => {}, hide: () => {} },
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    on: () => {},
    removeHandler: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  Menu: {
    buildFromTemplate: () => ({}),
    setApplicationMenu: () => {},
    getApplicationMenu: () => null,
  },
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
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

/**
 * The `httpsfilter:ca-*` handlers call core's caTrustStore ops, which spawn
 * `security` — under jest these delegate to these jest.fn()s so no test ever
 * touches a real keychain.
 */
const caTrustOps = {
  trustStatus: jest.fn<(pem: string) => Promise<string>>(async () => 'absent'),
  installCa: jest.fn<(pem: string) => Promise<string>>(async () => 'installed'),
  removeCa: jest.fn<(pem: string) => Promise<string>>(async () => 'removed'),
};

/**
 * index.ts's admin-consent path (`osascript … with administrator privileges`)
 * funnels through `runShellAsAdmin` — under jest it delegates to this fn, so
 * a test can answer the macOS auth sheet without ever showing one.
 */
const runShellAsAdminMock = jest.fn(async (_cmd: string) => ({
  success: true,
  cancelled: false,
  stderr: '',
}));
jest.unstable_mockModule('../adminShell', () => ({
  __esModule: true,
  runShellAsAdmin: (cmd: string) => runShellAsAdminMock(cmd),
}));

// The reputation DB refresh hits the network at boot — stub just that edge and keep the
// real core for everything else (sanitizers, classifiers, formatters under test).
jest.unstable_mockModule('@blockingmachine/core', async () => {
  const actual = await jest.requireActual<typeof import('@blockingmachine/core')>('@blockingmachine/core');
  return {
    ...actual,
    refreshDb: async () => ({ remoteLastFetched: null, applied: false }),
    setDbCacheDirectory: () => {},
    trustStatus: (pem: string) => caTrustOps.trustStatus(pem),
    installCa: (pem: string) => caTrustOps.installCa(pem),
    removeCa: (pem: string) => caTrustOps.removeCa(pem),
  };
});

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler({}, ...args);
}

beforeAll(async () => {
  // Import boots the module: whenReady resolves immediately, initialize() registers the
  // handlers. setImmediate drains the promise chain.
  await import('../index');
  for (let i = 0; i < 50 && handlers.size < 80; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (!capturedStoreRef.current) throw new Error('electron-store was never constructed — boot did not run');
});

describe('IPC boundary — behavioral', () => {
  test('handlers actually registered under a mocked Electron boot', () => {
    expect(handlers.size).toBeGreaterThan(80);
    for (const ch of [
      'save-sources',
      'save-custom-rules',
      'add-threat-quarantine',
      'start-live-radar-session',
      'set-ai-watchdog-config',
      'set-ai-config',
      'set-sinkhole-config',
      'set-webhook-url',
      'get-extension-tier-plan',
    ]) {
      expect(handlers.has(ch)).toBe(true);
    }
  });

  // --- F-01: quarantine feed-line injection -------------------------------------------

  test('F-01: a quarantine domain carrying a newline is refused and never persisted', async () => {
    const poison = {
      id: 'x1',
      domain: 'evil.example\n||allow-everything.example^',
      category: 'Ads',
      verdict: 'malicious',
      riskLevel: 'critical',
      confidence: 0.99,
      reasons: [],
      generatedRules: [],
      source: 'inspector',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const res = await invoke('add-threat-quarantine', [poison]);
    expect(res.success).toBe(false);
    expect(capturedStoreRef.current!.get('aiThreatQuarantine') ?? []).toEqual([]);
  });

  test('F-01: rule-syntax and control-char domains are rejected; the good item in the batch lands', async () => {
    const good = {
      id: 'ok1',
      domain: 'tracker.example.com',
      category: 'Ads',
      verdict: 'suspicious',
      riskLevel: 'medium',
      confidence: 0.9,
      reasons: [],
      generatedRules: [],
      source: 'inspector',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const poison = { ...good, id: 'x2', domain: 'a.com^$important' };
    const res = await invoke('add-threat-quarantine', [poison, good]);
    expect(res.success).toBe(true);
    const stored = capturedStoreRef.current!.get('aiThreatQuarantine') as Array<{ domain: string }>;
    expect(stored.map((i) => i.domain)).toEqual(['tracker.example.com']);
    expect(res.rejected).toHaveLength(1);
  });

  test('F-01: an entry with a poisoned domain is absent from the rendered feed output', async () => {
    // get-compiled-rules aside, the observable sink is the store; assert nothing with a
    // control char ever persists (the renderers emit `||domain^` verbatim).
    const stored = (capturedStoreRef.current!.get('aiThreatQuarantine') as Array<{ domain: string }>) ?? [];
    expect(stored.every((i) => !/[\r\n\0\x00-\x1f^$|@#!,;<>"`']/.test(i.domain))).toBe(true);
  });

  test('F-01 emit boundary: a pre-fix poisoned entry is dropped from LAN feeds', async () => {
    // An entry persisted before the input sanitizer existed (or written by any non-IPC
    // path) must be screened at render time. This exact payload injected a raw
    // `||allow-everything.example^` line into both feeds before the emit-boundary fix.
    capturedStoreRef.current!.set('aiThreatQuarantine', [
      {
        id: 'legacy-poison',
        domain: 'bad.example\n||allow-everything.example^',
        category: 'Ads',
        verdict: 'malicious',
        riskLevel: 'critical',
        confidence: 0.99,
        reasons: [],
        generatedRules: [],
        source: 'inspector',
        timestamp: '2026-01-01T00:00:00Z',
      },
      {
        id: 'legit',
        domain: 'real-threat.example',
        category: 'Malware',
        verdict: 'malicious',
        riskLevel: 'critical',
        confidence: 0.97,
        reasons: [],
        generatedRules: [],
        source: 'inspector',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]);
    const started = await invoke('start-feed-server', 19191);
    expect(started.isRunning).toBe(true);
    try {
      const threats = await (await fetch('http://127.0.0.1:19191/threats.txt')).text();
      const aiThreats = await (await fetch('http://127.0.0.1:19191/ai-threats.txt')).text();
      // The injected line is gone; the legitimate entry still publishes.
      expect(threats).not.toContain('allow-everything');
      expect(aiThreats).not.toContain('allow-everything');
      expect(threats).not.toContain('bad.example');
      expect(threats).toContain('||real-threat.example^');
      expect(aiThreats).toContain('real-threat.example');
    } finally {
      await invoke('stop-feed-server');
      capturedStoreRef.current!.set('aiThreatQuarantine', []);
    }
  });

  // --- F-02: hitsPath oracle -----------------------------------------------------------

  test('F-02: get-extension-tier-plan treats a renderer-supplied hitsPath as a no-op', async () => {
    // Point hitsPath at a file that exists; a vulnerable handler would read it first and
    // merge a ledger into the response. Assert the field changes nothing — with and without
    // it the handler produces byte-identical output (in this env, the same thrown error).
    const probe = join(tmpUserData, 'decoy-ledger.txt');
    writeFileSync(probe, 'a.com\t100\n');
    const settle = async (arg?: { hitsPath?: string }) => {
      try {
        return { ok: true, res: await invoke('get-extension-tier-plan', arg) };
      } catch (e) {
        return { ok: false, res: String(e) };
      }
    };
    const withPath = await settle({ hitsPath: probe });
    const withoutPath = await settle();
    expect(withPath.ok).toBe(withoutPath.ok);
    expect(JSON.stringify(withPath.res)).toBe(JSON.stringify(withoutPath.res));
    expect(JSON.stringify(withPath.res)).not.toContain('decoy-ledger');
  });

  // --- F-06: malformed store payloads --------------------------------------------------

  test('F-06: save-sources rejects non-boolean enabled without persisting', async () => {
    const before = capturedStoreRef.current!.get('filterSources');
    const res = await invoke('save-sources', [{ name: 'x', url: 'https://x', enabled: 'yes' }]);
    expect(res.success).toBe(false);
    expect(capturedStoreRef.current!.get('filterSources')).toEqual(before);
  });

  test('F-06: save-custom-rules rejects a non-string payload', async () => {
    const res = await invoke('save-custom-rules', { not: 'a string' });
    expect(res.success).toBe(false);
    expect(capturedStoreRef.current!.get('customRules')).toBe('');
  });

  test('F-06: set-additional-formats rejects an unknown format name', async () => {
    const res = await invoke('set-additional-formats', ['hosts', 'definitely-not-a-format']);
    expect(res.success).toBe(false);
  });

  test('F-06: set-auto-schedule rejects an out-of-enum value', async () => {
    const res = await invoke('set-auto-schedule', 'every-37-seconds');
    expect(res.success).toBe(false);
    expect(capturedStoreRef.current!.get('autoSchedule')).toBe('disabled');
  });

  test('F-06: set-webhook-url rejects non-http(s) and unparseable URLs', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 42]) {
      const res = await invoke('set-webhook-url', bad);
      expect(res.success).toBe(false);
    }
    expect(capturedStoreRef.current!.get('webhookUrl')).toBe('');
  });

  test('F-06: start-live-radar-session rejects a NaN-producing pollIntervalSeconds', async () => {
    // The original defect: Math.min(60, 'fast') → NaN → setInterval(≈1ms) busy-loop.
    const res = await invoke('start-live-radar-session', {
      service: 'adguard',
      durationMinutes: 5,
      pollIntervalSeconds: 'fast',
    });
    expect(res.active).not.toBe(true);
    expect(res.notice).toMatch(/pollIntervalSeconds/);
  });

  test('F-06: start-live-radar-session rejects a non-number durationMinutes', async () => {
    const res = await invoke('start-live-radar-session', {
      service: 'pihole',
      durationMinutes: 'forever',
    });
    expect(res.active).not.toBe(true);
  });

  test('F-06: set-ai-watchdog-config rejects a NaN intervalMinutes and drops adaptive fields', async () => {
    const bad = await invoke('set-ai-watchdog-config', { enabled: true, intervalMinutes: 'hourly' });
    expect(bad.success).toBe(false);

    const res = await invoke('set-ai-watchdog-config', {
      enabled: true,
      intervalMinutes: 30,
      adaptiveIntervalMinutes: 1, // renderer must not pin the adaptive cadence
      cadenceReason: 'forged',
    });
    expect(res.success).toBe(true);
    const stored = capturedStoreRef.current!.get('aiWatchdogConfig') as Record<string, unknown>;
    expect(stored.intervalMinutes).toBe(30);
    expect(stored.adaptiveIntervalMinutes).toBeUndefined();
    expect(stored.cadenceReason).toBeUndefined();
  });

  test('F-06: set-ai-config cannot inject apiKeyEncrypted or spoof encryptionAvailable', async () => {
    const res = await invoke('set-ai-config', {
      provider: 'openai',
      apiKeyEncrypted: 'attacker-blob',
      encryptionAvailable: true,
      provider2: 'unexpected',
    });
    expect(res.success).toBe(true);
    const stored = capturedStoreRef.current!.get('aiConfig') as Record<string, unknown>;
    expect(stored.provider).toBe('openai');
    expect(stored.apiKeyEncrypted).toBeUndefined();
    expect(stored.encryptionAvailable).toBeUndefined();
    expect(stored.provider2).toBeUndefined();
  });

  test('F-06: set-sinkhole-config rejects a non-string piholeUrl and drops unknown keys', async () => {
    const bad = await invoke('set-sinkhole-config', { piholeUrl: 8080 });
    expect(bad.success).toBe(false);

    const res = await invoke('set-sinkhole-config', { piholeUrl: 'http://192.168.1.5', garbage: { deep: true } });
    expect(res.success).toBe(true);
    expect(capturedStoreRef.current!.get('piholeUrl')).toBe('http://192.168.1.5');
    expect(capturedStoreRef.current!.get('garbage')).toBeUndefined();
  });

  // --- giant / pathological payloads ---------------------------------------------------

  test('oversized quarantine batch is handled without throwing', async () => {
    const huge = Array.from({ length: 5000 }, (_, i) => ({
      id: `h${i}`,
      domain: i % 2 ? `d${i}.example.com` : `bad\n${i}`,
      category: 'Ads',
      verdict: 'suspicious',
      riskLevel: 'medium',
      confidence: 0.9,
      reasons: [],
      generatedRules: [],
      source: 'inspector',
      timestamp: '2026-01-01T00:00:00Z',
    }));
    const res = await invoke('add-threat-quarantine', huge);
    expect(typeof res.success).toBe('boolean');
    const stored = capturedStoreRef.current!.get('aiThreatQuarantine') as unknown[];
    expect(stored.length).toBeLessThanOrEqual(200); // ledger cap holds
    expect(stored.every((i: any) => typeof i.domain === 'string' && !/\n/.test(i.domain))).toBe(true);
  });

  test('non-object/null/undefined payloads fail cleanly rather than throwing', async () => {
    for (const bad of [null, undefined, 'x', 42]) {
      for (const ch of ['save-sources', 'set-ai-watchdog-config', 'set-sinkhole-config']) {
        const res = await invoke(ch, bad);
        expect(res.success).not.toBe(true);
      }
    }
  });

  test('prototype-pollution-shaped payloads cannot touch the store or Object.prototype', async () => {
    const dirty = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}');
    const res = await invoke('set-ai-watchdog-config', dirty);
    // Whitelist semantics: __proto__/constructor are not config fields — ignored.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const stored = capturedStoreRef.current!.get('aiWatchdogConfig') as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain('__proto__');
    expect(Object.keys(stored)).not.toContain('constructor');
    void res;
  });

  test('empty arrays are semantically valid for list channels and refused by object channels', async () => {
    expect((await invoke('save-sources', [])).success).toBe(true);
    expect((await invoke('set-ai-watchdog-config', [])).success).not.toBe(true);
    expect((await invoke('set-sinkhole-config', [])).success).not.toBe(true);
  });

  // --- F-07: remote-content echo bounds ------------------------------------------------

  const withStubServer = async (payload: unknown, run: (url: string) => Promise<void>) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };

  test('F-07: a hostile Ollama endpoint cannot push an oversized model echo through IPC', async () => {
    await withStubServer(
      {
        models: [
          { name: 'x'.repeat(50_000) },                       // giant single name
          ...Array.from({ length: 5000 }, (_, i) => ({ name: `m${i}` })), // giant list
          { name: 12345 },                                     // non-string name
          { name: null },
          'a plain string model',
          { noName: true },
        ],
      },
      async (url) => {
        const res = await invoke('test-ai-connection', { provider: 'ollama', ollamaUrl: url });
        expect(res.success).toBe(true);
        expect(res.message).toContain('Connected to Ollama');
        // Bounded: ≤50 names, ≤120 chars each, plus the fixed prefix — nowhere near the
        // ~50KB+5000-name payload the endpoint tried to push.
        expect(res.message.length).toBeLessThan(120 * 50 + 200);
        expect(res.message).not.toContain('x'.repeat(121));
        expect(res.message).not.toContain('m4999');
        expect(res.message).not.toContain('12345');
      },
    );
  });

  test('AI connectivity: an Ollama 3xx is refused rather than followed', async () => {
    // `redirect: manual` — a redirect on an API POST is never a real answer, and
    // following could carry the request cross-origin.
    const server: Server = createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://attacker.example/tags' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await invoke('test-ai-connection', {
        provider: 'ollama',
        ollamaUrl: `http://127.0.0.1:${port}`,
      });
      expect(res.success).toBe(false);
      expect(res.message).toContain('redirect');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('AI connectivity: an oversized /api/tags body is rejected before parsing', async () => {
    // The name-echo bound limits the *reply*; without a body bound a hostile endpoint
    // could still stream megabytes into the main process's heap.
    const huge = `{"models":${JSON.stringify([{ name: 'x' }])} ,"pad":"${'p'.repeat(2_000_000)}"}`;
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(huge);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await invoke('test-ai-connection', {
        provider: 'ollama',
        ollamaUrl: `http://127.0.0.1:${port}`,
      });
      expect(res.success).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('AI connectivity: link-local/metadata endpoints are refused without a request', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal', 'http://[fe80::1]/api']) {
      const res = await invoke('test-ai-connection', { provider: 'ollama', ollamaUrl: bad });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Refused');
    }
    // Non-http(s) schemes are refused too — no file:, gopher:, ftp: probing.
    const file = await invoke('test-ai-connection', { provider: 'ollama', ollamaUrl: 'file:///etc/passwd' });
    expect(file.success).toBe(false);
  });

  test('AI connectivity: ordinary LAN and loopback endpoints still work', async () => {
    // The whole point of the feature — RFC1918 and loopback are legitimate servers.
    // URL-class assertion for a LAN address (no network needed).
    const { isSafeLanEndpointUrl } = await import('@blockingmachine/core');
    expect(isSafeLanEndpointUrl('http://192.168.1.20:11434').isSafe).toBe(true);
    expect(isSafeLanEndpointUrl('http://10.0.0.5').isSafe).toBe(true);
    expect(isSafeLanEndpointUrl('http://127.0.0.1:11434').isSafe).toBe(true);
    expect(isSafeLanEndpointUrl('http://[fd00::1]:11434').isSafe).toBe(true);

    // A hung-but-reachable LAN server hits the 5s abort and fails cleanly.
    const server: Server = createServer((_req, _res) => {
      // Never responds — the AbortSignal is the deadline.
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await invoke('test-ai-connection', {
        provider: 'ollama',
        ollamaUrl: `http://127.0.0.1:${port}`,
      });
      expect(res.success).toBe(false);
      expect(res.message).not.toContain('Refused');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 8000);

  // --- LAN feed trust boundary --------------------------------------------------------

  test('LAN boundary: a .local-origin drive-by POST reaches the daemon-control handler', async () => {
    // Reproduction (pre-fix behavior documented): any page served from a mDNS-claimed
    // `*.local` hostname could POST mutations with no feedToken configured. Assert the
    // request is now rejected at the origin gate (403) rather than reaching the handler
    // (which answers 200/400/502 depending on daemon state — never 403).
    const started = await invoke('start-feed-server', 19192);
    expect(started.isRunning).toBe(true);
    try {
      const res = await fetch('http://127.0.0.1:19192/v1/control/daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://evil-printer.local' },
        body: JSON.stringify({ action: 'stop' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: loopback, extension schemes and no-Origin clients still work', async () => {
    const started = await invoke('start-feed-server', 19193);
    expect(started.isRunning).toBe(true);
    try {
      // No Origin — native clients (mobile RN, HA integration, curl, dnsmasq pullers).
      const native = await fetch('http://127.0.0.1:19193/v1/status');
      expect(native.status).toBe(200);
      // Loopback browser origin — local tools/dashboards keep working.
      const local = await fetch('http://127.0.0.1:19193/v1/status', {
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(local.status).toBe(200);
      // Browser-extension origin — the extension's telemetry/SSE origin class.
      const ext = await fetch('http://127.0.0.1:19193/v1/status', {
        headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
      });
      expect(ext.status).toBe(200);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: .local origin is also rejected on the SSE stream', async () => {
    const started = await invoke('start-feed-server', 19194);
    expect(started.isRunning).toBe(true);
    try {
      const res = await fetch('http://127.0.0.1:19194/v1/events', {
        headers: { Origin: 'http://rogue-mdns.local', Accept: 'text/event-stream' },
      });
      // EventSource always sends Origin — the browser-mediated telemetry-read vector
      // closes with the same origin tightening (native SSE clients send no Origin).
      expect(res.status).toBe(403);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: unguarded reads leak nothing to a foreign origin', async () => {
    // /v1/status and /v1/telemetry were unguarded while answering
    // `Access-Control-Allow-Origin: *` — any web page could read recentTrackers,
    // the LAN IP, and the quarantined-threat list. Now origin-gated like events.
    const started = await invoke('start-feed-server', 19195);
    expect(started.isRunning).toBe(true);
    try {
      for (const path of ['/v1/status', '/v1/telemetry', '/v1/check?domain=x.example']) {
        const res = await fetch(`http://127.0.0.1:19195${path}`, {
          headers: { Origin: 'https://attacker.example' },
        });
        expect(res.status).toBe(403);
      }
      // Native/loopback clients still work.
      const ok = await fetch('http://127.0.0.1:19195/v1/status');
      expect(ok.status).toBe(200);
      const ext = await fetch('http://127.0.0.1:19195/v1/check?domain=x.example', {
        headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
      });
      expect(ext.status).toBe(200);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: a configured feedToken is required regardless of Origin presence', async () => {
    // Omitting Origin must not bypass the bearer — tokenless access is only possible
    // when no token is configured (legacy mode). And a valid bearer must not rescue a
    // forbidden origin — the controls are independent.
    capturedStoreRef.current!.set('feedToken', 'tt-secret-token-0123456789');
    const started = await invoke('start-feed-server', 19196);
    expect(started.isRunning).toBe(true);
    const post = (headers: Record<string, string>) =>
      fetch('http://127.0.0.1:19196/v1/control/daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'stop' }),
      });
    try {
      // No Origin, no bearer → 401 (native client on a token-configured hub).
      expect((await post({})).status).toBe(401);
      // No Origin, wrong bearer → 401.
      expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401);
      // No Origin, right bearer → past the auth gate (handler verdict may vary, never 401/403).
      const goodNative = await post({ Authorization: 'Bearer tt-secret-token-0123456789' });
      expect([200, 400, 502]).toContain(goodNative.status);
      // Forbidden origin + valid bearer → still 403: the token does not soften origin.
      expect(
        (await post({ Origin: 'https://evil.example', Authorization: 'Bearer tt-secret-token-0123456789' })).status,
      ).toBe(403);
      // Extension origin + valid bearer → through both gates.
      const goodExt = await post({
        Origin: 'chrome-extension://abcdefghijklmnop',
        Authorization: 'Bearer tt-secret-token-0123456789',
      });
      expect([200, 400, 502]).toContain(goodExt.status);
      // Telemetry reads require the bearer too once configured.
      const statusNoAuth = await fetch('http://127.0.0.1:19196/v1/status');
      expect(statusNoAuth.status).toBe(401);
      const statusAuth = await fetch('http://127.0.0.1:19196/v1/status', {
        headers: { Authorization: 'Bearer tt-secret-token-0123456789' },
      });
      expect(statusAuth.status).toBe(200);
    } finally {
      capturedStoreRef.current!.set('feedToken', '');
      await invoke('stop-feed-server');
    }
  });

  test('Pairing: generated tokens are CSPRNG-strong, sealed at rest, and QR-carried; weak user tokens refused', async () => {
    // Entropy floor: hand-typed tokens below 16 chars are rejected on write — the
    // token is the only mutation gate on an open LAN.
    const weak = await invoke('set-feed-token', '1234');
    expect(weak.success).toBe(false);
    expect(weak.error).toMatch(/16/);
    expect(capturedStoreRef.current!.get('feedToken')).toBeFalsy();

    // Generated: 192-bit CSPRNG, base64url (24 bytes → 32 chars), persisted through
    // the sealed path and unique across calls.
    const gen1 = await invoke('generate-feed-token');
    expect(gen1.success).toBe(true);
    expect(gen1.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const gen2 = await invoke('generate-feed-token');
    expect(gen2.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(gen2.token).not.toBe(gen1.token);
    // The sealed store holds the latest token; the renderer-visible handle can be
    // dropped after display without losing the credential.
    expect(capturedStoreRef.current!.get('feedToken')).toBe(gen2.token);

    // Pairing payload embeds the token so mobile can pair without typing it — and
    // the same token authenticates a real mutation over the wire.
    const pairing = await invoke('get-feed-pairing-payload');
    expect(pairing.success).toBe(true);
    const payload = JSON.parse(pairing.payload);
    expect(payload.v).toBe(1);
    expect(payload.url).toMatch(/^https?:\/\//);
    expect(payload.token).toBe(gen2.token);

    const started = await invoke('start-feed-server', 19198);
    expect(started.isRunning).toBe(true);
    try {
      const denied = await fetch('http://127.0.0.1:19198/v1/protection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(denied.status).toBe(401);
      const paired = await fetch('http://127.0.0.1:19198/v1/protection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gen2.token}`,
        },
        body: JSON.stringify({ enabled: false }),
      });
      // Past both gates — the verdict is handler-level (503 = daemon absent in the
      // harness); anything but 401/403 proves the paired token authenticated.
      expect(paired.status).not.toBe(401);
      expect(paired.status).not.toBe(403);
    } finally {
      await invoke('clear-feed-token');
      capturedStoreRef.current!.set('feedToken', '');
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: OPTIONS preflight is satisfied without offering POST', async () => {
    const started = await invoke('start-feed-server', 19197);
    expect(started.isRunning).toBe(true);
    try {
      const res = await fetch('http://127.0.0.1:19197/v1/control/daemon', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://attacker.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(204);
      // The advertised methods never include POST — a browser preflight for a
      // mutation fails here, before the request even exists.
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('LAN boundary: an oversized mutation body is destroyed, not parsed', async () => {
    const started = await invoke('start-feed-server', 19198);
    expect(started.isRunning).toBe(true);
    try {
      const res = await fetch('http://127.0.0.1:19198/v1/control/cosmetics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"enabled":true,"pad":"${'x'.repeat(2_000_000)}"}`,
      }).catch((err) => ({ status: -1, error: String(err) }));
      // The socket is destroyed mid-upload — fetch sees a connection failure or a
      // clean refusal, but never a 200 that parsed a 2MB body.
      expect(res.status).not.toBe(200);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  // --- Concurrent atomic feed writes --------------------------------------------------

  test('concurrent feed persists are ordered: newest snapshot wins, no tmp debris', async () => {
    const { mkdirSync, readFileSync, readdirSync } = await import('node:fs');
    const feedDir = join(tmpUserData, 'feeds');
    mkdirSync(feedDir, { recursive: true });
    capturedStoreRef.current!.set('savePath', join(feedDir, 'browser.txt'));
    // The quarantine ledger caps at 200 entries — earlier tests filled it, and
    // cap-evicted adds never reach the persist. Start clean for a deterministic set.
    capturedStoreRef.current!.set('aiThreatQuarantine', []);
    const mk = (i: number) => ({
      id: `c${i}`,
      domain: `conc-${i}.example.com`,
      category: 'Ads',
      verdict: 'malicious',
      riskLevel: 'high',
      confidence: 0.95,
      reasons: [],
      generatedRules: [],
      source: 'inspector',
      timestamp: '2026-01-01T00:00:00Z',
    });
    // Each add fires a fire-and-forget threats.txt persist carrying a newer snapshot.
    // Without per-path ordering an earlier snapshot's rename could land last — the
    // newest domains would be missing from the file dnsmasq serves.
    for (let i = 0; i < 40; i++) {
      await invoke('add-threat-quarantine', [mk(i)]);
    }
    // Drain the queued persists.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 300));
    const content = readFileSync(join(feedDir, 'threats.txt'), 'utf8');
    const missing = Array.from({ length: 40 }, (_, i) => i).filter(
      (i) => !content.includes(`||conc-${i}.example.com^`),
    );
    expect(missing).toEqual([]);
    // Every write leaves its sibling tmp cleaned up.
    expect(readdirSync(feedDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  // --- Write-only AI credentials ----------------------------------------------------

  test('AI API key never crosses IPC: masked read, keep-on-empty write, stored-key pairing', async () => {
    const set = await invoke('set-ai-config', {
      provider: 'openai',
      apiKey: 'sk-secret-under-test-9Zx7',
      apiEndpoint: 'https://api.stored.example/v1',
    });
    expect(set.success).toBe(true);

    // get-ai-config reports that a key exists and a display hint — never the secret.
    const cfg = await invoke('get-ai-config');
    expect(cfg.apiKey).toBe('');
    expect(cfg.apiKeySet).toBe(true);
    expect(cfg.apiKeyHint).toBe('…9Zx7');
    expect(cfg.provider).toBe('openai');
    expect(cfg.apiEndpoint).toBe('https://api.stored.example/v1');

    // Round-trip safety: the settings UI saves the masked reply verbatim; an empty
    // apiKey field must mean "keep" — the stored key and its hint must survive.
    const resave = await invoke('set-ai-config', cfg);
    expect(resave.success).toBe(true);
    const after = await invoke('get-ai-config');
    expect(after.apiKeySet).toBe(true);
    expect(after.apiKeyHint).toBe('…9Zx7');
  });

  test('test-ai-connection: stored key answers at the STORED endpoint, never a renderer-named one', async () => {
    const set = await invoke('set-ai-config', {
      provider: 'openai',
      apiKey: 'sk-paired-endpoint-key-Ab12',
      apiEndpoint: 'https://api.stored.example/v1',
    });
    expect(set.success).toBe(true);

    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"data":[]}'));
    try {
      const res = await invoke('test-ai-connection', {
        provider: 'openai',
        apiKey: '', // "use the stored key" — write-only contract
        apiEndpoint: 'https://attacker.example',
      });
      expect(res.success).toBe(true);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      // The sealed key went to its paired endpoint — the renderer-named endpoint
      // was ignored because no renderer key accompanied it.
      expect(String(calledUrl)).toBe('https://api.stored.example/v1/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-paired-endpoint-key-Ab12',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('F-07: a non-JSON / malformed-body Ollama response fails cleanly', async () => {
    await withStubServer('<not json>', async (url) => {
      const res = await invoke('test-ai-connection', { provider: 'ollama', ollamaUrl: url });
      // res.json() throws → caught by the handler's try/catch → clean failure.
      expect(res.success).toBe(false);
      expect(typeof res.message).toBe('string');
    });
  });

  test('F-07: a missing models field degrades to the "ready" fallback, not a crash', async () => {
    await withStubServer({ unrelated: true }, async (url) => {
      const res = await invoke('test-ai-connection', { provider: 'ollama', ollamaUrl: url });
      expect(res.success).toBe(true);
      expect(res.message).toContain('ready');
    });
  });
});

// --- D-1: lanAuthMode — secured default for new installs, explicit compat otherwise ---------

describe('LAN auth modes (D-1)', () => {
  test('an existing install boots in the legacy posture — lanAuthMode is never auto-written', async () => {
    // The harness seeded a config file, so `installHadPriorState` marked this an
    // existing install at store construction: no mode write, no token mint — the
    // exact compat guarantee the upgrade path must keep.
    expect(capturedStoreRef.current!.get('lanAuthMode')).toBeUndefined();
    const res = await invoke('get-feed-token');
    expect(res.mode).toBe('legacy');
  });

  test('set-lan-auth-mode validates, persists, and mints only when required needs it', async () => {
    const bad = await invoke('set-lan-auth-mode', 'sometimes');
    expect(bad.success).toBe(false);
    expect(capturedStoreRef.current!.get('lanAuthMode')).not.toBe('sometimes');

    const open = await invoke('set-lan-auth-mode', 'open');
    expect(open.success).toBe(true);
    expect(open.tokenMinted).toBe(false);
    expect(capturedStoreRef.current!.get('lanAuthMode')).toBe('open');

    const req = await invoke('set-lan-auth-mode', 'required');
    expect(req.success).toBe(true);
    expect(req.tokenMinted).toBe(true);
    const minted = capturedStoreRef.current!.get('feedToken') as string;
    expect(minted).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const reported = await invoke('get-feed-token');
    expect(reported).toEqual({ configured: true, mode: 'required' });
  });

  test('required mode over the wire: natives need the bearer, telemetry reads too, nothing leaks the token', async () => {
    const token = capturedStoreRef.current!.get('feedToken') as string;
    const started = await invoke('start-feed-server', 19200);
    expect(started.isRunning).toBe(true);
    try {
      const post = (headers: Record<string, string>) =>
        fetch('http://127.0.0.1:19200/v1/protection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ enabled: true }),
        });
      // Native client without credentials — refused (Origin absence is not a bypass).
      expect((await post({})).status).toBe(401);
      // Native client properly authenticated without an Origin header — the
      // mobile/HA/curl shape that must keep working.
      const nativeOk = await post({ Authorization: `Bearer ${token}` });
      expect(nativeOk.status).not.toBe(401);
      expect(nativeOk.status).not.toBe(403);
      // Telemetry-bearing reads gate the same way.
      expect((await fetch('http://127.0.0.1:19200/v1/status')).status).toBe(401);
      const authed = await fetch('http://127.0.0.1:19200/v1/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authed.status).toBe(200);
      // The credential must not appear in a status payload — it is write-only.
      expect(JSON.stringify(await authed.json())).not.toContain(token);
      // A forbidden browser origin is still refused even with the right bearer.
      const evil = await post({
        Origin: 'https://evil.example',
        Authorization: `Bearer ${token}`,
      });
      expect(evil.status).toBe(403);
    } finally {
      await invoke('stop-feed-server');
    }
  });

  test('clear-feed-token under required mode rotates — the surface is never left without a credential', async () => {
    const before = capturedStoreRef.current!.get('feedToken') as string;
    const res = await invoke('clear-feed-token');
    expect(res.success).toBe(true);
    expect(res.rotated).toBe(true);
    const after = capturedStoreRef.current!.get('feedToken') as string;
    expect(after).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(after).not.toBe(before);
    expect((await invoke('get-feed-token')).configured).toBe(true);
  });

  test('open mode suppresses enforcement while a stored token stays honoured', async () => {
    const open = await invoke('set-lan-auth-mode', 'open');
    expect(open.success).toBe(true);
    const started = await invoke('start-feed-server', 19201);
    expect(started.isRunning).toBe(true);
    try {
      // Compat contract: no credential demanded anywhere — reads and mutations.
      expect((await fetch('http://127.0.0.1:19201/v1/status')).status).toBe(200);
      const post = await fetch('http://127.0.0.1:19201/v1/protection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(post.status).not.toBe(401);
    } finally {
      await invoke('stop-feed-server');
    }
    // Restore the legacy posture so nothing that runs after inherits a mode.
    capturedStoreRef.current!.delete('lanAuthMode');
    capturedStoreRef.current!.set('feedToken', '');
  });
});

// ============================================================================
// httpsfilter:ca-* — CA trust-store IPC (P1 Task 4)
// ============================================================================
// The engine's CA PEM arrives via a stubbed global fetch (the manager's
// getCaInfo GETs /v1/proxy/ca on :9293); the core trust ops and index.ts's
// execFile (osascript only) are module-mocked, so these run nowhere near a
// real keychain or a real macOS auth sheet.
describe('httpsfilter:ca-* IPC handlers', () => {
  const CA_JSON = {
    certPem: '-----BEGIN CERTIFICATE-----\nSTUB\n-----END CERTIFICATE-----\n',
    sha256Fingerprint: 'AA:BB:CC',
    notAfter: 'Jan  1 00:00:00 2036 GMT',
    keyWrapped: true,
  };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(CA_JSON), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    caTrustOps.trustStatus.mockReset().mockResolvedValue('absent');
    caTrustOps.installCa.mockReset().mockResolvedValue('installed');
    caTrustOps.removeCa.mockReset().mockResolvedValue('removed');
    runShellAsAdminMock
      .mockReset()
      .mockResolvedValue({ success: true, cancelled: false, stderr: '' });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('ca-trust-status probes with the engine PEM and reports state + fingerprint', async () => {
    caTrustOps.trustStatus.mockResolvedValue('trusted');
    const res = await invoke('httpsfilter:ca-trust-status');
    expect(res.success).toBe(true);
    expect(res.state).toBe('trusted');
    expect(res.sha256Fingerprint).toBe('AA:BB:CC');
    expect(caTrustOps.trustStatus).toHaveBeenCalledWith(CA_JSON.certPem);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v1/proxy/ca');
  });

  test('a dead engine answers unavailable without touching the trust store', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await invoke('httpsfilter:ca-trust-status');
    expect(res.success).toBe(false);
    expect(res.state).toBe('unavailable');
    expect(caTrustOps.trustStatus).not.toHaveBeenCalled();
  });

  test('ca-install runs the unprivileged install and repaints state', async () => {
    caTrustOps.installCa.mockResolvedValue('installed');
    caTrustOps.trustStatus.mockResolvedValue('trusted');
    const res = await invoke('httpsfilter:ca-install');
    expect(res.success).toBe(true);
    expect(res.state).toBe('trusted');
    expect(caTrustOps.installCa).toHaveBeenCalledWith(CA_JSON.certPem);
    // No admin sheet was shown for a clean unprivileged install.
    expect(runShellAsAdminMock).not.toHaveBeenCalled();
  });

  test('ca-install needs-admin is a state, not an escalation — no osascript until elevate', async () => {
    caTrustOps.installCa.mockResolvedValue('needs-admin');
    const res = await invoke('httpsfilter:ca-install');
    expect(res.success).toBe(false);
    expect(res.state).toBe('needs-admin');
    expect(res.needsAdmin).toBe(true);
    expect(runShellAsAdminMock).not.toHaveBeenCalled();
  });

  test('ca-install {elevate:true} reaches for the osascript admin prompt', async () => {
    caTrustOps.trustStatus.mockResolvedValue('trusted');
    const res = await invoke('httpsfilter:ca-install', { elevate: true });
    expect(res.success).toBe(true);
    expect(res.state).toBe('trusted');
    // installCa is skipped; the shell line handed to the admin prompt
    // carries the same add-trusted-cert invocation the core runner uses.
    expect(caTrustOps.installCa).not.toHaveBeenCalled();
    expect(runShellAsAdminMock).toHaveBeenCalledTimes(1);
    const [cmd] = runShellAsAdminMock.mock.calls[0] as [string];
    expect(cmd).toContain('security add-trusted-cert -d -r trustRoot');
    expect(cmd).toContain('login.keychain-db');
    expect(cmd).toMatch(/bm-ca-.*\.pem/);
  });

  test('ca-install surfaces a declined admin sheet as needs-admin', async () => {
    runShellAsAdminMock.mockResolvedValue({
      success: false,
      cancelled: true,
      stderr: 'User canceled. (-128)',
    });
    const res = await invoke('httpsfilter:ca-install', { elevate: true });
    expect(res.success).toBe(false);
    expect(res.needsAdmin).toBe(true);
    expect(res.message).toContain('declined');
  });

  test('ca-uninstall removes and repaints absent', async () => {
    const res = await invoke('httpsfilter:ca-uninstall');
    expect(res.success).toBe(true);
    expect(res.state).toBe('absent');
    expect(caTrustOps.removeCa).toHaveBeenCalledWith(CA_JSON.certPem);
  });
});

// ============================================================================
// httpsfilter:status|start|stop|toggle-pause|pins|pin-remove (P1 Task 5)
// ============================================================================
// The handlers delegate to the filterProxyManager singleton, whose control
// calls are loopback fetches — the same `jest.spyOn(fetch)` stub the ca-*
// block uses. `start` is exercised only on the already-active path: the
// spawn path belongs to filterProxyManager.test.ts's fixture engine, and a
// mocked-fetch 'stopped' here would spawn a real child under jest.
describe('httpsfilter:* lifecycle + policy IPC handlers', () => {
  const STATUS_JSON = {
    status: 'running',
    dataPort: 9294,
    controlPort: 9293,
    protectionEnabled: true,
    paused: false,
    policyDegraded: false,
    rulesLoaded: 42,
    uptimeSeconds: 7,
    stats: {
      flowsTotal: 10,
      flowsBlocked: 2,
      requestsBlocked: 3,
      flowsTunneled: 4,
      flowsTerminated: 6,
      pinsLearned: 1,
      rulesSize: 42,
      blockRatePercent: 30,
    },
  };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('status maps the engine payload and carries the platform hint', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, STATUS_JSON));
    const res = await invoke('httpsfilter:status');
    expect(res.status).toBe('running');
    expect(res.port).toBe(9294);
    expect(res.rulesLoaded).toBe(42);
    expect(res.stats.flowsTerminated).toBe(6);
    expect(res.platform).toBe(process.platform);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v1/proxy/status');
  });

  test('status reports stopped (with platform) when the engine is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await invoke('httpsfilter:status');
    expect(res.status).toBe('stopped');
    expect(res.platform).toBe(process.platform);
  });

  test('start answers already-active rather than double-spawning a live engine', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, STATUS_JSON));
    const res = await invoke('httpsfilter:start');
    expect(res.success).toBe(true);
    expect(res.message).toContain('already active');
  });

  test('stop refuses honestly when the app owns no engine process', async () => {
    const res = await invoke('httpsfilter:stop');
    // No child was spawned in this boot — the answer is either the
    // launchd/capture-service pointer or the external-owner message; both
    // are honest refusals with a named remedy, never a silent success.
    expect(res.success).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
  });

  test('toggle-pause POSTs {enabled:false} to the engine toggle', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { success: true, protectionEnabled: false, paused: true }),
    );
    const res = await invoke('httpsfilter:toggle-pause', false);
    expect(res).toEqual({ success: true, protectionEnabled: false });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/proxy/toggle');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  test('pins returns the ledger; a dead engine answers success:false with an empty list', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        pins: [
          { ts: 1, host: 'a.example', action: 'pin', reason: 'handshake-abort' },
          { ts: 2, host: 'b.example', action: 'bypass' },
        ],
        corruptLineCount: 1,
      }),
    );
    const res = await invoke('httpsfilter:pins');
    expect(res.success).toBe(true);
    expect(res.pins).toHaveLength(2);
    expect(res.corruptLineCount).toBe(1);

    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const dead = await invoke('httpsfilter:pins');
    expect(dead.success).toBe(false);
    expect(dead.pins).toEqual([]);
  });

  test('pin-remove POSTs {host} and refuses invalid hosts before any fetch', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { success: true, host: 'a.example', pinned: false, bypassed: false }),
    );
    const ok = await invoke('httpsfilter:pin-remove', 'a.example');
    expect(ok.success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/proxy/pins/remove');
    expect(JSON.parse(String(init.body))).toEqual({ host: 'a.example' });

    fetchSpy.mockClear();
    for (const bad of [42, '', '   ', 'x'.repeat(254), null, undefined, { host: 'a.example' }]) {
      const res = await invoke('httpsfilter:pin-remove', bad);
      expect(res.success).toBe(false);
      expect(res.message).toContain('hostname');
    }
    // None of the invalid payloads reached the engine.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

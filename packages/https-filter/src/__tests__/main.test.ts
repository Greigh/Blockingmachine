/**
 * Spawnable-entry contract — `dist/main.js` run as a plain Node script, the
 * same way `filterProxyManager` (and later the launchd plist) spawns it:
 * `BM_*` env in, a bound-ports stderr line + `/v1/proxy/*` control answers on
 * success, exit 2 when `BM_STORE_DIR` is absent, clean exit 0 on SIGTERM.
 *
 * The suite runs the REAL emitted file — spawning `src/` under ts-jest's
 * module mapping would test the harness, not the artifact the launchers
 * invoke. CI builds every workspace before `test`, so `dist/` exists there;
 * `beforeAll` compiles it when a bare `jest` run finds it missing, and the
 * spawn itself also needs `@blockingmachine/core`'s dist (same precondition).
 */

import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from '../main.js';

jest.setTimeout(60_000);

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = join(PKG_DIR, 'dist', 'main.js');
const TSC = join(PKG_DIR, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];

// The cold-build tsc bound is 180s — the hook must outlive it or jest aborts
// the still-compiling beforeAll at the 60s test default (F9). A warm cache
// (dist/ already emitted) returns instantly either way.
beforeAll(() => {
  if (!existsSync(ENTRY)) {
    execFileSync(process.execPath, [TSC, '-p', join(PKG_DIR, 'tsconfig.json')], {
      stdio: 'inherit',
      timeout: 180_000,
    });
  }
}, 200_000);

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

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

/**
 * Spawn `dist/main.js` with a scrubbed env: ambient `BM_*` from the caller's
 * shell must never leak into the contract under test (a stray BM_STORE_DIR
 * would turn the missing-env case into a real boot). `BM_KEYWRAP=off` is the
 * hermetic baseline — a suite-spawned engine must never probe or write the
 * real login keychain; a test that wants the auto-resolve path overrides it.
 */
function spawnEngine(env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('BM_')) cleanEnv[key] = value;
  }
  let errBuf = '';
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...cleanEnv, BM_KEYWRAP: 'off', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    errBuf += String(chunk);
  });
  children.push(child);
  return { child, stderr: () => errBuf };
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

/** Poll the control port until it answers or the child dies — spawn() returning is not "up". */
async function waitForStatus(child: ChildProcess, controlPort: number): Promise<any> {
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error('engine exited before its control API answered');
    try {
      const res = await fetch(`http://127.0.0.1:${controlPort}/v1/proxy/status`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('engine control API never answered');
}

describe('configFromEnv', () => {
  test('requires BM_STORE_DIR', () => {
    const parsed = configFromEnv({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('BM_STORE_DIR');
  });

  test('falls back to default ports and bind host on garbage', () => {
    const parsed = configFromEnv({
      BM_STORE_DIR: '/tmp/x',
      BM_DATA_PORT: 'not-a-port',
      BM_CONTROL_PORT: '99999',
      BM_BIND_HOST: '  ',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.dataPort).toBe(9294);
      expect(parsed.config.controlPort).toBe(9293);
      expect(parsed.config.bindHost).toBe('127.0.0.1');
      expect(parsed.config.rulesPath).toBeUndefined();
    }
  });

  test('rejects hex/exponent/signed port spellings Number() would accept', () => {
    for (const bogus of ['0x10', '4e2', '+443', '-1', '443.5', '65536', 'junk443']) {
      const parsed = configFromEnv({
        BM_STORE_DIR: '/tmp/x',
        BM_DATA_PORT: bogus,
        BM_CONTROL_PORT: bogus,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.config.dataPort).toBe(9294);
        expect(parsed.config.controlPort).toBe(9293);
      }
    }
  });

  test('BM_KEYWRAP=off|none|0 pins keyWrapBackend:null; anything else auto-resolves', () => {
    for (const pin of ['off', 'none', '0', ' OFF ']) {
      const parsed = configFromEnv({ BM_STORE_DIR: '/tmp/x', BM_KEYWRAP: pin });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.config.keyWrapBackend).toBeNull();
    }
    // Unset, or an unrecognised value, leaves the field absent — the engine
    // then auto-resolves the platform keystore at CertAuthority.open.
    for (const auto of [undefined, 'keychain', 'on']) {
      const parsed = configFromEnv({
        BM_STORE_DIR: '/tmp/x',
        ...(auto === undefined ? {} : { BM_KEYWRAP: auto }),
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.config.keyWrapBackend).toBeUndefined();
    }
  });

  test('honours explicit ports, bind host and rules path', () => {
    const parsed = configFromEnv({
      BM_STORE_DIR: '/tmp/x',
      BM_DATA_PORT: '19294',
      BM_CONTROL_PORT: '19293',
      BM_BIND_HOST: '127.0.0.2',
      BM_RULES_PATH: '/tmp/rules.txt',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.dataPort).toBe(19294);
      expect(parsed.config.controlPort).toBe(19293);
      expect(parsed.config.bindHost).toBe('127.0.0.2');
      expect(parsed.config.controlBindHost).toBe('127.0.0.1');
      expect(parsed.config.rulesPath).toBe('/tmp/rules.txt');
    }
  });

  test('BM_BIND_HOST is the DATA bind only — the control bind defaults loopback and refuses LAN values', () => {
    // A LAN data bind leaves the control bind at its loopback default — the
    // one posture that must never happen cannot be expressed via BM_BIND_HOST.
    const lan = configFromEnv({
      BM_STORE_DIR: '/tmp/x',
      BM_BIND_HOST: '192.168.1.20',
    });
    expect(lan.ok).toBe(true);
    if (lan.ok) {
      expect(lan.config.bindHost).toBe('192.168.1.20');
      expect(lan.config.controlBindHost).toBe('127.0.0.1');
    }

    // Non-loopback BM_CONTROL_BIND_HOST values are refused at config time —
    // exit-2 honest, never a half-bound engine.
    for (const bad of ['0.0.0.0', '::', '192.168.1.20', 'example.com']) {
      const parsed = configFromEnv({
        BM_STORE_DIR: '/tmp/x',
        BM_CONTROL_BIND_HOST: bad,
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('BM_CONTROL_BIND_HOST');
    }

    // Loopback-family spellings pass through verbatim.
    for (const good of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
      const parsed = configFromEnv({
        BM_STORE_DIR: '/tmp/x',
        BM_CONTROL_BIND_HOST: good,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.config.controlBindHost).toBe(good);
    }
  });
});

describe('dist/main.js spawned', () => {
  test('exits 2 with a stderr message when BM_STORE_DIR is absent', async () => {
    const { child, stderr } = spawnEngine({});
    const code = await exitCode(child);
    expect(code).toBe(2);
    expect(stderr()).toContain('BM_STORE_DIR');
  });

  test('binds the env-named ports, loads BM_RULES_PATH, and exits 0 on SIGTERM', async () => {
    const storeDir = await tempDir('bm-proxy-store-');
    const rulesPath = join(storeDir, 'rules.txt');
    await writeFile(rulesPath, '||ads.example^\n||tracker.example^\n', 'utf8');
    const dataPort = await freePort();
    const controlPort = await freePort();

    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_RULES_PATH: rulesPath,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_BIND_HOST: '127.0.0.1',
    });

    const status = await waitForStatus(child, controlPort);
    expect(status.status).toBe('running');
    expect(status.dataPort).toBe(dataPort);
    expect(status.controlPort).toBe(controlPort);
    expect(status.rulesLoaded).toBe(2);

    // The bound-ports line is the parent's "came up" signal — one stderr line,
    // carrying the listener addresses and nothing else.
    expect(stderr()).toContain(`listening: control 127.0.0.1:${controlPort} data 127.0.0.1:${dataPort}`);

    child.kill('SIGTERM');
    const code = await exitCode(child);
    expect(code).toBe(0);
    expect(stderr()).toContain('SIGTERM');
  });

  test('POST /v1/proxy/shutdown retires the engine through the signal-path shutdown (exit 0)', async () => {
    // The route answers the caller first, then runs main's close+exit on a
    // deferred tick — the observable contract is: 200 reply, process gone.
    const storeDir = await tempDir('bm-proxy-shutdown-');
    const dataPort = await freePort();
    const controlPort = await freePort();

    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_BIND_HOST: '127.0.0.1',
    });
    await waitForStatus(child, controlPort);

    const res = await fetch(`http://127.0.0.1:${controlPort}/v1/proxy/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const code = await exitCode(child);
    expect(code).toBe(0);
    expect(stderr()).toContain('/v1/proxy/shutdown');
  });

  test('BM_BIND_HOST=<lan> LAN-binds the data listener while control stays loopback', async () => {
    // The hub posture end-to-end: env → binds. A routable local IPv4 when
    // this host owns one (CI loopback-only hosts fall back to the wildcard
    // bind — the LAN-reachability legs then check 127.0.0.1, which the
    // wildcard also serves).
    let lanAddr: string | null = null;
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) lanAddr ??= a.address;
      }
    }
    const bind = lanAddr ?? '0.0.0.0';
    const reach = lanAddr ?? '127.0.0.1';

    const storeDir = await tempDir('bm-proxy-lan-');
    const dataPort = await freePort();
    const controlPort = await freePort();
    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_BIND_HOST: bind,
    });

    const status = await waitForStatus(child, controlPort);
    expect(status.bindHost).toBe(bind);
    expect(status.controlBindHost).toBe('127.0.0.1');
    expect(stderr()).toContain(`listening: control 127.0.0.1:${controlPort} data ${bind}:${dataPort}`);

    // The data listener answers through the LAN address.
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: reach, port: dataPort });
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', reject);
    });

    if (lanAddr) {
      // Control on the LAN addr is a dead port — the mutation surface is
      // loopback-pinned even while the data port takes network flows.
      const refused = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: lanAddr, port: controlPort });
        s.once('connect', () => {
          s.destroy();
          resolve(false);
        });
        s.once('error', () => resolve(true));
      });
      expect(refused).toBe(true);
    }

    child.kill('SIGTERM');
    await exitCode(child);
  });

  test('a non-loopback BM_CONTROL_BIND_HOST exits 2 with a named refusal', async () => {
    const storeDir = await tempDir('bm-proxy-badctlbind-');
    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_CONTROL_BIND_HOST: '0.0.0.0',
    });
    const code = await exitCode(child);
    expect(code).toBe(2);
    expect(stderr()).toContain('BM_CONTROL_BIND_HOST');
    expect(stderr()).toContain('loopback');
  });

  test('BM_KEYWRAP=off leaves no OS-keystore trace — CA reports keyWrapped:false', async () => {
    const storeDir = await tempDir('bm-proxy-unwrapped-');
    const dataPort = await freePort();
    const controlPort = await freePort();

    // spawnEngine already pins BM_KEYWRAP=off for hermeticity; name it again
    // so the contract under test reads explicitly.
    const { child } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_BIND_HOST: '127.0.0.1',
      BM_KEYWRAP: 'off',
    });

    await waitForStatus(child, controlPort);
    const res = await fetch(`http://127.0.0.1:${controlPort}/v1/proxy/ca`);
    expect(res.ok).toBe(true);
    const ca = await res.json();
    // The at-rest posture endpoint is the observable proof: no backend ran,
    // so no keychain item exists and the key sits at 0600 ca.key.pem.
    expect(ca.keyWrapped).toBe(false);
    expect(ca.keyWrapBackend).toBeUndefined();
    expect(existsSync(join(storeDir, 'ca', 'ca.key.pem'))).toBe(true);
    expect(existsSync(join(storeDir, 'ca', 'ca.key.enc'))).toBe(false);
  });
});

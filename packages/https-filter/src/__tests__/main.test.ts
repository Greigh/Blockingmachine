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
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv, parentPidAlive, startParentWatchdog } from '../main.js';

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

/** A pid guaranteed to answer ESRCH right now — scanned, not guessed. */
function deadPid(): number {
  for (let pid = 40_000; pid <= 99_999; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      // EPERM — a live pid owned by another euid; keep scanning.
    }
  }
  throw new Error('no dead pid found in the scanned range');
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

  test('BM_PARENT_PID parses a decimal pid; garbage/0/negative read as unset', () => {
    const armed = configFromEnv({ BM_STORE_DIR: '/tmp/x', BM_PARENT_PID: '4242' });
    expect(armed.ok).toBe(true);
    if (armed.ok) expect(armed.config.parentPid).toBe(4242);

    // Every non-decimal-pid spelling falls through to unset — a misparsed
    // value must never arm a watchdog against a healthy engine. pid 0 is
    // rejected outright: kill(0, sig) probes the caller's own process
    // GROUP, which always reads alive and would silently never fire.
    for (const bogus of ['0', '-5', 'abc', '12.3', '  ', '1e4', '0x10', '99999999999']) {
      const parsed = configFromEnv({ BM_STORE_DIR: '/tmp/x', BM_PARENT_PID: bogus });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.config.parentPid).toBeUndefined();
    }

    const unset = configFromEnv({ BM_STORE_DIR: '/tmp/x' });
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.config.parentPid).toBeUndefined();
  });
});

describe('parent watchdog (BM_PARENT_PID)', () => {
  /**
   * A signal-0 probe stub — the platform-real `process.kill` outcomes
   * without fixtures: success = alive, ESRCH = gone, EPERM = alive under a
   * different euid (the service-account posture), anything else = the probe
   * itself failed and must never retire an engine.
   */
  function probeThrowing(code: string) {
    return (): boolean => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    };
  }

  test('parentPidAlive: ESRCH alone reads gone — EPERM and other failures read alive', () => {
    expect(parentPidAlive(4242, () => true)).toBe(true);
    expect(parentPidAlive(4242, probeThrowing('EPERM'))).toBe(true);
    expect(parentPidAlive(4242, probeThrowing('EACCES'))).toBe(true);
    expect(parentPidAlive(4242, probeThrowing('ESRCH'))).toBe(false);
  });

  test('a parent already dead fires onParentGone at arm time — no interval wait', () => {
    let gone = 0;
    const w = startParentWatchdog(4242, () => {
      gone += 1;
    }, 10, probeThrowing('ESRCH'));
    expect(gone).toBe(1);
    w.stop();
    expect(gone).toBe(1); // stop() after the fact cannot re-fire
  });

  test('an alive-then-dead parent fires exactly once on the interval tick', async () => {
    let probes = 0;
    const flip = (): boolean => {
      probes += 1;
      if (probes >= 4) {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    };
    let gone = 0;
    const w = startParentWatchdog(
      4242,
      () => {
        gone += 1;
      },
      25,
      flip,
    );
    // Probes 1–3 (arm + first two ~25ms ticks) read alive — by 50ms at most
    // two ticks have run, so ESRCH cannot have been seen yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(gone).toBe(0);
    // Probe 4 (~75ms) reads ESRCH — fire once, then the watchdog disarms
    // itself: later ticks must not re-enter shutdown.
    await new Promise((r) => setTimeout(r, 120));
    expect(gone).toBe(1);
    const callsAtFire = probes;
    await new Promise((r) => setTimeout(r, 80));
    expect(gone).toBe(1);
    expect(probes).toBe(callsAtFire);
    w.stop();
  });

  test('EPERM across every probe never fires — an unsignalable parent is still alive', async () => {
    let gone = 0;
    const w = startParentWatchdog(
      4242,
      () => {
        gone += 1;
      },
      15,
      probeThrowing('EPERM'),
    );
    await new Promise((r) => setTimeout(r, 70));
    expect(gone).toBe(0);
    w.stop();
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

  test('BM_PARENT_PID of a dead process exits 0 — the engine refuses to start orphaned', async () => {
    // The boot-time probe (before any CA/store work) reads ESRCH and exits
    // without ever binding — a detached child whose parent died between
    // spawn and startup must not become an orphan.
    const storeDir = await tempDir('bm-proxy-orphan-');
    const dataPort = await freePort();
    const controlPort = await freePort();
    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_PARENT_PID: String(deadPid()),
    });
    const code = await exitCode(child);
    expect(code).toBe(0);
    expect(stderr()).toContain('BM_PARENT_PID');
    expect(stderr()).toContain('gone');
  });

  test('BM_PARENT_PID of a live process stays up — the watchdog probes and keeps serving', async () => {
    // A real live parent: a scratch child that just sleeps. The engine
    // must boot AND stay up past the boot probe — signal 0 on a live pid
    // succeeds (same euid), so no shutdown is initiated.
    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    children.push(dummy);
    const storeDir = await tempDir('bm-proxy-parent-');
    const dataPort = await freePort();
    const controlPort = await freePort();
    const { child } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_PARENT_PID: String(dummy.pid),
    });
    const status = await waitForStatus(child, controlPort);
    expect(status.status).toBe('running');
    // A beat past the boot probe and into interval territory — still up.
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    expect(await exitCode(child)).toBe(0);
  });

  test('BM_PARENT_PID=1 stays up — EPERM reads as alive, never as gone', async () => {
    // pid 1 (launchd/init) is owned by root: a non-root suite probes EPERM,
    // a root suite probes success — BOTH read alive, so the engine stays
    // up either way. The EPERM-never-gone semantic itself is pinned above
    // by the injected-kill unit tests.
    const storeDir = await tempDir('bm-proxy-pidone-');
    const dataPort = await freePort();
    const controlPort = await freePort();
    const { child } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_PARENT_PID: '1',
    });
    const status = await waitForStatus(child, controlPort);
    expect(status.status).toBe('running');
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    expect(await exitCode(child)).toBe(0);
  });

  test('a parent dying mid-run retires the engine inside the watchdog bound', async () => {
    // The flag-101 scenario end-to-end: engine up under a live parent, the
    // parent dies, the unref'd ~10s probe reads ESRCH and the engine runs
    // its own graceful shutdown (exit 0) without any stop() call.
    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    children.push(dummy);
    const storeDir = await tempDir('bm-proxy-middeath-');
    const dataPort = await freePort();
    const controlPort = await freePort();
    const { child, stderr } = spawnEngine({
      BM_STORE_DIR: storeDir,
      BM_DATA_PORT: String(dataPort),
      BM_CONTROL_PORT: String(controlPort),
      BM_PARENT_PID: String(dummy.pid),
    });
    await waitForStatus(child, controlPort);

    dummy.kill('SIGKILL');
    // Reap the zombie first — kill(2) signal 0 succeeds on a zombie pid,
    // so ESRCH only appears after libuv's exit reaping.
    await once(dummy, 'exit');

    // Resolves on the child's exit — bounded by the ~10s probe interval
    // plus the graceful close, well under the suite timeout.
    const code = await exitCode(child);
    expect(code).toBe(0);
    expect(stderr()).toContain('gone');
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

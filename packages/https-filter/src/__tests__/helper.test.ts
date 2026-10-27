/**
 * macOS natlook-helper — darwin-gated build + selftest suite (P1 Task 2).
 * Entirely skipped off-darwin: the helper is a pf/launchd leg and clang's
 * target only exists there.
 *
 * `natlook-helper --selftest` runs the REAL acceptor loop — listener,
 * fork-per-connection, PROXY-v2 emit, splice — against an in-process fake
 * engine + loopback client, with `BM_HELPER_TEST_DST*` pinning the
 * "original destination" so no pf anchor or root is needed. The suite
 * then reconstructs the expected v2 header bytes itself (signature, fam,
 * len, the client's own ephemeral source port, the pinned dst) and
 * compares hex-for-hex — a field-order regression anywhere in emit
 * fails loudly.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

jest.setTimeout(90_000);

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HELPER_DIR = join(PKG_DIR, 'helper', 'macos');
const HELPER_BIN = join(HELPER_DIR, 'natlook-helper');
const HELPER_SRC = join(HELPER_DIR, 'natlook-helper.c');
const BUILD = join(HELPER_DIR, 'build.sh');

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip;

/**
 * Source-level invariants — run everywhere (file reads only, no clang,
 * no pf, no root). These pin the failure-posture contracts the C code
 * carries so a refactor can't silently drop one.
 */
describe('natlook-helper source invariants', () => {
  const src = readFileSync(HELPER_SRC, 'utf8');

  test('watchdog connect is bounded (nonblocking connect + poll + SO_ERROR)', () => {
    expect(src).toContain('CONNECT_TIMEOUT_MS');
    expect(src).toMatch(/fcntl\(fd, F_SETFL, fl \| O_NONBLOCK\)/);
    expect(src).toMatch(/getsockopt\(fd, SOL_SOCKET, SO_ERROR/);
  });

  test('listeners are O_NONBLOCK with an EAGAIN-drained accept loop', () => {
    expect(src).toMatch(/fcntl\(fd, F_SETFL, fl \| O_NONBLOCK\)/);
    expect(src).toMatch(/errno == EAGAIN\s*\)\s*break|errno == EAGAIN\)/);
  });

  test('concurrent children are capped and the shutdown-kill skips reaped slots', () => {
    expect(src).toContain('MAX_CHILDREN');
    expect(src).toMatch(/g_live_children/);
    // Reaped pids are zeroed in the ring — a recycled pid must never
    // catch a stale SIGTERM (and kill(0) would hit our own group).
    expect(src).toMatch(/g_children\[i\] == p/);
    expect(src).toMatch(/if \(g_children\[i\] > 0\)\s*kill/);
  });

  test('the inet6 bind is fatal — a dead v6 leg must not strand redirected flows', () => {
    expect(src).toMatch(/cannot bind \[::1\]:%u errno=%d — v6 capture leg required/);
    expect(src).not.toMatch(/v6 capture leg dead/);
  });

  test('post-reboot re-arm is gated on the state file and performed by pf-anchor.sh', () => {
    expect(src).toContain('/etc/blockingmachine-capture.state');
    expect(src).toContain('pf-anchor.sh');
    expect(src).toMatch(/g_rearm_pending/);
    // The arm rides a successful engine probe — never unconditional.
    expect(src).toMatch(/access\(STATE_FILE, F_OK\)/);
  });
});

/** Distinct free loopback ports — bind 0, harvest, close (same pattern as other suites). */
async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < n) {
    const srv = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (port > 0 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

const toHex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const V2_SIG = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
const portBytes = (p: number) => [(p >> 8) & 0xff, p & 0xff];

/** Expected PROXY-v2 bytes for a known client/dst pair — rebuilt by hand. */
function expectedV4(clientPort: number, dstIp: string, dstPort: number): string {
  return toHex([
    ...V2_SIG,
    0x21, 0x11, 0x00, 0x0c,
    127, 0, 0, 1,
    ...dstIp.split('.').map(Number),
    ...portBytes(clientPort),
    ...portBytes(dstPort),
  ]);
}

function expectedV6(clientPort: number, dstIpBytes: number[], dstPort: number): string {
  const loop = new Array<number>(16).fill(0);
  loop[15] = 1; // ::1
  return toHex([
    ...V2_SIG,
    0x21, 0x21, 0x00, 0x24,
    ...loop,
    ...dstIpBytes,
    ...portBytes(clientPort),
    ...portBytes(dstPort),
  ]);
}

describeDarwin('natlook-helper (macOS capture acceptor)', () => {
  const DST4 = '203.0.113.7:8443';
  const DST6 = '[2001:db8::5]:443';
  const DST6_BYTES = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];

  test('build.sh compiles -O2 -Wall -Wextra -Werror cleanly', () => {
    execFileSync('bash', [BUILD], { stdio: 'pipe', timeout: 60_000 });
  });

  test('selftest emits byte-exact v2 headers and splices payload verbatim, both families', async () => {
    const [helperPort, enginePort] = await freePorts(2);
    const out = execFileSync(
      HELPER_BIN,
      ['--selftest', String(helperPort), '127.0.0.1', String(enginePort)],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          BM_HELPER_TEST_DST: DST4,
          BM_HELPER_TEST_DST6: DST6,
        },
      },
    );
    expect(out).toContain('selftest: PASS');
    expect(out).toContain('payload=match');
    expect(out).not.toContain('payload=mismatch');

    // One client_port line per phase, in order: v4 then v6.
    const clientPorts = [...out.matchAll(/client_port=(\d+)/g)].map((m) => Number(m[1]));
    expect(clientPorts).toHaveLength(2);

    const h4 = out.match(/selftest: af=4 dst=\S+ header=([0-9a-f]+)/);
    expect(h4).not.toBeNull();
    expect(h4?.[1]).toBe(expectedV4(clientPorts[0], '203.0.113.7', 8443));

    const h6 = out.match(/selftest: af=6 dst=\S+ header=([0-9a-f]+)/);
    expect(h6).not.toBeNull();
    expect(h6?.[1]).toBe(expectedV6(clientPorts[1], DST6_BYTES, 443));
  });
});

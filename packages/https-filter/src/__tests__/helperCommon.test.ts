/**
 * Shared helper core (helper/common/) — the P3 Task 1 extraction.
 *
 * Two layers of coverage, matching the repo's platform-gated convention:
 *
 * 1. Source invariants (everywhere): splice.h's API surface is the
 *    contract the Windows + Linux redirect helpers code against — a
 *    signature drift here breaks all three platforms, so the names are
 *    pinned textually.
 *
 * 2. Golden-bytes suite (POSIX with a C compiler — darwin hosts and
 *    linux CI legs): compiles splice-golden-test.c + splice.c and runs
 *    it. The test main asserts the EXACT PROXY-v2 wire bytes for v4+v6
 *    (signature, ver/cmd 0x21, fam 0x11/0x21, big-endian len, src/dst
 *    field order — the same vectors helper.test.ts rebuilds by hand)
 *    plus negative paths and a live bm_splice over socketpairs with
 *    half-close propagation. This makes the common-core contract
 *    platform-verified wherever it runs — the Windows helper emits the
 *    same bytes because it emits through this same code.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

jest.setTimeout(90_000);

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));
const COMMON = join(PKG_DIR, 'helper', 'common');
const HDR = join(COMMON, 'splice.h');
const SRC = join(COMMON, 'splice.c');
const GOLDEN = join(COMMON, 'splice-golden-test.c');

const hasCc = (() => {
  try {
    execFileSync('cc', ['--version'], { stdio: 'pipe' });
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();
const describeCc = hasCc ? describe : describe.skip;

describe('helper/common splice.h — API contract', () => {
  const h = readFileSync(HDR, 'utf8');

  test('PROXY-v2 emit surface (buffer + fd emit + sockaddr_storage form)', () => {
    expect(h).toMatch(/bm_proxy_v2_format\(/);
    expect(h).toMatch(/bm_proxy_v2_format_ss\(/);
    expect(h).toMatch(/int bm_proxy_v2_emit\(bm_sock_t fd, int family/);
    expect(h).toContain('bm_ip_addr'); // in_addr/in6_addr union
  });

  test('splice + bounded dial + write_all', () => {
    expect(h).toMatch(/void bm_splice\(bm_sock_t fd_a, bm_sock_t fd_b\)/);
    expect(h).toMatch(/bm_connect_tcp\(const char \*host, uint16_t port\)/);
    expect(h).toMatch(/int bm_write_all\(bm_sock_t fd, const uint8_t \*buf, size_t n\)/);
    expect(h).toContain('BM_CONNECT_TIMEOUT_MS');
  });

  test('connection-cap + watchdog signatures the platform files consume', () => {
    expect(h).toContain('BM_MAX_CHILDREN');
    expect(h).toMatch(/bm_children_full\(void\)/);
    expect(h).toMatch(/bm_child_spawned\(void\)/);
    expect(h).toMatch(/bm_child_reaped\(void\)/);
    // bm_watchdog_loop(probe_port, dead_cb, interval_ms) — the pinned
    // loop shape for thread-based platforms (Windows).
    expect(h).toMatch(/bm_watchdog_loop\(uint16_t probe_port, bm_watchdog_cb dead_cb,\s*int interval_ms\)/);
    expect(h).toMatch(/bm_watchdog_tick\(/);
  });

  test('per-flow lifecycle + test-dst seam + structured logging', () => {
    expect(h).toContain('bm_flow_cfg');
    expect(h).toContain('bm_handle_connection');
    expect(h).toContain('bm_origdst_fn');
    expect(h).toContain('BM_HELPER_TEST_DST');
    expect(h).toMatch(/void bm_logf\(/);
    expect(h).toMatch(/void bm_vlogf\(/);
  });

  test('Winsock abstraction exists and is _WIN32-gated', () => {
    expect(h).toContain('#ifdef _WIN32');
    expect(h).toContain('closesocket');
    expect(h).toContain('WSAPoll');
    expect(h).toContain('WSAEINTR');
    expect(h).toContain('SD_SEND'); // SHUT_WR analog on Windows
  });
});

describe('helper/common splice.c — platform purity', () => {
  const c = readFileSync(SRC, 'utf8');

  test('no platform-owned mechanism CALLS leaked into the core', () => {
    // origdst recovery + accept loops belong to the platform files —
    // assert the mechanism calls are absent (names may appear in
    // comments documenting where each platform's lookup lives).
    expect(c).not.toMatch(/\bioctl\s*\(/);          // no /dev/pf DIOCNATLOOK
    expect(c).not.toMatch(/\bWSAIoctl\s*\(/);       // no WFP redirect query
    expect(c).not.toMatch(/\bFwpmEngineOpen/);      // no WFP session
    expect(c).not.toMatch(/\bgetsockopt\([^)]*SO_ORIGINAL_DST/); // no linux leg
    // fork is the macOS/linux concurrency model — not in shared code.
    expect(c).not.toMatch(/\bfork\s*\(\s*\)/);
  });
});

describeCc('helper/common golden-bytes (compiled core contract)', () => {
  test('splice-golden-test compiles -Werror-clean and all checks pass', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'bm-golden-')), 'golden');
    execFileSync(
      'cc',
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', out, GOLDEN, SRC],
      { stdio: 'pipe', timeout: 60_000 },
    );
    const run = execFileSync(out, [], { encoding: 'utf8', timeout: 30_000 });
    expect(run).toContain('golden: v4 bytes ok');
    expect(run).toContain('golden: v6 bytes ok');
    expect(run).toContain('golden: v4 len ok');
    expect(run).toContain('golden: v6 len ok');
    expect(run).toContain('golden: splice half-close eof ok');
    expect(run).toContain('golden: PASS');
    expect(run).not.toContain('FAIL');
  });
});

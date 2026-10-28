/**
 * Linux redirect-helper — P3 Task 2's netfilter REDIRECT acceptor.
 *
 * Two layers, matching the repo's platform-gated convention:
 *
 * 1. Source invariants (everywhere): the pinned Linux surface —
 *    SO_ORIGINAL_DST / IP6T_SO_ORIGINAL_DST (both ABI-pinned 80,
 *    #ifndef-defined rather than kernel-header'd so the TU compiles on
 *    darwin), the __linux__ guard with the ENOPROTOOPT off-platform
 *    stub, fork-per-connection over the SHARED child registry, the
 *    bm-anchor.sh flush/re-arm/status callouts, the state-file path,
 *    and the fail-closed origdst posture.
 *
 * 2. Compiled suite (POSIX with a C compiler — darwin hosts AND linux
 *    CI): compiles redirect-helper.c + common/splice.c -Werror-clean
 *    and runs `--selftest`. The file is deliberately darwin-compilable
 *    — the origdst getsockopt is __linux__-guarded and the test-dst env
 *    seam fixes the destination — so the acceptor, PROXY-v2 emit and
 *    splice legs are exercised on any POSIX host. The conntrack lookup
 *    itself is exercised only by scripts/linux-capture-rehearse.sh in
 *    a NET_ADMIN container. The suite rebuilds the expected v2 header
 *    bytes itself (signature, fam, len, the client's own ephemeral
 *    source port, the pinned dst) and compares hex-for-hex.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

jest.setTimeout(90_000);

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HELPER_DIR = join(PKG_DIR, 'helper', 'linux');
const HELPER_SRC = join(HELPER_DIR, 'redirect-helper.c');
const CORE_SRC = join(PKG_DIR, 'helper', 'common', 'splice.c');
const BUILD_SH = join(HELPER_DIR, 'build.sh');
const ANCHOR_SH = join(HELPER_DIR, 'bm-anchor.sh');
const SUPERVISE_SH = join(HELPER_DIR, 'bm-supervise.sh');
const GATE_MJS = join(PKG_DIR, 'helper', 'build-if-linux.mjs');
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

const hasCc = (() => {
  try {
    execFileSync('cc', ['--version'], { stdio: 'pipe' });
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();
const describeCc = hasCc ? describe : describe.skip;

describe('linux redirect-helper.c — pinned netfilter surface', () => {
  const src = readFileSync(HELPER_SRC, 'utf8');

  test('origdst via conntrack sockopts — SO_ORIGINAL_DST v4, IP6T v6, both ABI-pinned 80', () => {
    expect(src).toMatch(/getsockopt\(connfd, SOL_IP, SO_ORIGINAL_DST/);
    expect(src).toMatch(/getsockopt\(connfd, SOL_IPV6, IP6T_SO_ORIGINAL_DST/);
    expect(src).toMatch(/#define SO_ORIGINAL_DST 80/);
    expect(src).toMatch(/#define IP6T_SO_ORIGINAL_DST 80/);
    // Guard-defined, not kernel-header'd — the linux/in.h vs
    // netinet/in.h coexistence lottery is deliberately not played.
    expect(src).toMatch(/#ifndef SO_ORIGINAL_DST/);
    expect(src).toMatch(/#ifndef IP6T_SO_ORIGINAL_DST/);
  });

  test('the sockopt leg is __linux__-guarded so the TU compiles on darwin (selftest legs)', () => {
    expect(src).toMatch(/#if defined\(__linux__\)/);
    // Off-Linux the lookup is an honest ENOPROTOOPT — every non-test
    // flow fails closed, never a guessed destination.
    expect(src).toContain('ENOPROTOOPT');
    // The family comes from the accepted socket's own getsockname —
    // a v4 accept gets the v4 lookup, a v6 accept the v6 one.
    expect(src).toContain('getsockname(connfd');
  });

  test('shared core consumption — splice.h include, flow lifecycle, shared POSIX registry', () => {
    expect(src).toContain('"../common/splice.h"');
    expect(src).toContain('bm_handle_connection');
    expect(src).toContain('bm_test_dst_from_env');
    expect(src).toContain('bm_listen_on');
    // The shared registry — NOT a private copy of natlook's ring.
    expect(src).toContain('bm_track_pid');
    expect(src).toContain('bm_reap_children');
    expect(src).toContain('bm_kill_tracked_children');
    expect(src).toContain('bm_children_full');
    expect(src).toContain('bm_child_spawned');
    // No macOS/Windows mechanism CALLS leak — names may appear in
    // comments naming the analog; the mechanism calls must not.
    expect(src).not.toMatch(/\bioctl\s*\(/);
    expect(src).not.toMatch(/\bWSAIoctl\s*\(|FwpmEngineOpen/);
    expect(src).not.toMatch(/#include <net\/pfvar|#include <fwpmu/);
    // And no TPROXY mechanism — the plan pins REDIRECT (route rules +
    // CAP_NET_ADMIN for zero gain). The word may appear in the design
    // comment; the transparent-socket sockopts must not.
    expect(src).not.toMatch(/IP_TRANSPARENT|IP_RECVORIGDSTADDR|SOL_TRANSPARENT/);
  });

  test('accepted sockets normalize to blocking right after accept', () => {
    // The listener is nonblocking (drain loop); the ACCEPTED fd's mode
    // is platform-defined (Winsock inherits, POSIX doesn't) — the
    // bm_set_nonblocking(cfd, 0) call is the contract, not a quirk.
    expect(src).toMatch(/accept\(pfd\[i\]\.fd, NULL, NULL\)[\s\S]{0,900}?bm_set_nonblocking\(cfd, 0\)/);
  });

  test('fork-per-connection over the shared cap — SIGCHLD blocked across fork', () => {
    expect(src).toMatch(/\bfork\(\)/);
    expect(src).toMatch(/sigprocmask\(SIG_BLOCK, &chld, &prev\)/);
    expect(src).toContain('sigaction(SIGCHLD');
    // Child restores defaults so the parent's shutdown-kill lands.
    expect(src).toContain('signal(SIGTERM, SIG_DFL)');
  });

  test('watchdog flushes + re-arms ONLY through the installed bm-anchor.sh', () => {
    expect(src).toContain('/usr/local/libexec/blockingmachine/bm-anchor.sh');
    expect(src).toContain('/etc/blockingmachine-capture-linux.state');
    expect(src).toMatch(/flush-only/);
    expect(src).toMatch(/g_rearm_pending/);
    // The startup gate: state file present AND rules absent → pending.
    expect(src).toMatch(/access\(STATE_FILE, F_OK\)/);
    // No second copy of the rule mechanics — system() invokes the
    // anchor script only, never raw iptables/nft.
    const systemCalls = src.match(/system\(/g) ?? [];
    for (const call of ['FLUSH_CMD', 'ARM_CMD', 'ANCHOR_QRY']) {
      expect(src).toContain(call);
    }
    expect(systemCalls.length).toBeLessThanOrEqual(3);
    expect(src).not.toMatch(/system\("(iptables|nft|ip6tables)/);
  });

  test('v6 listener bind is fatal — a dead v6 leg must not strand redirected flows', () => {
    expect(src).toMatch(/cannot bind \[::1\]:%u errno=%d — v6 capture leg required/);
  });

  test('argv + test seams per plan', () => {
    expect(src).toContain('--selftest');
    expect(src).toContain('BM_HELPER_TEST_DST');
    // argv: <helperPort> <enginePort> — the unit's ExecStart shape.
    expect(src).toMatch(/redirect-helper <helperPort> <enginePort>/);
  });
});

describe('linux bm-anchor.sh — mechanism + state contract', () => {
  const sh = readFileSync(ANCHOR_SH, 'utf8');

  test('verbs: render|load|flush-only|status; single implementation for all callers', () => {
    for (const verb of ['render', 'load', 'flush-only', 'status']) {
      expect(sh).toContain(verb);
    }
    // The helper's three callouts map to three verbs.
    const helper = readFileSync(HELPER_SRC, 'utf8');
    expect(helper).toContain('flush-only');
    expect(sh).toContain('bm-anchor.sh');
  });

  test('mechanism detection prefers native nft, kernel-probes both paths', () => {
    expect(sh).toMatch(/command -v nft/);
    expect(sh).toContain('nft list ruleset');
    expect(sh).toMatch(/command -v iptables/);
    expect(sh).toContain('iptables -t nat -L');
    // ip6tables needs its nat table — probe it, degrade honestly.
    expect(sh).toContain('ip6tables -t nat -L');
    expect(sh).toContain('V6_ARMED=0');
  });

  test('nft render carries the nat output chain, skuid exemption, redirect, QUIC drop', () => {
    expect(sh).toContain('type nat hook output priority -100');
    expect(sh).toContain('meta skuid ${SERVICE_UID} return');
    expect(sh).toContain('redirect to :${HELPER_PORT}');
    expect(sh).toContain('udp dport 443 drop');
    // Both families, same table name — one delete flushes a whole leg.
    expect(sh).toContain('table ip ${TABLE_NAME}');
    expect(sh).toContain('table ip6 ${TABLE_NAME}');
  });

  test('iptables render carries owner exemption, multiport REDIRECT, QUIC drop', () => {
    expect(sh).toContain('-m owner --uid-owner ${SERVICE_UID} -j RETURN');
    expect(sh).toContain('-p tcp -m multiport --dports ${PORTS} -j REDIRECT --to-ports ${HELPER_PORT}');
    expect(sh).toContain('-p udp --dport 443 -j DROP');
  });

  test('flag-122 quic exemptions render udp/443-scoped RETURNS between redirect and drop', () => {
    // The per-user opt-out is scoped to udp/443 by construction — the
    // exempt identity's tcp:{80,443} flows still ride the capture.
    expect(sh).toContain('meta skuid %s udp dport 443 return');
    expect(sh).toContain('-p udp --dport 443 -m owner --uid-owner %s -j RETURN');
    // Config surface: env + flag, validated, recorded for re-arm/flush.
    expect(sh).toContain('BM_QUIC_EXEMPT_UIDS');
    expect(sh).toContain('--quic-exempt)');
    expect(sh).toContain('QUIC_EXEMPT_UIDS=%s');
    expect(sh).toMatch(/state_get QUIC_EXEMPT_UIDS/);
    expect(sh).toMatch(/invalid --quic-exempt entry/);
    // Exempt lines emit inside the render functions, between the
    // self-return/redirect pair and the drop — assert the CALL-SITE
    // ordering by source position (the function definition itself sits
    // above the renderers).
    const exemptAt = sh.indexOf('    quic_exempt_nft_lines\n');
    const dropAt = sh.indexOf('    udp dport 443 drop');
    expect(exemptAt).toBeGreaterThan(-1);
    expect(exemptAt).toBeLessThan(dropAt);
    const xtExempt = sh.indexOf('quic_exempt_xt_lines "$action"');
    const xtDrop = sh.indexOf('-t filter ${action} OUTPUT -p udp --dport 443 -j DROP');
    expect(xtExempt).toBeGreaterThan(-1);
    expect(xtExempt).toBeLessThan(xtDrop);
  });

  test('state file records mechanism + uid + ports; flush replays the recorded mechanism', () => {
    expect(sh).toContain('/etc/blockingmachine-capture-linux.state');
    for (const key of ['MECHANISM=', 'UID=', 'PORTS=', 'HELPER_PORT=', 'V6_ARMED=']) {
      expect(sh).toContain(key);
    }
    // flush-only consults the recorded mechanism, not just detection.
    expect(sh).toMatch(/state_get MECHANISM/);
    // State is sed-parsed, never sourced (uninstall-macos precedent).
    expect(sh).toMatch(/sed -n "s\/\^\$1=\/\/p"/);
    expect(sh).not.toMatch(/source "\$STATE_FILE"|\. "\$STATE_FILE"/);
  });

  test('flock serializes the non-atomic iptables sequences — bounded wait, split argv', () => {
    // -w 5 must be TWO argv elements (`flock -x -w 5 9`) — a combined
    // "-w 5" token is one unparseable arg, and no -w at all is an
    // unbounded wait a wedged holder could stall the watchdog flush on.
    expect(sh).toMatch(/flock -x -w 5 9/);
    expect(sh).not.toMatch(/flock -x "-w 5" 9|flock -x '-w 5' 9/);
    expect(sh).toContain('blockingmachine-capture.lock');
  });
});

describe('linux bm-supervise.sh — the sysvinit respawn wrapper (flag 118)', () => {
  const sh = readFileSync(SUPERVISE_SH, 'utf8');

  test('respawns the child forever on exit — the Restart=always shape sysvinit lacks', () => {
    expect(sh).toMatch(/while :; do/);
    expect(sh).toContain('"$@" &');
    expect(sh).toContain('wait "$CHILD"');
    expect(sh).toMatch(/respawning in %ss/);
    // Default delay matches the units' RestartSec=2.
    expect(sh).toContain('BM_RESPAWN_DELAY:-2');
  });

  test('TERM forwards to the child — the init.d stop path must not orphan a live daemon', () => {
    expect(sh).toMatch(/trap on_term TERM INT/);
    expect(sh).toMatch(/kill "\$CHILD"/);
    expect(sh).toContain('exit 0');
  });

  test('argv contract: <name> -- <command>, dies on a missing command', () => {
    expect(sh).toContain('bm-supervise.sh <name> -- <command>');
    expect(sh).toMatch(/\$# -gt 0/);
  });
});

describe('linux helper build + npm wiring', () => {
  test('build.sh compiles redirect-helper.c + common/splice.c with the pinned flags', () => {
    const sh = readFileSync(BUILD_SH, 'utf8');
    expect(sh).toContain('redirect-helper.c');
    expect(sh).toContain('../common/splice.c');
    expect(sh).toContain('-std=c11');
    expect(sh).toContain('-Werror');
    // bm-anchor.sh is a shell script — shipped from the same dir.
    expect(sh).toContain('bm-anchor.sh');
  });

  test('build-if-linux.mjs gates on linux like the darwin/win32 twins', () => {
    const m = readFileSync(GATE_MJS, 'utf8');
    expect(m).toContain("process.platform === 'linux'");
    expect(m).toContain('build.sh');
  });

  test('package.json prebuild runs all three platform gates', () => {
    expect(PKG.scripts.prebuild).toContain('build-if-darwin.mjs');
    expect(PKG.scripts.prebuild).toContain('build-if-win32.mjs');
    expect(PKG.scripts.prebuild).toContain('build-if-linux.mjs');
  });
});

/** Distinct free loopback ports — bind 0, harvest, close. */
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

describeCc('linux redirect-helper (compiled + selftest)', () => {
  const DST4 = '203.0.113.7:8443';
  const DST6 = '[2001:db8::5]:443';
  const DST6_BYTES = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];

  test('redirect-helper compiles -Werror-clean on this host and selftest emits byte-exact v2 headers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-helper-linux-'));
    const bin = join(dir, 'redirect-helper');
    try {
      execFileSync(
        'cc',
        ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', bin, HELPER_SRC, CORE_SRC],
        { stdio: 'pipe', timeout: 60_000 },
      );
      const [helperPort, enginePort] = await freePorts(2);
      const out = execFileSync(bin, ['--selftest', String(helperPort), String(enginePort)], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          BM_HELPER_TEST_DST: DST4,
          BM_HELPER_TEST_DST6: DST6,
        },
      });
      expect(out).toContain('selftest: PASS');
      expect(out).toContain('payload=match');
      expect(out).not.toContain('payload=mismatch');

      const clientPorts = [...out.matchAll(/client_port=(\d+)/g)].map((m) => Number(m[1]));
      expect(clientPorts).toHaveLength(2);

      const h4 = out.match(/selftest: af=4 dst=\S+ header=([0-9a-f]+)/);
      expect(h4?.[1]).toBe(expectedV4(clientPorts[0], '203.0.113.7', 8443));

      const h6 = out.match(/selftest: af=6 dst=\S+ header=([0-9a-f]+)/);
      expect(h6?.[1]).toBe(expectedV6(clientPorts[1], DST6_BYTES, 443));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * macOS capture scripts — render + hygiene suite for P1 Task 3's shipped
 * surface (install/uninstall/rehearse + the helper build script). Every
 * assertion that can run cross-platform does (bash -n, render-only text
 * checks, non-root refusal); plutil -lint and pfctl -nf are darwin-gated
 * since those tools only exist on macOS.
 *
 * Nothing here needs root — `--render-only` emits the same anchor/plist
 * heredocs the root path writes verbatim, so the tested bytes are the
 * deployed bytes. The live capture path itself is exercised by
 * scripts/macos-capture-rehearse.sh under an operator's sudo, never by CI.
 */

import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

jest.setTimeout(60_000);

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SCRIPTS = join(REPO_ROOT, 'scripts');
const INSTALL = join(SCRIPTS, 'install-macos-capture.sh');
const UNINSTALL = join(SCRIPTS, 'uninstall-macos-capture.sh');
const REHEARSE = join(SCRIPTS, 'macos-capture-rehearse.sh');
const PF_ANCHOR = join(SCRIPTS, 'pf-anchor.sh');
const BUILD_SH = join(REPO_ROOT, 'packages/https-filter/helper/macos/build.sh');
const ALL_SCRIPTS = [INSTALL, UNINSTALL, REHEARSE, PF_ANCHOR, BUILD_SH];

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const hasBash = (() => {
  try {
    execFileSync('bash', ['-n', INSTALL], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const isDarwin = process.platform === 'darwin';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasLsof = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v lsof'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** Try to hold a listening socket — first of `ports` that binds wins; null = all squatted already. */
function holdPort(ports: number[]): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const tryNext = (i: number) => {
      if (i >= ports.length) return resolve(null);
      const srv = net.createServer();
      srv.once('error', () => tryNext(i + 1));
      srv.listen(ports[i], '127.0.0.1', () => resolve(srv));
    };
    tryNext(0);
  });
}

/** True only when every port can be bound-and-released right now. */
async function allFree(ports: number[]): Promise<boolean> {
  for (const p of ports) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

describe('macos capture scripts — hygiene', () => {
  (hasBash ? test : test.skip)('all scripts pass bash -n', () => {
    for (const script of ALL_SCRIPTS) {
      execFileSync('bash', ['-n', script], { stdio: 'pipe' });
    }
  });

  test('installer hard-gates on EUID before mutating anything', () => {
    const text = readFileSync(INSTALL, 'utf8');
    const euidAt = text.indexOf('[[ $EUID -eq 0 ]]');
    const dsclAt = text.indexOf('dscl . -create "/Users/');
    const armAt = text.indexOf('"$APP_SUPPORT_DIR/pf-anchor.sh" load');
    expect(euidAt).toBeGreaterThan(-1);
    // The EUID gate sits after the --render-only early-return but before
    // the first real system mutation (user create / anchor arm).
    expect(euidAt).toBeLessThan(dsclAt);
    expect(euidAt).toBeLessThan(armAt);
  });

  test('--service-user is restricted to a login-name shape before use', () => {
    // Raw input lands in `user !=` filter rules + dscl paths — the regex
    // must run before the render-only early-return and before any mutation.
    const text = readFileSync(INSTALL, 'utf8');
    expect(text).toMatch(/SERVICE_USER" =~ \^\[a-z_\]\[a-z0-9_-\]/);
    const gateAt = text.indexOf('SERVICE_USER" =~');
    const renderAt = text.indexOf('if [[ -n "$RENDER_ONLY" ]]');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(renderAt);
  });

  test('installer refuses occupied capture ports BEFORE any mutation', () => {
    const text = readFileSync(INSTALL, 'utf8');
    // The preflight probes all three ports the install will own.
    expect(text).toContain('lsof -nP -iTCP:${CONTROL_PORT} -iTCP:${ENGINE_PORT} -iTCP:${HELPER_PORT} -sTCP:LISTEN');
    expect(text).toContain('an engine already listens on :${CONTROL_PORT}/:${ENGINE_PORT} — stop it before installing capture');
    // The --preflight-only seam exists for suites to drive it without root.
    expect(text).toContain('--preflight-only');
    // On the real path the check runs after the EUID/Darwin gates and before
    // the first mutation (the dscl user-create).
    const euidAt = text.indexOf('[[ $EUID -eq 0 ]]');
    const callAt = text.indexOf('\nport_preflight\n');
    const dsclAt = text.indexOf('dscl . -create "/Users/');
    expect(callAt).toBeGreaterThan(euidAt);
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(dsclAt);
  });

  test('an omitted rulesPath defaults to the canonical compiled output with a missing-file warning', () => {
    const text = readFileSync(INSTALL, 'utf8');
    // Canonical default — join(dirname(savePath), 'browser.txt') under
    // ~/Documents/Blockingmachine, with $SUDO_USER's home honored under sudo.
    expect(text).toContain('Documents/Blockingmachine/browser.txt');
    expect(text).toContain('SUDO_USER');
    expect(text).toMatch(/warning: \$RULES_PATH does not exist — capture will start with 0 rules until a compile lands \+ reload/);
    // The defaulting block runs before any render emitter is invoked so a
    // render-only plist carries the resolved path.
    const defaultAt = text.indexOf('rulesPath not given');
    const emitAt = text.indexOf('render_proxy_plist > "$PROXY_PLIST"');
    const renderOnlyEmitAt = text.indexOf('render_proxy_plist > "$RENDER_ONLY/com.blockingmachine.proxy.plist"');
    expect(defaultAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(defaultAt).toBeLessThan(emitAt);
    expect(defaultAt).toBeLessThan(renderOnlyEmitAt);
  });

  test('install verify probes the engine control API, not just launchd registration', () => {
    const text = readFileSync(INSTALL, 'utf8');
    // Registration is not health — the final gate is a bounded status probe.
    expect(text).toContain('/v1/proxy/status');
    expect(text).toMatch(/curl -sf --max-time 2 "http:\/\/127\.0\.0\.1:\$\{CONTROL_PORT\}\/v1\/proxy\/status"/);
    const probeAt = text.indexOf('engine_up=0');
    const bootAt = text.indexOf('boot_or_fresh "$PROXY_PLIST"');
    expect(probeAt).toBeGreaterThan(bootAt);
    // The proxy's launchctl-print check is gone — only the helper's remains.
    expect(text).not.toContain('launchctl print "system/com.blockingmachine.proxy"');
  });

  test('uninstall flushes the anchor a second time after bootout (helper re-arm race)', () => {
    const text = readFileSync(UNINSTALL, 'utf8');
    const bootoutAt = text.indexOf('launchctl bootout "system/$label"');
    const firstFlushAt = text.indexOf('pfctl -a "$ANCHOR_NAME" -F all');
    const secondFlushAt = text.indexOf('pfctl -a "$ANCHOR_NAME" -F all', bootoutAt);
    expect(firstFlushAt).toBeGreaterThan(-1);
    expect(firstFlushAt).toBeLessThan(bootoutAt);
    expect(secondFlushAt).toBeGreaterThan(bootoutAt);
  });

  test('rehearse script is sudo-gated and never self-escalates', () => {
    const text = readFileSync(REHEARSE, 'utf8');
    expect(text).toMatch(/MUST BE RUN AS ROOT/);
    expect(text).toMatch(/\[\[ \$EUID -eq 0 \]\]/);
    // No sudo/osascript invocation outside comments and literal strings —
    // strip comment lines, then quoted content (the root-gate message
    // itself says "sudo $0" inside an echo string), and check the rest.
    const code = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
      .replace(/"[^"\n]*"/g, '""')
      .replace(/'[^'\n]*'/g, "''");
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/osascript/);
    // Trap-driven cleanup guarantees no rdr survives a failure path.
    expect(text).toMatch(/trap cleanup EXIT INT TERM/);
    expect(text).toMatch(/pfctl -a "\$ANCHOR_NAME" -F all/);
  });

  test('pf-anchor.sh is the single arm sequence — installed, invoked, removed', () => {
    const install = readFileSync(INSTALL, 'utf8');
    const uninstall = readFileSync(UNINSTALL, 'utf8');
    const anchor = readFileSync(PF_ANCHOR, 'utf8');
    // The installer ships it beside the helper and arms through it.
    expect(install).toContain('pf-anchor.sh');
    expect(install).toMatch(/install -o root -g wheel -m 0755 .*pf-anchor\.sh/);
    expect(install).toContain('"$APP_SUPPORT_DIR/pf-anchor.sh" load');
    // The shared script owns the state-file + conditional -E bookkeeping —
    // the installer must not carry a second copy of the pfctl sequence.
    expect(anchor).toContain('pfctl -a "$ANCHOR_NAME" -f "$ANCHOR_FILE"');
    expect(anchor).toContain('>> "$STATE_FILE"');
    expect(install).not.toMatch(/pfctl -a "\$ANCHOR_NAME" -f/);
    // Uninstall releases EVERY recorded token (re-arm appends fresh ones)
    // and removes the installed script.
    expect(uninstall).toContain('PF_TOKEN=');
    expect(uninstall).toMatch(/while IFS= read -r t/);
    expect(uninstall).toMatch(/pfctl -X "\$t"/);
    expect(uninstall).toContain('pf-anchor.sh');
    expect(uninstall).not.toMatch(/sed -n 's\/\^PF_TOKEN=\/\/p' "\$STATE_FILE" \| head -1/);
  });

  test('helper re-arms through the installed pf-anchor.sh, gated on state file + probe', () => {
    const helper = readFileSync(join(REPO_ROOT, 'packages/https-filter/helper/macos/natlook-helper.c'), 'utf8');
    // The startup gate: state file present AND anchor absent → pending arm.
    expect(helper).toContain('"/etc/blockingmachine-capture.state"');
    expect(helper).toContain('pf-anchor.sh');
    expect(helper).toMatch(/g_rearm_pending/);
    // A real watchdog flush vetoes the pending arm (no rule oscillation).
    expect(helper).toMatch(/g_rearm_pending = 0;/);
  });

  test('rehearse proves the block via flowsBlocked delta and re-arm via kickstart', () => {
    const text = readFileSync(REHEARSE, 'utf8');
    // Stats delta — a refused curl alone passes vacuously on a dead pin.
    expect(text).toContain('/v1/proxy/stats');
    expect(text).toContain('flowsBlocked');
    expect(text).toMatch(/blocked_after -gt \$blocked_before/);
    // Re-arm rehearsal: manual flush + helper restart must reload the anchor.
    expect(text).toMatch(/launchctl kickstart -k system\/com\.blockingmachine\.natlook/);
    expect(text).toMatch(/pfctl -a "\$ANCHOR_NAME" -F all/);
  });

  test('rehearse --root-squat leg drives the real installer under root and asserts the refusal', () => {
    const text = readFileSync(REHEARSE, 'utf8');
    expect(text).toContain('--root-squat');
    // The leg runs the REAL installer (not --preflight-only) so the refusal
    // is proven mid-flow, under the script's own root context.
    expect(text).toContain('bash "$INSTALL" "$BUNDLE_PATH" "$ENGINE_RUNNER" 2>&1');
    expect(text).toContain('an engine already listens on :9293/:9294');
    // The squat listener binds :9294 and is verified through the SAME lsof
    // probe the installer runs — a vacuous bind cannot pass the leg.
    expect(text).toMatch(/lsof -nP -iTCP:"\$ENGINE_PORT" -sTCP:LISTEN/);
    // The squatter self-reaps on parent death (getppid flips to 1 under
    // launchd) rather than holding :9294 on a fixed sleep bound — a
    // SIGKILLed rehearsal must not leak a squatted port.
    expect(text).toMatch(/while os\.getppid\(\) != 1/);
    // Post-state assertions: no new service account, and every artifact
    // the installer would touch absent-or-byte-identical (fingerprint tsv).
    expect(text).toMatch(/dscl \. -read "\/Users\/_blockingmachine"/);
    expect(text).toContain('before.tsv');
    // Squat-mode cleanup is scoped to the squatter — it must never run the
    // rehearsal's uninstall/flush path on a real install.
    expect(text).toMatch(/ROOT_SQUAT -eq 1/);
  });
});

(hasBash ? describe : describe.skip)('macos capture scripts — render-only artifacts', () => {
  const render = (user?: string): string => {
    const out = mkdtempSync(join(tmpdir(), 'bm-render-'));
    tmpDirs.push(out);
    const args = ['--render-only', out, '/pkg/dist/main.js', '/runner/node', '/rules/compiled.rules'];
    if (user !== undefined) args.push('--service-user', user);
    execFileSync('bash', [INSTALL, ...args], { stdio: 'pipe' });
    return out;
  };
  const dir = render();

  test('rendered file set is exactly anchor + two plists', () => {
    expect(readdirSync(dir).sort()).toEqual([
      'com.blockingmachine.anchor',
      'com.blockingmachine.natlook.plist',
      'com.blockingmachine.proxy.plist',
    ]);
  });

  test('anchor renders rdr-on-lo0, user exemption, QUIC suppression, correct ports', () => {
    const anchor = readFileSync(join(dir, 'com.blockingmachine.anchor'), 'utf8');
    // Nested attach point — the only path the stock ruleset evaluates.
    expect(anchor).toContain('com.apple/com.blockingmachine');
    // Local outbound detour + inbound rdr, both families, helper port 9295.
    expect(anchor).toMatch(/rdr pass on lo0 inet proto tcp .*-> 127\.0\.0\.1 port 9295/);
    expect(anchor).toMatch(/rdr pass on lo0 inet6 proto tcp .*-> ::1 port 9295/);
    expect(anchor).toMatch(/pass out quick route-to lo0 inet proto tcp .*user != _blockingmachine/);
    expect(anchor).toMatch(/pass out quick route-to lo0 inet6 proto tcp .*user != _blockingmachine/);
    // no-rdr exemption (the only legal rdr-level exclusion — user cannot
    // appear in an rdr rule on macOS pf).
    expect(anchor).toMatch(/no rdr on lo0 inet proto tcp .*127\.0\.0\.0\/8/);
    expect(anchor).toMatch(/no rdr on lo0 inet6 proto tcp .*::1/);
    // QUIC suppression — UDP/443 drop so clients fall back to TCP, scoped
    // with the same user exemption as the route-to rules (an unscoped drop
    // would also kill routed LAN clients' QUIC — forwarded packets match no
    // user clause, so they never match this rule at all).
    expect(anchor).toMatch(/block drop out quick proto udp from any to any port 443 user != _blockingmachine/);
  });

  test('natlook plist invokes helper 9295 → 127.0.0.1:9294 with KeepAlive', () => {
    const plist = readFileSync(join(dir, 'com.blockingmachine.natlook.plist'), 'utf8');
    expect(plist).toContain('<string>com.blockingmachine.natlook</string>');
    const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    expect(args).toContain('/Library/Application Support/Blockingmachine/natlook-helper');
    expect(args).toContain('<string>9295</string>');
    expect(args).toContain('<string>127.0.0.1</string>');
    expect(args).toContain('<string>9294</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  test('proxy plist runs as _blockingmachine with BM_* env + control port 9293', () => {
    const plist = readFileSync(join(dir, 'com.blockingmachine.proxy.plist'), 'utf8');
    expect(plist).toContain('<string>com.blockingmachine.proxy</string>');
    expect(plist).toMatch(/<key>UserName<\/key>\s*<string>_blockingmachine<\/string>/);
    const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    expect(args).toContain('<string>/runner/node</string>');
    expect(args).toContain('<string>/pkg/dist/main.js</string>');
    expect(plist).toContain('/Users/Shared/Blockingmachine/https-filter');
    expect(plist).toMatch(/<key>BM_DATA_PORT<\/key>\s*<string>9294<\/string>/);
    expect(plist).toMatch(/<key>BM_CONTROL_PORT<\/key>\s*<string>9293<\/string>/);
    expect(plist).toMatch(/<key>BM_RULES_PATH<\/key>\s*<string>\/rules\/compiled\.rules<\/string>/);
    expect(plist).toMatch(/<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
    // BM_KEYWRAP pinned off: _blockingmachine has no login keychain, so
    // keystore auto-resolve would degrade to plaintext anyway.
    expect(plist).toMatch(/<key>BM_KEYWRAP<\/key>\s*<string>off<\/string>/);
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  test('an omitted rulesPath renders the canonical Documents/Blockingmachine/browser.txt default', () => {
    const out = mkdtempSync(join(tmpdir(), 'bm-render-'));
    tmpDirs.push(out);
    execFileSync('bash', [INSTALL, '--render-only', out, '/pkg/dist/main.js', '/runner/node'], {
      stdio: 'pipe',
    });
    const plist = readFileSync(join(out, 'com.blockingmachine.proxy.plist'), 'utf8');
    expect(plist).toMatch(/<key>BM_RULES_PATH<\/key>\s*<string>[^<]*Documents\/Blockingmachine\/browser\.txt<\/string>/);
  });

  test('--service-user rejects bad names and accepts valid ones', () => {
    expect(() => render('bad;user')).toThrow();
    expect(() => render('UPPER')).toThrow();
    expect(() => render('1leading-digit')).toThrow();
    const ok = render('_ok-name2');
    const anchor = readFileSync(join(ok, 'com.blockingmachine.anchor'), 'utf8');
    expect(anchor).toContain('user != _ok-name2');
  });

  test('plist XML is structurally well-formed (and plutil-clean on darwin)', () => {
    for (const f of ['com.blockingmachine.natlook.plist', 'com.blockingmachine.proxy.plist']) {
      const xml = readFileSync(join(dir, f), 'utf8');
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toMatch(/<plist version="1\.0">[\s\S]*<\/plist>/);
      // Tag balance for every container/scalar type the render emits.
      for (const tag of ['dict', 'array', 'string', 'key']) {
        const open = xml.split(`<${tag}>`).length - 1;
        const close = xml.split(`</${tag}>`).length - 1;
        expect(open).toBe(close);
      }
      // Every <key> is immediately followed by a value element.
      const keyLines = xml.split('\n').filter((l) => l.includes('<key>'));
      for (const line of keyLines) {
        expect(line).toMatch(/<key>[^<]+<\/key>\s*$/);
      }
    }
  });

  (isDarwin ? test : test.skip)('plutil -lint accepts both rendered plists', () => {
    for (const f of ['com.blockingmachine.natlook.plist', 'com.blockingmachine.proxy.plist']) {
      const out = execFileSync('plutil', ['-lint', join(dir, f)], { encoding: 'utf8' });
      expect(out).toContain('OK');
    }
  });

  (isDarwin ? test : test.skip)('pfctl -nf accepts the rendered anchor with a real service user', () => {
    // _blockingmachine only exists post-install; render against the
    // current user so pfctl resolves the account and parses purely.
    const userDir = render(userInfo().username);
    const anchor = join(userDir, 'com.blockingmachine.anchor');
    const r = spawnSync('/sbin/pfctl', ['-nf', anchor], { encoding: 'utf8' });
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(combined).not.toMatch(/syntax error/i);
    expect(combined).not.toMatch(/unknown user/);
    expect(r.status).toBe(0);
  });

  (isDarwin ? test : test.skip)('uninstall flushes the anchor before touching services', () => {
    const text = readFileSync(UNINSTALL, 'utf8');
    const flushAt = text.indexOf('pfctl -a "$ANCHOR_NAME" -F all');
    const bootoutAt = text.indexOf('launchctl bootout "system/$label"');
    const rmAt = text.indexOf('rm -f "$f"');
    expect(flushAt).toBeGreaterThan(-1);
    expect(flushAt).toBeLessThan(bootoutAt);
    expect(flushAt).toBeLessThan(rmAt);
    // Store dir + service user are kept (CA/ledger survive reinstall).
    expect(text).toContain('kept: _blockingmachine account');
    expect(text).not.toMatch(/dscl . -delete/);
  });
});

describe('macos capture scripts — port preflight seam (--preflight-only)', () => {
  // lsof drives the check; without it the preflight self-reports skipped and
  // exits 0, so the functional assertions below need it present.
  const t = hasBash && hasLsof ? test : test.skip;

  t('dies naming the squatter when a capture port is occupied', async () => {
    // Bind whichever of the three is free on this host — if ALL are already
    // occupied (a real engine/capture running) the check must die anyway.
    const server = await holdPort([9295, 9294, 9293]);
    try {
      const r = spawnSync('bash', [INSTALL, '--preflight-only'], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(`${r.stderr}`).toMatch(/an engine already listens on :9293\/:9294 — stop it before installing capture/);
    } finally {
      server?.close();
    }
  });

  t('exits 0 when all three capture ports are free', async () => {
    if (!(await allFree([9293, 9294, 9295]))) {
      // A live engine/capture owns the ports on this machine — the occupied-
      // port case above already proves the refusal; nothing to prove here.
      return;
    }
    const r = spawnSync('bash', [INSTALL, '--preflight-only'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toMatch(/port preflight clean/);
  });
});

describe('macos capture scripts — non-root refusal', () => {
  const t = isRoot ? test.skip : test;

  t('installer exits nonzero as non-root before touching anything', () => {
    let rc = 0;
    try {
      execFileSync('bash', [INSTALL, '/fake/bundle', '/fake/runner'], { stdio: 'pipe' });
    } catch (err) {
      rc = (err as { status?: number }).status ?? 1;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/must run as root/);
    }
    expect(rc).toBe(1);
  });

  t('uninstaller exits nonzero as non-root', () => {
    let rc = 0;
    try {
      execFileSync('bash', [UNINSTALL], { stdio: 'pipe' });
    } catch (err) {
      rc = (err as { status?: number }).status ?? 1;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/must run as root/);
    }
    expect(rc).toBe(1);
  });

  t('rehearse exits 2 as non-root with the sudo hint', () => {
    let rc = 0;
    try {
      execFileSync('bash', [REHEARSE, '/fake/bundle', '/fake/runner'], { stdio: 'pipe' });
    } catch (err) {
      rc = (err as { status?: number }).status ?? 1;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/must run as root/);
    }
    expect(rc).toBe(2);
  });
});

// --------------------------------------------------------------------
// Linux capture scripts — render + hygiene suite for P3 Task 2's shipped
// surface (install/uninstall/rehearse + bm-anchor.sh + the helper build
// script). Same convention as the macOS blocks: bash -n + render-only
// text checks + non-root refusal run cross-platform; the functional
// port-preflight legs are linux-gated (ss//proc/net/tcp don't exist
// here) and the live capture itself is docker-gated through
// scripts/linux-capture-rehearse.sh, never by CI.
// --------------------------------------------------------------------

const INSTALL_LX = join(SCRIPTS, 'install-linux-capture.sh');
const UNINSTALL_LX = join(SCRIPTS, 'uninstall-linux-capture.sh');
const REHEARSE_LX = join(SCRIPTS, 'linux-capture-rehearse.sh');
const BM_ANCHOR = join(REPO_ROOT, 'packages/https-filter/helper/linux/bm-anchor.sh');
const BUILD_LX = join(REPO_ROOT, 'packages/https-filter/helper/linux/build.sh');
const ALL_LINUX_SCRIPTS = [INSTALL_LX, UNINSTALL_LX, REHEARSE_LX, BM_ANCHOR, BUILD_LX];
const isLinux = process.platform === 'linux';
const hasSs = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v ss'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('linux capture scripts — hygiene', () => {
  (hasBash ? test : test.skip)('all scripts pass bash -n', () => {
    for (const script of ALL_LINUX_SCRIPTS) {
      execFileSync('bash', ['-n', script], { stdio: 'pipe' });
    }
  });

  test('installer hard-gates on EUID before mutating anything', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    const euidAt = text.indexOf('[[ $EUID -eq 0 ]]');
    const useraddAt = text.indexOf('useradd -r -s "$NOLOGIN"');
    const armAt = text.indexOf('"$ANCHOR_DST" status');
    expect(euidAt).toBeGreaterThan(-1);
    expect(euidAt).toBeLessThan(useraddAt);
    expect(euidAt).toBeLessThan(armAt);
  });

  test('installer dies honestly when systemctl is absent — no silent sysvinit fallback', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    expect(text).toContain('command -v systemctl');
    expect(text).toMatch(/die "systemd required \(no systemctl\)/);
    expect(text).toMatch(/sysvinit\/openrc\/alpine are unsupported/);
    // The check sits after the EUID gate and before the port preflight /
    // user creation — nothing is probed or mutated on a foreign init.
    const gateAt = text.indexOf('command -v systemctl >/dev/null');
    const preflightCall = text.indexOf('\nport_preflight\n');
    const useraddAt = text.indexOf('useradd -r -s "$NOLOGIN"');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(preflightCall);
    expect(gateAt).toBeLessThan(useraddAt);
  });

  test('installer refuses occupied capture ports BEFORE any mutation (ss + /proc fallback)', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    expect(text).toContain('ss -ltnH');
    expect(text).toContain('/proc/net/tcp');
    expect(text).toContain('an engine already listens on :${CONTROL_PORT}/:${ENGINE_PORT} — stop it before installing capture');
    expect(text).toContain('--preflight-only');
    const gateAt = text.indexOf('command -v systemctl >/dev/null');
    const callAt = text.indexOf('\nport_preflight\n');
    const useraddAt = text.indexOf('useradd -r -s "$NOLOGIN"');
    expect(callAt).toBeGreaterThan(gateAt);
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(useraddAt);
  });

  test('an omitted rulesPath defaults to Documents/Blockingmachine/browser.txt via SUDO_USER home (NSS)', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    expect(text).toContain('Documents/Blockingmachine/browser.txt');
    expect(text).toContain('SUDO_USER');
    expect(text).toContain('getent passwd');
    expect(text).toMatch(/warning: \$RULES_PATH does not exist — capture will start with 0 rules until a compile lands \+ reload/);
  });

  test('install verify probes the engine control API, not just unit registration', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    expect(text).toContain('/v1/proxy/status');
    expect(text).toMatch(/curl -sf --max-time 2 "http:\/\/127\.0\.0\.1:\$\{CONTROL_PORT\}\/v1\/proxy\/status"/);
    const probeAt = text.indexOf('engine_up=0');
    const armAt = text.indexOf('systemctl restart blockingmachine-capture-rules.service');
    expect(probeAt).toBeGreaterThan(armAt);
    // The rules-presence gate is the anchor script's own status verb —
    // no second copy of the mechanism logic.
    expect(text).toContain('"$ANCHOR_DST" status');
  });

  test('install renders through bm-anchor.sh — the single rules implementation', () => {
    const text = readFileSync(INSTALL_LX, 'utf8');
    expect(text).toMatch(/install -o root -g root -m 0755 "\$ANCHOR_SRC" "\$ANCHOR_DST"/);
    // The capture-rules unit ExecStarts the INSTALLED copy.
    expect(text).toMatch(/ExecStart=\$\{ANCHOR_DST\} load --uid \$\{SERVICE_USER\} --helper-port \$\{HELPER_PORT\}/);
    expect(text).toMatch(/ExecStop=\$\{ANCHOR_DST\} flush-only/);
    // No raw nft/iptables in the installer — the mechanics live in
    // bm-anchor.sh exactly once (the pf-anchor.sh contract).
    expect(text).not.toMatch(/\bnft add rule|\bnft -f|\biptables -A/);
  });

  test('uninstall flushes rules a second time after unit stop (helper re-arm race)', () => {
    const text = readFileSync(UNINSTALL_LX, 'utf8');
    const stopAt = text.indexOf('systemctl stop "${UNITS[@]}"');
    const firstFlushAt = text.indexOf('"$ANCHOR_DST" flush-only');
    const secondFlushAt = text.indexOf('"$ANCHOR_DST" flush-only', stopAt);
    expect(firstFlushAt).toBeGreaterThan(-1);
    expect(firstFlushAt).toBeLessThan(stopAt);
    expect(secondFlushAt).toBeGreaterThan(stopAt);
    // Unit files, state file, installed helpers all removed; the user
    // and store stay (CA/ledger survive reinstall — the mac posture).
    expect(text).toContain('blockingmachine-capture-rules.service');
    expect(text).toContain('"$STATE_FILE"');
    expect(text).toContain('kept: blockingmachine account');
    expect(text).not.toMatch(/userdel|deluser/);
  });

  test('rehearse is docker-gated, NET_ADMIN, never pulls, never self-escalates', () => {
    const text = readFileSync(REHEARSE_LX, 'utf8');
    expect(text).toMatch(/NEVER AUTO-RUN/);
    expect(text).toContain('docker image inspect');
    expect(text).toContain('--cap-add NET_ADMIN');
    expect(text).toMatch(/docker run -d --name "\$CONTAINER"/);
    // No docker pull / sudo outside comments and literal strings.
    const code = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
      .replace(/"[^"\n]*"/g, '""')
      .replace(/'[^'\n]*'/g, "''");
    expect(code).not.toMatch(/docker pull/);
    expect(code).not.toMatch(/\bsudo\b/);
    // The rehearsal drives the real contract: compile → install →
    // transparent allow → block verdicts → watchdog flush → fail-open →
    // flush-only clean.
    expect(text).toContain('/v1/proxy/ca');
    expect(text).toContain('flowsBlocked');
    expect(text).toContain('403');
    expect(text).toContain('flush-only');
    expect(text).toContain('--selftest');
    expect(text).toContain('runuser -u blockingmachine');
    // Systemd is honestly out of scope in the container — named as such.
    expect(text).toMatch(/No systemd in a plain container/);
  });
});

(hasBash ? describe : describe.skip)('linux capture scripts — render-only artifacts', () => {
  const render = (user?: string): string => {
    const out = mkdtempSync(join(tmpdir(), 'bm-render-lx-'));
    tmpDirs.push(out);
    const args = ['--render-only', out, '/pkg/dist/main.js', '/usr/bin/node', '/rules/compiled.rules'];
    if (user !== undefined) args.push('--service-user', user);
    execFileSync('bash', [INSTALL_LX, ...args], { stdio: 'pipe' });
    return out;
  };
  const dir = render();

  test('rendered file set is exactly three units + the mechanism rule renders', () => {
    expect(readdirSync(dir).sort()).toEqual([
      'blockingmachine-capture-rules.service',
      'blockingmachine-helper.service',
      'blockingmachine-proxy.service',
      'blockingmachine.nft',
      'ip6tables.rules',
      'iptables.rules',
    ]);
  });

  test('nft render carries nat output chains (both families), skuid exemption, redirect, QUIC drop', () => {
    const nft = readFileSync(join(dir, 'blockingmachine.nft'), 'utf8');
    expect(nft).toMatch(/table ip blockingmachine_nat \{/);
    expect(nft).toMatch(/table ip6 blockingmachine_nat \{/);
    expect(nft.match(/type nat hook output priority -100/g)).toHaveLength(2);
    expect(nft.match(/meta skuid blockingmachine return/g)).toHaveLength(2);
    expect(nft.match(/tcp dport \{ 80,443 \} redirect to :9295/g)).toHaveLength(2);
    expect(nft.match(/udp dport 443 drop/g)).toHaveLength(2);
  });

  test('iptables render carries owner exemption, multiport REDIRECT, QUIC drop (v4+v6 twins)', () => {
    for (const f of ['iptables.rules', 'ip6tables.rules']) {
      const rules = readFileSync(join(dir, f), 'utf8');
      expect(rules).toContain('-t nat -A OUTPUT -m owner --uid-owner blockingmachine -j RETURN');
      expect(rules).toContain('-t nat -A OUTPUT -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 9295');
      // The QUIC drop lives in the filter table — the nf_tables iptables
      // backend refuses filtering verdicts in nat ("not intended for
      // filtering"), caught live by the docker rehearsal. The owner
      // RETURN rides along so the engine's own UDP/443 stays exempt,
      // matching the nft leg's skuid-first ordering.
      expect(rules).toContain('-t filter -A OUTPUT -m owner --uid-owner blockingmachine -j RETURN');
      expect(rules).toContain('-t filter -A OUTPUT -p udp --dport 443 -j DROP');
      expect(rules).not.toContain('-t nat -A OUTPUT -p udp');
    }
  });

  test('proxy unit runs the engine as blockingmachine with the BM_* env contract', () => {
    const unit = readFileSync(join(dir, 'blockingmachine-proxy.service'), 'utf8');
    expect(unit).toContain('User=blockingmachine');
    expect(unit).toContain('Environment="BM_STORE_DIR=/var/lib/blockingmachine/https-filter"');
    expect(unit).toContain('Environment="BM_DATA_PORT=9294"');
    expect(unit).toContain('Environment="BM_CONTROL_PORT=9293"');
    expect(unit).toContain('Environment="BM_KEYWRAP=off"');
    expect(unit).toContain('Environment="BM_RULES_PATH=/rules/compiled.rules"');
    expect(unit).toContain('ExecStart=/usr/bin/node /pkg/dist/main.js');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  test('helper unit runs the installed helper as root', () => {
    const unit = readFileSync(join(dir, 'blockingmachine-helper.service'), 'utf8');
    expect(unit).toContain('ExecStart=/usr/local/libexec/blockingmachine/redirect-helper 9295 9294');
    expect(unit).not.toContain('User='); // root — the conntrack lookup needs it
    expect(unit).toContain('Restart=always');
  });

  test('capture-rules unit is the boot re-arm — oneshot RemainAfterExit, load/flush pair', () => {
    const unit = readFileSync(join(dir, 'blockingmachine-capture-rules.service'), 'utf8');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('ExecStart=/usr/local/libexec/blockingmachine/bm-anchor.sh load --uid blockingmachine --helper-port 9295');
    expect(unit).toContain('ExecStop=/usr/local/libexec/blockingmachine/bm-anchor.sh flush-only');
    expect(unit).toContain('WantedBy=multi-user.target');
    // Ordered after the services that must be alive when traffic starts
    // redirecting — a redirect must never meet a dead engine/listener.
    expect(unit).toContain('After=blockingmachine-proxy.service blockingmachine-helper.service');
  });

  test('an omitted rulesPath renders the canonical Documents/Blockingmachine/browser.txt default', () => {
    const out = mkdtempSync(join(tmpdir(), 'bm-render-lx-'));
    tmpDirs.push(out);
    execFileSync('bash', [INSTALL_LX, '--render-only', out, '/pkg/dist/main.js', '/usr/bin/node'], {
      stdio: 'pipe',
    });
    const unit = readFileSync(join(out, 'blockingmachine-proxy.service'), 'utf8');
    expect(unit).toMatch(/Environment="BM_RULES_PATH=[^"]*Documents\/Blockingmachine\/browser\.txt"/);
  });

  test('--service-user rejects bad names and threads a valid one through units + rules', () => {
    expect(() => render('bad;user')).toThrow();
    expect(() => render('UPPER')).toThrow();
    expect(() => render('1leading-digit')).toThrow();
    const ok = render('_ok-name2');
    const proxy = readFileSync(join(ok, 'blockingmachine-proxy.service'), 'utf8');
    const rules = readFileSync(join(ok, 'blockingmachine-capture-rules.service'), 'utf8');
    const nft = readFileSync(join(ok, 'blockingmachine.nft'), 'utf8');
    expect(proxy).toContain('User=_ok-name2');
    expect(rules).toContain('--uid _ok-name2');
    expect(nft).toContain('meta skuid _ok-name2 return');
  });

  test('bm-anchor.sh render emits both mechanisms to a dir directly', () => {
    const out = mkdtempSync(join(tmpdir(), 'bm-anchor-render-'));
    tmpDirs.push(out);
    execFileSync('bash', [BM_ANCHOR, 'render', out, '--uid', '998', '--helper-port', '9295'], {
      stdio: 'pipe',
    });
    expect(readdirSync(out).sort()).toEqual([
      'blockingmachine.nft',
      'ip6tables.rules',
      'iptables.rules',
    ]);
    const nft = readFileSync(join(out, 'blockingmachine.nft'), 'utf8');
    expect(nft).toContain('meta skuid 998 return');
    const ip4 = readFileSync(join(out, 'iptables.rules'), 'utf8');
    expect(ip4).toContain('--uid-owner 998');
  });
});

describe('linux capture scripts — port preflight seam (--preflight-only)', () => {
  // ss//proc/net/tcp are linux surfaces — the functional legs run on
  // linux CI only; darwin asserts the seam exists structurally above.
  const t = hasBash && isLinux && hasSs ? test : test.skip;

  t('dies naming the squatter when a capture port is occupied', async () => {
    const server = await holdPort([9295, 9294, 9293]);
    try {
      const r = spawnSync('bash', [INSTALL_LX, '--preflight-only'], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(`${r.stderr}`).toMatch(/an engine already listens on :9293\/:9294 — stop it before installing capture/);
    } finally {
      server?.close();
    }
  });

  t('exits 0 when all three capture ports are free', async () => {
    if (!(await allFree([9293, 9294, 9295]))) {
      return; // a live engine owns the ports — the refusal case covers it
    }
    const r = spawnSync('bash', [INSTALL_LX, '--preflight-only'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toMatch(/port preflight clean/);
  });
});

describe('linux capture scripts — non-root refusal', () => {
  const t = isRoot ? test.skip : test;

  t('installer exits nonzero as non-root before touching anything', () => {
    let rc = 0;
    try {
      execFileSync('bash', [INSTALL_LX, '/fake/bundle', '/fake/runner'], { stdio: 'pipe' });
    } catch (err) {
      rc = (err as { status?: number }).status ?? 1;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/must run as root/);
    }
    expect(rc).toBe(1);
  });

  t('uninstaller exits nonzero as non-root', () => {
    let rc = 0;
    try {
      execFileSync('bash', [UNINSTALL_LX], { stdio: 'pipe' });
    } catch (err) {
      rc = (err as { status?: number }).status ?? 1;
      expect(String((err as { stderr?: Buffer }).stderr)).toMatch(/must run as root/);
    }
    expect(rc).toBe(1);
  });
});

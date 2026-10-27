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
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

jest.setTimeout(60_000);

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SCRIPTS = join(REPO_ROOT, 'scripts');
const INSTALL = join(SCRIPTS, 'install-macos-capture.sh');
const UNINSTALL = join(SCRIPTS, 'uninstall-macos-capture.sh');
const REHEARSE = join(SCRIPTS, 'macos-capture-rehearse.sh');
const BUILD_SH = join(REPO_ROOT, 'packages/https-filter/helper/macos/build.sh');
const ALL_SCRIPTS = [INSTALL, UNINSTALL, REHEARSE, BUILD_SH];

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
    const pfctlAt = text.indexOf('pfctl -a "$ANCHOR_NAME" -f');
    expect(euidAt).toBeGreaterThan(-1);
    // The EUID gate sits after the --render-only early-return but before
    // the first real system mutation (user create / pfctl load).
    expect(euidAt).toBeLessThan(dsclAt);
    expect(euidAt).toBeLessThan(pfctlAt);
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
    // QUIC suppression — UDP/443 drop so clients fall back to TCP.
    expect(anchor).toMatch(/block drop out quick proto udp from any to any port 443/);
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
    expect(plist).toContain('<key>KeepAlive</key>');
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

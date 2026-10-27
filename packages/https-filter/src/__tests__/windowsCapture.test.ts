/**
 * Windows capture leg (P3 Task 1) — structural suite.
 *
 * This host can't compile or run the WFP helper (no Windows SDK, no
 * elevated Windows session), so the runtime legs are honestly gated:
 *
 * - If a PowerShell interpreter exists (pwsh/powershell — e.g. windows
 *   CI runners), each .ps1 is PARSE-checked with the real parser, not
 *   just text-matched.
 * - redirect-helper.c is asserted on the pinned WFP surface: the
 *   ALE_CONNECT_REDIRECT layers, the system callout key, the redirect
 *   handle API, the session-dynamic flag (fail-open mechanism), the
 *   ALE_APP_ID exclusions, both SIO_QUERY_* IOCTLs, CreateThread worker,
 *   the shared-core calls, argv/env seams, and the BM_WFP_PATH_STATUS
 *   UNVALIDATED marker (the plan requires "untested" to be
 *   distinguishable from "works" — never silently claim either).
 */

import { describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

jest.setTimeout(60_000);

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REPO = join(PKG_DIR, '..', '..');
const HELPER_DIR = join(PKG_DIR, 'helper', 'windows');
const HELPER_SRC = join(HELPER_DIR, 'redirect-helper.c');
const BUILD_PS = join(HELPER_DIR, 'build.ps1');
const INSTALL = join(REPO, 'scripts', 'install-windows-capture.ps1');
const UNINSTALL = join(REPO, 'scripts', 'uninstall-windows-capture.ps1');
const REHEARSE = join(REPO, 'scripts', 'windows-capture-rehearse.ps1');
const GATE_MJS = join(PKG_DIR, 'helper', 'build-if-win32.mjs');
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

const pwsh = (() => {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], { stdio: 'pipe' });
      return exe;
    } catch { /* try next */ }
  }
  return null;
})();
const describePwsh = pwsh ? describe : describe.skip;

describe('windows redirect-helper.c — pinned WFP surface', () => {
  const src = readFileSync(HELPER_SRC, 'utf8');

  test('connect-redirect layers + system callout + redirect handle', () => {
    expect(src).toContain('FWPM_LAYER_ALE_CONNECT_REDIRECT_V4');
    expect(src).toContain('FWPM_LAYER_ALE_CONNECT_REDIRECT_V6');
    expect(src).toContain('FWPM_CALLOUT_TCP_REDIRECT_CONNECT_LAYER');
    expect(src).toContain('FwpmRedirectHandleCreate');
    expect(src).toContain('FwpmRedirectHandleDestroy');
  });

  test('session-dynamic filters = fail-open by construction', () => {
    expect(src).toContain('FWPM_SESSION_FLAG_DYNAMIC');
    expect(src).toContain('FwpmEngineOpen0');
    // Clean shutdown deletes filters explicitly and closes the engine —
    // belt on top of the session-death mechanism.
    expect(src).toContain('FwpmFilterDeleteById');
    expect(src).toContain('FwpmEngineClose');
  });

  test('engine/helper egress exemption via higher-weight ALE_APP_ID permits', () => {
    expect(src).toContain('FWPM_CONDITION_ALE_APP_ID');
    expect(src).toContain('FwpmGetAppIdFromFileName0');
    expect(src).toContain('FWP_ACTION_PERMIT');
    // exclusion weight must exceed the redirect weight
    expect(src).toContain('g_weight_exclude');
    expect(src).toContain('g_weight_redirect');
  });

  test('origdst via WFP redirect records + context IOCTLs', () => {
    expect(src).toContain('SIO_QUERY_WFP_CONNECTION_REDIRECT_RECORDS');
    expect(src).toContain('SIO_QUERY_WFP_CONNECTION_REDIRECT_CONTEXT');
    expect(src).toContain('WSAIoctl');
  });

  test('shared core consumption — flow lifecycle, watchdog loop, socket shim', () => {
    expect(src).toContain('bm_handle_connection');
    expect(src).toContain('bm_watchdog_loop');
    expect(src).toContain('bm_children_full');
    expect(src).toContain('bm_listen_on');
    expect(src).toContain('bm_test_dst_from_env');
    expect(src).toContain('bm_sock_close');
    expect(src).toContain('../common/splice.h');
  });

  test('thread-per-connection bounded by the shared cap', () => {
    expect(src).toContain('CreateThread');
    expect(src).toContain('BM_MAX_CHILDREN');
    expect(src).toContain('bm_child_spawned');
    expect(src).toContain('bm_child_reaped');
  });

  test('argv + test seams per plan', () => {
    expect(src).toContain('--exclude-app');
    expect(src).toContain('--selftest');
    expect(src).toContain('BM_HELPER_TEST_DST');
  });

  test('watchdog closes WFP session and exits nonzero for SCM restart', () => {
    expect(src).toContain('ExitProcess');
    expect(src).toContain('wfp_teardown');
  });

  test('honesty marker — WFP path is marked UNVALIDATED, never claimed working', () => {
    expect(src).toContain('BM_WFP_PATH_STATUS');
    expect(src).toContain('UNVALIDATED');
    // WinDivert may be NAMED as the documented fallback — but must never
    // be silently implemented (no driver open, no divert headers).
    expect(src).not.toMatch(/WinDivertOpen|windivert\.h/);
  });
});

describe('windows build + npm wiring', () => {
  test('build.ps1 compiles both TUs with the pinned flags and libs', () => {
    const ps = readFileSync(BUILD_PS, 'utf8');
    expect(ps).toContain('redirect-helper.c');
    expect(ps).toContain('splice.c');
    expect(ps).toContain('/W4');
    expect(ps).toContain('/WX');
    expect(ps).toContain('fwpuclnt.lib');
    expect(ps).toContain('ws2_32.lib');
    expect(ps).toContain('cl.exe');
    expect(ps).toContain('clang-cl');
  });

  test('build-if-win32.mjs gates on win32 like the darwin twin', () => {
    const m = readFileSync(GATE_MJS, 'utf8');
    expect(m).toContain("process.platform === 'win32'");
    expect(m).toContain('build.ps1');
  });

  test('package.json prebuild runs both platform gates', () => {
    expect(PKG.scripts.prebuild).toContain('build-if-darwin.mjs');
    expect(PKG.scripts.prebuild).toContain('build-if-win32.mjs');
  });
});

describe('windows install/uninstall/rehearse scripts', () => {
  test('installer: admin gate + port preflight + both services + env multistring + health check', () => {
    const ps = readFileSync(INSTALL, 'utf8');
    expect(ps).toContain('BlockingmachineHelper');
    expect(ps).toContain('BlockingmachineProxy');
    expect(ps).toContain('sc.exe create');
    expect(ps).toContain('binPath=');
    expect(ps).toContain('HKLM:\\SYSTEM\\CurrentControlSet\\Services');
    expect(ps).toContain('Environment');
    expect(ps).toContain('MultiString');
    expect(ps).toContain('/v1/proxy/status');
    expect(ps).toContain('9293');
    expect(ps).toContain('9294');
    expect(ps).toContain('9295');
    expect(ps).toContain('Administrator');
    // Engine env contract — same keys as the macOS plist.
    expect(ps).toContain('BM_STORE_DIR');
    expect(ps).toContain('BM_DATA_PORT');
    expect(ps).toContain('BM_CONTROL_PORT');
    expect(ps).toContain('BM_KEYWRAP=off');
    // Helper args: port pair + engine exe exemption.
    expect(ps).toContain('--exclude-app');
    // SCM recovery = KeepAlive analog.
    expect(ps).toContain('sc.exe failure');
  });

  test('uninstaller: stops/deletes both services, documents session-dynamic fail-open', () => {
    const ps = readFileSync(UNINSTALL, 'utf8');
    expect(ps).toContain('BlockingmachineHelper');
    expect(ps).toContain('BlockingmachineProxy');
    expect(ps).toContain('sc.exe stop');
    expect(ps).toContain('sc.exe delete');
    expect(ps).toMatch(/session-dynamic|evaporat/i);
  });

  test('rehearsal: admin-gated, NEVER auto-run, install→curl→403→uninstall→verdicts', () => {
    const ps = readFileSync(REHEARSE, 'utf8');
    expect(ps).toMatch(/NEVER AUTO-RUN/);
    expect(ps).toContain('Administrator');
    expect(ps).toContain('install-windows-capture.ps1');
    expect(ps).toContain('uninstall-windows-capture.ps1');
    expect(ps).toContain('curl.exe');
    expect(ps).toContain('403');
    expect(ps).toContain('--cacert');
  });
});

describePwsh('powershell parse check (pwsh/powershell available)', () => {
  const files = [BUILD_PS, INSTALL, UNINSTALL, REHEARSE];
  for (const f of files) {
    test(`${f.split('/').pop()} parses without errors`, () => {
      const out = execFileSync(
        pwsh as string,
        [
          '-NoProfile',
          '-Command',
          `$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw '${f}'), [ref]$null); ` +
            `$errs = $null; ` +
            `[System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$errs) | Out-Null; ` +
            'if ($errs) { $errs | ForEach-Object { Write-Error $_.Message }; exit 1 }',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(out).not.toContain('ParserError');
    });
  }
});

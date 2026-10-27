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
    // P3 review: the redirect HANDLE pair lives in fwpsu.h as the
    // versioned Fwps*0 API returning DWORD/ERROR_SUCCESS — the
    // FwpmRedirectHandle* spellings do not exist.
    expect(src).toContain('#include <fwpsu.h>');
    expect(src).toContain('FwpsRedirectHandleCreate0');
    expect(src).toContain('FwpsRedirectHandleDestroy0');
    // No stale FwpmRedirectHandle* spellings or NTSTATUS-typed results
    // (the names are allowed in comments — they document the fix).
    expect(src).not.toMatch(/FwpmRedirectHandleCreate|FwpmRedirectHandleDestroy/);
    expect(src).not.toMatch(/NTSTATUS\s+\w+\s*=|\bstatus\s*=\s*0x/);
  });

  test('port condition: IP_REMOTE_PORT + pinned htons network order', () => {
    // There is no FWPM_CONDITION_TCP_REMOTE_PORT — the IP layer's port
    // field is what the redirect layers evaluate.
    expect(src).toContain('FWPM_CONDITION_IP_REMOTE_PORT');
    expect(src).not.toContain('FWPM_CONDITION_TCP_REMOTE_PORT');
    // htons() pinned with the alternative (host-order) reading recorded
    // in the UNVALIDATED banner — never flip it silently.
    expect(src).toContain('htons(port)');
  });

  test('exclusions fail closed + derive fixed per-slot keys', () => {
    // A redirect with no engine exemption is a self-capture loop — an
    // exclusion failure must tear the whole configure down, and the
    // fixed keys make restarts update in place (no duplicate PERMITs).
    expect(src).toContain('bm_excl_filter_key');
    expect(src).toContain('FwpmFilterDeleteByKey0');
    expect(src).toMatch(/self-capture loop/);
    expect(src).toContain('FwpmGetAppIdFromFileName0');
  });

  test('engine-supervisor mode — helper IS the BlockingmachineProxy SCM host', () => {
    // Raw node.exe cannot serve the SCM (error 1053) — the proxy service
    // binPath is this binary supervising `node.exe <bundle>` under a
    // kill-on-close Job Object with bounded restart backoff.
    expect(src).toContain('--engine-supervisor');
    expect(src).toContain('BlockingmachineProxy');
    expect(src).toContain('CreateJobObjectW');
    expect(src).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(src).toContain('AssignProcessToJobObject');
    expect(src).toContain('CreateProcessW');
    expect(src).toContain('engine_supervise');
    expect(src).toContain('svc_main_proxy');
  });

  test('accepted sockets are normalized to blocking after accept', () => {
    // Winsock inherits the listener's O_NONBLOCK — the shared contract
    // is "blocking from here"; splice.h pins it.
    expect(src).toMatch(/bm_set_nonblocking\(cfd, 0\)/);
  });

  test('redirect context asserts the pinned buffer contract', () => {
    expect(src).toContain('ctx_len != sizeof(*out)');
    expect(src).toContain('SIO_QUERY_WFP_CONNECTION_REDIRECT_RECORDS');
    expect(src).toContain('SIO_QUERY_WFP_CONNECTION_REDIRECT_CONTEXT');
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
    // No-compiler posture: vswhere → VsDevCmd env import (INCLUDE/LIB
    // are the load-bearing part), else a soft-skip exit 0 — npm run
    // build must not hard-fail on a machine without MSVC.
    expect(ps).toContain('vswhere.exe');
    expect(ps).toContain('VsDevCmd.bat');
    expect(ps).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
    expect(ps).toMatch(/soft-skip/);
    expect(ps).not.toMatch(/no C compiler on PATH/);
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
    // BOTH services binPath the helper binary — raw node.exe would die
    // on SCM error 1053. The proxy service is the helper's
    // --engine-supervisor mode wrapping `node.exe <bundle>`.
    expect(ps).toContain('--engine-supervisor');
    expect(ps).toMatch(/\$proxyBin\s*=\s*"\\`"\$\(\$script:HelperDst\)\\`" --engine-supervisor/);
    expect(ps).not.toMatch(/\$proxyBin\s*=\s*"\\`"\$NodeExe\\`"/);
    // Named port params — getCaptureInstallCommand passes the manager's
    // configured ports through when they diverge from the defaults.
    expect(ps).toMatch(/\[int\] \$HelperPort\s*=\s*9295/);
    expect(ps).toMatch(/\[int\] \$EnginePort\s*=\s*9294/);
    expect(ps).toMatch(/\[int\] \$ControlPort\s*=\s*9293/);
    // SCM recovery = KeepAlive analog — pinned reset/actions shape.
    expect(ps).toContain('sc.exe failure');
    expect(ps).toContain('reset= 60');
    expect(ps).toContain('restart/2000/restart/5000/restart/10000');
    expect(ps).not.toContain('reset= 86400');
  });

  test('uninstaller: stops/deletes both services, documents session-dynamic fail-open', () => {
    const ps = readFileSync(UNINSTALL, 'utf8');
    expect(ps).toContain('BlockingmachineHelper');
    expect(ps).toContain('BlockingmachineProxy');
    expect(ps).toContain('sc.exe stop');
    expect(ps).toContain('sc.exe delete');
    expect(ps).toMatch(/session-dynamic|evaporat/i);
  });

  test('rehearsal: admin-gated, NEVER auto-run, two verdict shapes for the two legs', () => {
    const ps = readFileSync(REHEARSE, 'utf8');
    expect(ps).toMatch(/NEVER AUTO-RUN/);
    expect(ps).toContain('Administrator');
    expect(ps).toContain('install-windows-capture.ps1');
    expect(ps).toContain('uninstall-windows-capture.ps1');
    expect(ps).toContain('curl.exe');
    expect(ps).toContain('--cacert');
    // :80 → a real HTTP 403 response is still asserted …
    expect(ps).toContain('transparent-block-http');
    expect(ps).toContain('403');
    expect(ps).toMatch(/:80:/);
    // … but :443 is a socket DESTROY — raw TLS has no response channel.
    // The verdict is curl refusing plus the engine's own flowsBlocked
    // delta on /v1/proxy/status, never a bare-403 expectation.
    expect(ps).toContain('transparent-block-https');
    expect(ps).toContain('flowsBlocked');
    expect(ps).toContain('/v1/proxy/status');
    expect(ps).toContain('stats.flowsBlocked');
    expect(ps).not.toMatch(/\$blockCode -eq '403'/);
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

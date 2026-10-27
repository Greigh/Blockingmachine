/**
 * Platform gate for the Windows half of the `prebuild` npm hook — the
 * mirror of build-if-darwin.mjs. helper/windows/build.ps1 is a Windows
 * target (cl/clang-cl + fwpuclnt/ws2_32 link), so this shim only forks
 * powershell on win32; everywhere else the Windows helper is source-only
 * and the gate is a no-op by construction.
 *
 * The WFP legs in redirect-helper.c are marked BM_WFP_PATH_STATUS
 * UNVALIDATED — building here proves syntax/SDK presence on the runner,
 * not runtime redirect correctness (see the file's header block).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform === 'win32') {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'windows', 'build.ps1');
  const shell = process.env.WINDIR ? 'powershell.exe' : 'pwsh';
  execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' });
}

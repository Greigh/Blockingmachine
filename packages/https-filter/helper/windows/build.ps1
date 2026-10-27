# build.ps1 — compile the Windows capture helper (P3 Task 1).
#
#   redirect-helper.exe = redirect-helper.c + ../common/splice.c
#   cl /W4 /WX /O2 … /link fwpuclnt.lib ws2_32.lib, clang-cl fallback.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#
# Compiler resolution, in order:
#   1. cl.exe already on PATH (Developer/Native-Tools shell, vcvars run).
#   2. clang-cl.exe on PATH (LLVM bundle) — same driver flags.
#   3. vswhere → newest VS install carrying the VC toolset → import the
#      developer environment via VsDevCmd.bat (cl needs INCLUDE/LIB
#      populated, not merely PATH — the env import is the load-bearing
#      part; a bare cl.exe path would still fail on missing headers).
#   4. Nothing found → WARN + exit 0. Tolerate-absence posture, matching
#      the darwin/linux helper gates: a contributor's `npm run build`
#      must not hard-fail on a machine without MSVC — the helper stays
#      source-only until a real toolchain compiles it, and the WFP leg
#      is BM_WFP_PATH_STATUS UNVALIDATED regardless (flag wfp-unvalidated).
#
# Env: BM_BUILD_VERBOSE=1 prints the exact command line. Exit codes:
#   0 built-or-soft-skipped · anything else = compiler's own.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'redirect-helper.c'
$core = Join-Path $here '..\common\splice.c'
$out  = Join-Path $here 'redirect-helper.exe'

function Import-VsDevEnv {
  # Locate the newest VS with the C++ toolset. vswhere lives at a fixed
  # installer path on every VS2017+ box; -find 'VC\Tools\MSVC' proves the
  # compiler payload itself is present (not just the shell).
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $false }
  $vsArgs = @('-latest', '-products', '*',
              '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
  $vcTools = & $vswhere @vsArgs -find 'VC\Tools\MSVC' 2>$null | Select-Object -First 1
  if (-not $vcTools) { return $false }
  $vsRoot = & $vswhere @vsArgs -property installationPath 2>$null
  if (-not $vsRoot) { return $false }
  $vsDevCmd = Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) { return $false }
  # VsDevCmd mutates the ambient cmd environment — capture the whole
  # post-import `set` and re-apply it here (PATH/INCLUDE/LIB/LIBPATH…).
  $envLines = & cmd.exe /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul 2>&1 && set"
  foreach ($line in $envLines) {
    $eq = $line.IndexOf('=')
    if ($eq -gt 0) {
      [Environment]::SetEnvironmentVariable($line.Substring(0, $eq), $line.Substring($eq + 1), 'Process')
    }
  }
  return [bool](Get-Command 'cl.exe' -ErrorAction SilentlyContinue)
}

$cc = $null
if (Get-Command 'cl.exe' -ErrorAction SilentlyContinue) {
  $cc = 'cl'
} elseif (Get-Command 'clang-cl.exe' -ErrorAction SilentlyContinue) {
  $cc = 'clang-cl'
} elseif (Import-VsDevEnv) {
  $cc = 'cl'
} else {
  Write-Host 'build.ps1: no MSVC toolchain found (no cl.exe, no clang-cl.exe, vswhere found no VC toolset) — soft-skip: the helper stays source-only on this machine. Run from a Developer PowerShell or install the VS C++ workload to build.'
  exit 0
}

# cl and clang-cl take the same driver flags; /link passthrough is
# identical for both. fwpuclnt.lib carries BOTH halves the helper uses —
# the Fwpm* engine/filter API (fwpmu.h) and the user-mode redirect-handle
# pair FwpsRedirectHandleCreate0/Destroy0 (fwpsu.h). rpcrt4 for the
# FwpmEngineOpen0 RPC binding.
$args = @('/W4', '/WX', '/O2', '/nologo',
          "/Fe:$out", $src, $core,
          '/link', 'fwpuclnt.lib', 'ws2_32.lib', 'rpcrt4.lib')

if ($env:BM_BUILD_VERBOSE) {
  Write-Host "$cc $($args -join ' ')"
}
& $cc @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "built $out"

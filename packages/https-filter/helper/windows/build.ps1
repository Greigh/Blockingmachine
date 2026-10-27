# build.ps1 — compile the Windows capture helper (P3 Task 1).
#
#   redirect-helper.exe = redirect-helper.c + ../common/splice.c
#   cl /W4 /WX /O2 … /link fwpuclnt.lib ws2_32.lib, clang-cl fallback.
#
# Run from an MSVC environment where `cl` is on PATH (Developer PowerShell,
# x64 Native Tools prompt, or a shell that has already run vcvars*). The
# script locates clang-cl via the LLVM bundle `clang-cl.exe` when `cl` is
# absent; both produce the same binary.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#
# Env: BM_BUILD_VERBOSE=1 prints the exact command line. Exit codes:
#   0 built · 1 no compiler found · anything else = compiler's own.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'redirect-helper.c'
$core = Join-Path $here '..\common\splice.c'
$out  = Join-Path $here 'redirect-helper.exe'

$cl      = Get-Command 'cl.exe'       -ErrorAction SilentlyContinue
$clangcl = Get-Command 'clang-cl.exe' -ErrorAction SilentlyContinue

if ($cl) {
  $cc = 'cl'
} elseif ($clangcl) {
  $cc = 'clang-cl'
} else {
  Write-Error 'no C compiler on PATH — need cl.exe (MSVC) or clang-cl.exe (LLVM). Run from a Developer/Native-Tools PowerShell.'
  exit 1
}

# cl and clang-cl take the same driver flags; /link passthrough is
# identical for both. rpcrt4 for the FwpmEngineOpen0 RPC binding.
$args = @('/W4', '/WX', '/O2', '/nologo',
          "/Fe:$out", $src, $core,
          '/link', 'fwpuclnt.lib', 'ws2_32.lib', 'rpcrt4.lib')

if ($env:BM_BUILD_VERBOSE) {
  Write-Host "$cc $($args -join ' ')"
}
& $cc @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "built $out"

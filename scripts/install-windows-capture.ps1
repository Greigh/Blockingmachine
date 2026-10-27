<#
.SYNOPSIS
  install-windows-capture.ps1 — install the Blockingmachine transparent
  HTTPS capture services on Windows (P3 Task 1).

.DESCRIPTION
  MUST BE RUN FROM AN ELEVATED POWERSHELL — registers two services and
  the helper's WFP filters need admin anyway. No self-escalation inside.

    powershell -NoProfile -ExecutionPolicy Bypass -File `
      scripts\install-windows-capture.ps1 <bundlePath> <nodeExe> [rulesPath]

  Sequence (mirrors install-macos-capture.sh's posture, SCM edition):
    1. admin check — before anything is probed or touched
    2. port preflight — refuse when anything already listens on
       127.0.0.1:9293/:9294/:9295 (an engine squatting the capture ports
       means the services would fail to own them while WFP redirect is
       armed — same P1-review lesson as the macOS installer)
    3. redirect-helper.exe + logs/store dirs under ProgramData /
       Program Files
    4. BlockingmachineProxy service: binPath "<node.exe>" "<bundle>",
       Environment multistring (BM_STORE_DIR/BM_DATA_PORT/BM_CONTROL_PORT/
       BM_KEYWRAP=off/BM_RULES_PATH/ELECTRON_RUN_AS_NODE) on
       HKLM\SYSTEM\CurrentControlSet\Services\BlockingmachineProxy,
       failure actions = restart (the KeepAlive analog)
    5. BlockingmachineHelper service: binPath "<helper.exe>" 9295 9294
       --exclude-app "<node.exe>" (the engine's own dials must never be
       re-captured; the helper auto-exempts itself too)
    6. start order proxy → helper (a redirect must never meet a dead
       engine — helper's own WFP arm is the last thing that happens)
    7. health-verify: poll http://127.0.0.1:9293/v1/proxy/status up to
       30 s — registration proves nothing about a crash-looping engine

  Fail-open contract (documented, not a flag): the WFP redirect filters
  are SESSION-DYNAMIC objects — they evaporate the instant the helper
  process exits (crash, stop, reboot). Helper death ⇒ zero redirection ⇒
  direct network. Engine death ⇒ the helper's watchdog closes the WFP
  session itself and exits nonzero for SCM restart.

  Options:
    --preflight-only   run only the port preflight and exit — the
                       captureScripts-style suite drives it by squatting
                       a port; needs no admin, no mutations
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $BundlePath,
  [Parameter(Position = 1)] [string] $NodeExe,
  [Parameter(Position = 2)] [string] $RulesPath,
  [switch] $PreflightOnly
)

$ErrorActionPreference = 'Stop'

$script:HelperPort  = 9295
$script:EnginePort  = 9294
$script:ControlPort = 9293

$script:SvcProxy  = 'BlockingmachineProxy'
$script:SvcHelper = 'BlockingmachineHelper'

$script:ProgramDir = Join-Path $env:ProgramFiles 'Blockingmachine'
$script:HelperDst  = Join-Path $script:ProgramDir 'redirect-helper.exe'
$script:HelperSrc  = Join-Path $PSScriptRoot '..\packages\https-filter\helper\windows\redirect-helper.exe'
$script:StoreDir   = 'C:\ProgramData\Blockingmachine\https-filter'
$script:LogDir     = 'C:\ProgramData\Blockingmachine\logs'

function Write-Log([string] $msg) {
  Write-Host "[install-windows-capture] $msg"
}

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'must run elevated — service registration and WFP filters need admin (re-run from an Administrator PowerShell)'
  }
}

# One engine, ever — a listener already on the control/data/helper ports
# is an engine (user-context, stale service, foreign) that would own the
# ports the services then fail to take, leaving WFP redirect aimed at a
# dead listener. The squatter is named in the error so the operator can
# stop it. TcpListener bind is the portability floor; Get-NetTCPConnection
# names the owning process when the cmdlet exists.
function Test-PortPreflight {
  foreach ($port in @($script:ControlPort, $script:EnginePort, $script:HelperPort)) {
    $owner = ''
    try {
      $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
      if ($conns) {
        $pid0 = ($conns | Select-Object -First 1).OwningProcess
        $proc = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
        $owner = " (pid $pid0"
        if ($proc) { $owner += " $($proc.ProcessName)" }
        $owner += ')'
      }
    } catch { $conns = $null }
    if (-not $conns) {
      $listener = $null
      try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
      } catch {
        throw "an engine already listens on :$port$owner — stop it before installing capture"
      } finally {
        if ($listener) { $listener.Stop() }
      }
    } else {
      throw "an engine already listens on :$port$owner — stop it before installing capture"
    }
  }
}

function Set-ServiceEnvironment([string] $svc, [string[]] $envLines) {
  # SCM service environment lives as a REG_MULTI_SZ under the service key —
  # the pinned mechanism (alternative: an --env-file the bundle reads).
  $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$svc"
  New-ItemProperty -Path $key -Name 'Environment' -PropertyType MultiString -Value $envLines -Force | Out-Null
}

if ($PreflightOnly) {
  Test-PortPreflight
  Write-Log "port preflight clean — nothing listens on :$($script:ControlPort)/:$($script:EnginePort)/:$($script:HelperPort)"
  exit 0
}

Assert-Admin
Test-PortPreflight

if (-not $BundlePath -or -not $NodeExe) {
  Write-Error 'usage: install-windows-capture.ps1 <bundlePath> <nodeExe> [rulesPath] [--preflight-only]'
  exit 2
}
if (-not (Test-Path $BundlePath)) { throw "bundle not found: $BundlePath" }
if (-not (Test-Path $NodeExe))    { throw "node runner not found: $NodeExe" }
if (-not (Test-Path $script:HelperSrc)) { throw "helper not built: $($script:HelperSrc) — run helper\windows\build.ps1 first" }

if (-not $RulesPath) {
  $RulesPath = Join-Path $env:USERPROFILE 'Documents\Blockingmachine\browser.txt'
  Write-Log "rulesPath not given — defaulting to $RulesPath"
}
if (-not (Test-Path $RulesPath)) {
  Write-Log "warning: $RulesPath does not exist — capture starts with 0 rules until a compile lands + reload"
}

# --- directories + binary ---
New-Item -ItemType Directory -Force -Path $script:ProgramDir | Out-Null
New-Item -ItemType Directory -Force -Path $script:StoreDir  | Out-Null
New-Item -ItemType Directory -Force -Path $script:LogDir    | Out-Null
Copy-Item -Force $script:HelperSrc $script:HelperDst
Write-Log "installed $($script:HelperDst)"

# --- services (idempotent: stop+delete any previous registration) ---
foreach ($svc in @($script:SvcProxy, $script:SvcHelper)) {
  if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
    & sc.exe stop $svc | Out-Null
    & sc.exe delete $svc | Out-Null
    Start-Sleep -Milliseconds 500
  }
}

# sc.exe wants its own quoting: binPath= "<exe>" <args> — the outer quotes
# group the whole value, inner \" quoting survives spaces in paths.
$proxyBin  = "\`"$NodeExe\`" \`"$BundlePath\`""
$helperBin = "\`"$($script:HelperDst)\`" $($script:HelperPort) $($script:EnginePort) --exclude-app \`"$NodeExe\`""

& sc.exe create $script:SvcProxy "binPath= $proxyBin" 'start= auto' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe create $($script:SvcProxy) failed ($LASTEXITCODE)" }
& sc.exe create $script:SvcHelper "binPath= $helperBin" 'start= auto' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe create $($script:SvcHelper) failed ($LASTEXITCODE)" }

# SCM recovery — the KeepAlive analog: restart on every failure, 5 s then
# 10 s then 30 s, counter resets after a clean day.
& sc.exe failure $script:SvcProxy  'reset= 86400' 'actions= restart/5000/restart/10000/restart/30000' | Out-Null
& sc.exe failure $script:SvcHelper 'reset= 86400' 'actions= restart/5000/restart/10000/restart/30000' | Out-Null

# Engine env — the macOS plist's EnvironmentVariables, registry edition.
# BM_KEYWRAP=off: LocalSystem has no login DPAPI context for the key-wrap
# auto-resolve path — pin it off so the posture is deterministic, not
# discovered (same reasoning as _blockingmachine on macOS).
$envLines = @(
  "BM_STORE_DIR=$($script:StoreDir)",
  "BM_DATA_PORT=$($script:EnginePort)",
  "BM_CONTROL_PORT=$($script:ControlPort)",
  'BM_KEYWRAP=off',
  'ELECTRON_RUN_AS_NODE=1'
)
if ($RulesPath) { $envLines += "BM_RULES_PATH=$RulesPath" }
Set-ServiceEnvironment $script:SvcProxy $envLines
Write-Log "registered $($script:SvcProxy) + $($script:SvcHelper) (auto-start, restart-on-fail)"

# --- start order: engine before the redirect that feeds it ---
& sc.exe start $script:SvcProxy | Out-Null
Start-Sleep -Seconds 2
& sc.exe start $script:SvcHelper | Out-Null

# --- verify: registration ≠ health (a crash-looping engine queries fine) —
# poll the engine's own control answer like the macOS installer does.
$engineUp = $false
foreach ($i in 1..30) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:ControlPort)/v1/proxy/status" -TimeoutSec 2
    $engineUp = $true
    break
  } catch { Start-Sleep -Seconds 1 }
}
if (-not $engineUp) {
  throw "$($script:SvcProxy) never answered /v1/proxy/status on :$($script:ControlPort) — services are registered but the engine is not healthy"
}

Write-Log "capture installed: tcp:{80,443} → 127.0.0.1:$($script:HelperPort) (helper) → 127.0.0.1:$($script:EnginePort) (engine)"
Write-Log 'NOTE: WFP redirect path is BM_WFP_PATH_STATUS UNVALIDATED until exercised on this Windows build — see helper\windows\redirect-helper.c'
Write-Log "verify: curl.exe --cacert <ca.pem from http://127.0.0.1:$($script:ControlPort)/v1/proxy/ca> https://example.com/"
Write-Log 'remove: scripts\uninstall-windows-capture.ps1 (elevated)'

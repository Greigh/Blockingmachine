<#
.SYNOPSIS
  install-windows-capture.ps1 — install the Blockingmachine transparent
  HTTPS capture services on Windows (P3 Task 1).

.DESCRIPTION
  MUST BE RUN FROM AN ELEVATED POWERSHELL — registers two services and
  the helper's WFP filters need admin anyway. No self-escalation inside.

    powershell -NoProfile -ExecutionPolicy Bypass -File `
      scripts\install-windows-capture.ps1 <bundlePath> <nodeExe> [rulesPath]
      [-HelperPort <p>] [-EnginePort <p>] [-ControlPort <p>]

  Sequence (mirrors install-macos-capture.sh's posture, SCM edition):
    1. admin check — before anything is probed or touched
    2. port preflight — refuse when anything already listens on
       127.0.0.1:<control>/<engine>/<helper> (an engine squatting the
       capture ports means the services would fail to own them while
       WFP redirect is armed — same P1-review lesson as the macOS
       installer)
    3. redirect-helper.exe + logs/store dirs under ProgramData /
       Program Files
    4. BlockingmachineProxy service: binPath "<helper.exe>"
       --engine-supervisor "<node.exe>" "<bundle>" --log "<engine.log>"
       — a raw node.exe can never answer the SCM dispatcher (it would
       die on error 1053 inside ~30 s), so the HELPER binary hosts the
       service and supervises the engine as a kill-on-close Job-Object
       child. Environment multistring (BM_STORE_DIR/BM_DATA_PORT/
       BM_CONTROL_PORT/BM_KEYWRAP=off/BM_RULES_PATH/ELECTRON_RUN_AS_NODE)
       lands on HKLM\SYSTEM\CurrentControlSet\Services\BlockingmachineProxy
       and is inherited by the supervised child; failure actions =
       restart (the KeepAlive analog)
    5. BlockingmachineHelper service: binPath "<helper.exe>" <helperPort>
       <enginePort> --exclude-app "<node.exe>" (the engine's own dials
       must never be re-captured; the helper auto-exempts itself too)
    6. start order proxy → helper (a redirect must never meet a dead
       engine — helper's own WFP arm is the last thing that happens)
    7. health-verify: poll http://127.0.0.1:<control>/v1/proxy/status up
       to 30 s — registration proves nothing about a crash-looping
       engine

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
  [int] $HelperPort = 9295,
  [int] $EnginePort = 9294,
  [int] $ControlPort = 9293,
  [switch] $PreflightOnly
)

$ErrorActionPreference = 'Stop'

# The named port params land in script scope — $script:* reads below see
# the caller's overrides (getCaptureInstallCommand passes the manager's
# configured ports when they differ from these defaults).

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
if (-not (Test-Path $script:HelperDst)) { throw "helper copy failed: $($script:HelperDst) missing after Copy-Item" }
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
# BOTH services resolve to the helper binary — a raw node.exe binPath
# dies on SCM error 1053 (no StartServiceCtrlDispatcher). The proxy
# service runs the helper's --engine-supervisor mode: it spawns
# "<node.exe>" "<bundle>" as a Job-Object kill-on-close child, folds the
# engine's stderr into the helper-owned log file, and restarts it under
# bounded backoff.
$proxyBin  = "\`"$($script:HelperDst)\`" --engine-supervisor \`"$NodeExe\`" \`"$BundlePath\`" --log \`"$($script:LogDir)\engine.log\`""
$helperBin = "\`"$($script:HelperDst)\`" $($script:HelperPort) $($script:EnginePort) --exclude-app \`"$NodeExe\`""

& sc.exe create $script:SvcProxy "binPath= $proxyBin" 'start= auto' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe create $($script:SvcProxy) failed ($LASTEXITCODE)" }
& sc.exe create $script:SvcHelper "binPath= $helperBin" 'start= auto' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe create $($script:SvcHelper) failed ($LASTEXITCODE)" }

# SCM recovery — the launchd KeepAlive / systemd Restart=always analog:
# restart on every failure, 2 s then 5 s then 10 s, counter resets after
# a clean minute. The supervised-engine spawn-refusal cap exits nonzero
# and lands here; the helper's watchdog exits 3 the same way.
foreach ($svc in @($script:SvcProxy, $script:SvcHelper)) {
  & sc.exe failure $svc 'reset= 60' 'actions= restart/2000/restart/5000/restart/10000' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe failure $svc failed ($LASTEXITCODE)" }
}

# Engine env — the macOS plist's EnvironmentVariables, registry edition.
# SCM applies the multistring to the SERVICE process — which is now the
# helper's --engine-supervisor instance; the supervised node.exe child
# inherits it wholesale (CreateProcess lpEnvironment NULL), so the BM_*
# list lives in exactly one place. BM_KEYWRAP=off: LocalSystem has no
# login DPAPI context for the key-wrap auto-resolve path — pin it off so
# the posture is deterministic, not discovered (same reasoning as
# _blockingmachine on macOS).
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

<#
.SYNOPSIS
  windows-capture-rehearse.ps1 — end-to-end LIVE rehearsal of the Windows
  transparent HTTPS capture leg (P3 Task 1).

  *** NEVER AUTO-RUN — operator-driven, elevated, mutates real system ***
  *** state (two SCM services + session WFP filters). Same posture as  ***
  *** macos-capture-rehearse.sh: no self-escalation, EXIT trap undoes  ***
  *** the install on every exit path.                                ***

.DESCRIPTION
    powershell -NoProfile -ExecutionPolicy Bypass -File `
      scripts\windows-capture-rehearse.ps1 <bundlePath> <nodeExe> [rulesPath]

  Rehearsed sequence (first failure stops):
    1. install-windows-capture.ps1 (services + WFP filters live)
    2. engine control answers http://127.0.0.1:9293/v1/proxy/status
    3. fetch engine CA from /v1/proxy/ca into a temp file
    4. transparent allow proof: curl.exe --cacert <ca> https://example.com
       succeeds ONLY via the minted leaf (proves the flow crossed
       redirect → helper → engine MITM, not the real wire)
    5. transparent block proof: curl.exe to a rehearsal-blocked host
       pinned via --resolve to a reachable IP is refused, expecting the
       engine's 403 posture — the refusal is provably the verdict
    6. uninstall-windows-capture.ps1 → PASS

  Env knobs: REHEARSE_ALLOWED_URL (default https://example.com/),
    REHEARSE_WAIT_ENGINE_S (60), REHEARSE_CURL_MAX_S (15).

  NOTE: this is the leg that turns BM_WFP_PATH_STATUS from UNVALIDATED to
  proven — its first real run's output belongs in docs/open-flags.md.
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]  [string] $BundlePath,
  [Parameter(Position = 1, Mandatory = $true)]  [string] $NodeExe,
  [Parameter(Position = 2)]                     [string] $RulesPath
)

$ErrorActionPreference = 'Stop'

$script:ControlPort = 9293
$script:Installed   = $false
$script:Results     = @()

function Write-Log([string] $msg) { Write-Host "[windows-capture-rehearse] $msg" }
function Add-Verdict([string] $name, [bool] $ok, [string] $detail) {
  $script:Results += [pscustomobject]@{ Step = $name; Ok = $ok; Detail = $detail }
  Write-Log ("{0}: {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail)
}

# Admin gate — same as installer's (this run is the install's live twin).
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p  = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'must run elevated — NEVER auto-run; re-run from an Administrator PowerShell'
  exit 2
}

$allowedUrl = if ($env:REHEARSE_ALLOWED_URL) { $env:REHEARSE_ALLOWED_URL } else { 'https://example.com/' }
$waitEngine = if ($env:REHEARSE_WAIT_ENGINE_S) { [int]$env:REHEARSE_WAIT_ENGINE_S } else { 60 }
$curlMax    = if ($env:REHEARSE_CURL_MAX_S)    { [int]$env:REHEARSE_CURL_MAX_S }    else { 15 }

$installPs   = Join-Path $PSScriptRoot 'install-windows-capture.ps1'
$uninstallPs = Join-Path $PSScriptRoot 'uninstall-windows-capture.ps1'
$caFile      = Join-Path $env:TEMP 'blockingmachine-rehearse-ca.pem'

# Cleanup contract: the `finally` block below uninstalls whenever
# $script:Installed is set — covers failure AND Ctrl+C (StopProcessing
# still runs finally). A hard process kill can't run any trap — that's
# what the session-dynamic WFP filters are for (they die with the
# helper regardless).

try {
  # 1. install
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installPs, $BundlePath, $NodeExe)
  if ($RulesPath) { $args += $RulesPath }
  & powershell @args
  if ($LASTEXITCODE -ne 0) { throw "installer exited $LASTEXITCODE" }
  $script:Installed = $true
  Add-Verdict 'install' $true 'services registered + started'

  # 2. engine control API
  $engineUp = $false
  foreach ($i in 1..$waitEngine) {
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:ControlPort)/v1/proxy/status" -TimeoutSec 2
      $engineUp = $true; break
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $engineUp) { throw "engine never answered /v1/proxy/status within ${waitEngine}s" }
  Add-Verdict 'engine-up' $true "/v1/proxy/status answered on :$($script:ControlPort)"

  # 3. fetch engine CA
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:ControlPort)/v1/proxy/ca" -OutFile $caFile -TimeoutSec 10
  if (-not (Test-Path $caFile)) { throw 'CA fetch failed' }
  Add-Verdict 'ca-fetch' $true $caFile

  # 4. transparent allow — only a minted leaf can satisfy --cacert, so a
  #    200 here proves the redirect→helper→engine path carried the flow.
  & curl.exe -sS --cacert $caFile --max-time $curlMax -o NUL -w '%{http_code}' $allowedUrl | Out-Null
  $allowCode = & curl.exe -sS --cacert $caFile --max-time $curlMax -o NUL -w '%{http_code}' $allowedUrl
  Add-Verdict 'transparent-allow' ($allowCode -match '^\d+$' -and [int]$allowCode -lt 400) "curl https status=$allowCode"

  # 5. transparent block — pinned via --resolve to a reachable IP so a
  #    dead-DNS pass can't fake a block; the engine answers 403.
  & curl.exe -sS --cacert $caFile --max-time $curlMax --resolve 'rehearse-block.example:443:93.184.216.34' -o NUL -w '%{http_code}' 'https://rehearse-block.example/' | Out-Null
  $blockCode = & curl.exe -sS --cacert $caFile --max-time $curlMax --resolve 'rehearse-block.example:443:93.184.216.34' -o NUL -w '%{http_code}' 'https://rehearse-block.example/'
  Add-Verdict 'transparent-block' ($blockCode -eq '403') "curl blocked status=$blockCode (expect 403)"

  # 6. uninstall
  & powershell -NoProfile -ExecutionPolicy Bypass -File $uninstallPs
  if ($LASTEXITCODE -ne 0) { throw "uninstaller exited $LASTEXITCODE" }
  $script:Installed = $false
  Add-Verdict 'uninstall' $true 'services deleted; WFP filters evaporated'
} catch {
  Add-Verdict 'run' $false $_.Exception.Message
} finally {
  if ($script:Installed) {
    Write-Log 'cleanup: uninstalling on exit path'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $uninstallPs | Out-Null
    $script:Installed = $false
  }
}

$failed = @($script:Results | Where-Object { -not $_.Ok })
Write-Log '================ verdicts ================'
foreach ($r in $script:Results) {
  Write-Log ("  {0}  {1}  {2}" -f $(if ($r.Ok) { 'PASS' } else { 'FAIL' }), $r.Step, $r.Detail)
}
if ($failed.Count -eq 0) {
  Write-Log 'rehearse: PASS'
  exit 0
}
Write-Log "rehearse: FAIL ($($failed.Count) step(s))"
exit 1

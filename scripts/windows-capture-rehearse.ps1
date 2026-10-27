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
    5. transparent block proofs — the two verdict shapes, mirroring
       linux-capture-rehearse.sh: http:// :80 gets a REAL 403 response
       (plain-HTTP block answers); https:// :443 is a socket DESTROY —
       raw TLS has no response channel, so curl fails/exits nonzero and
       the proof is the engine's own flowsBlocked delta on
       /v1/proxy/status (a dead pin can't pass vacuously)
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
  #    2xx here proves the redirect→helper→engine path carried the flow.
  $allowCode = & curl.exe -sS --cacert $caFile --max-time $curlMax -o NUL -w '%{http_code}' $allowedUrl
  Add-Verdict 'transparent-allow' ($allowCode -match '^\d+$' -and [int]$allowCode -lt 400) "curl https status=$allowCode"

  # 5. transparent block — two verdict shapes (mirrors
  #    linux-capture-rehearse.sh). Pinned via --resolve to a reachable IP
  #    so a dead-DNS pass can't fake a block.
  #    :80 → the plain-HTTP block answers a REAL 403 response.
  #    :443 → a socket DESTROY: raw TLS has no response channel — the
  #    close IS the verdict, so the assertion is curl refusing (nonzero
  #    exit / 000) AND the engine's own flowsBlocked delta ticking up.
  $blockedHost = 'rehearse-block.example'
  $blockedIp   = '93.184.216.34'
  $httpCode = & curl.exe -sS --max-time $curlMax --resolve "${blockedHost}:80:${blockedIp}" -o NUL -w '%{http_code}' "http://$blockedHost/"
  Add-Verdict 'transparent-block-http' ($httpCode -eq '403') "curl http status=$httpCode (expect 403)"

  $status0 = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:ControlPort)/v1/proxy/status" -TimeoutSec 5 | ConvertFrom-Json
  $blockedBefore = [int]$status0.stats.flowsBlocked
  $blockCode = & curl.exe -sS --cacert $caFile --max-time $curlMax --resolve "${blockedHost}:443:${blockedIp}" -o NUL -w '%{http_code}' "https://$blockedHost/"
  $curlExit = $LASTEXITCODE
  $status1 = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:ControlPort)/v1/proxy/status" -TimeoutSec 5 | ConvertFrom-Json
  $blockedAfter = [int]$status1.stats.flowsBlocked
  $httpsRefused = ($curlExit -ne 0) -or ($blockCode -eq '000') -or ($blockCode -notmatch '^\d+$')
  Add-Verdict 'transparent-block-https' ($httpsRefused -and $blockedAfter -gt $blockedBefore) "curl https status=$blockCode exit=$curlExit; flowsBlocked $blockedBefore->$blockedAfter"

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

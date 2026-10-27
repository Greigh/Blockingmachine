<#
.SYNOPSIS
  uninstall-windows-capture.ps1 — remove the Blockingmachine transparent
  HTTPS capture services (P3 Task 1). Elevated.

.DESCRIPTION
  Stops and deletes BlockingmachineHelper + BlockingmachineProxy and the
  installed helper binary. BOTH services resolve to the same
  redirect-helper.exe — the helper in redirect mode and the helper in
  --engine-supervisor mode wrapping `node.exe <bundle>` (stopping the
  proxy service kills the supervised engine via its Job Object — the
  kill-on-close contract). The WFP redirect filters need NO explicit
  removal: they are session-dynamic objects owned by the helper's WFP
  engine handle — stopping the helper evaporates them atomically
  (fail-open by construction; there is no ruleset to flush and nothing
  left pointing at a dead listener — the precise inverse of the pf-anchor
  cleanup uninstall-macos-capture.sh must do by hand).

  The engine's CA in the user trust store is deliberately untouched —
  same posture as the macOS uninstaller (CA lifecycle belongs to the
  app surface, not capture teardown).
#>

#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-Log([string] $msg) {
  Write-Host "[uninstall-windows-capture] $msg"
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p  = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'must run elevated — service deletion needs admin (re-run from an Administrator PowerShell)'
  exit 2
}

# Helper first: stopping it evaporates the session-dynamic WFP filters —
# any in-flight redirect unwinds before the engine it spliced to goes
# away (the reverse of the install ordering).
foreach ($svc in @('BlockingmachineHelper', 'BlockingmachineProxy')) {
  if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
    Write-Log "stopping $svc"
    & sc.exe stop $svc | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 500
      $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    } while ($s -and $s.Status -ne 'Stopped' -and (Get-Date) -lt $deadline)
    & sc.exe delete $svc | Out-Null
    Write-Log "deleted $svc"
  } else {
    Write-Log "$svc not registered — skipped"
  }
}

# Installed binary + dirs. Store/logs keep their content (CA material,
# rules, logs belong to the operator — same posture as the macOS side).
$helperDst = Join-Path $env:ProgramFiles 'Blockingmachine\redirect-helper.exe'
if (Test-Path $helperDst) {
  Remove-Item -Force $helperDst
  Write-Log "removed $helperDst"
}
$programDir = Join-Path $env:ProgramFiles 'Blockingmachine'
if ((Test-Path $programDir) -and -not (Get-ChildItem $programDir -Force | Select-Object -First 1)) {
  Remove-Item -Force $programDir
}

Write-Log 'uninstalled: services gone; WFP filters evaporated with the helper session (fail-open by construction)'
Write-Log 'left in place: C:\ProgramData\Blockingmachine (store/logs) and any installed CA — operator-owned'

<#
.SYNOPSIS
    Run sender + receiver on the same LAN with a shared session tag; capture both
    outputs side-by-side. Produces results/two-process-run.txt.

.DESCRIPTION
    This is the Windows-native capture for the "two-process" evidence artefact
    of the Summer of Bitcoin 2026 · Nostream · Project 1 competency test.
    Runs on Windows PowerShell 5+ or PowerShell 7+.

    Reviewers on Linux / macOS / WSL — see scripts/capture-two-process.sh.

.EXAMPLE
    ./scripts/capture-two-process.ps1
#>

[CmdletBinding()]
param(
    [int]$Count = 5,
    [int]$IntervalMs = 500,
    [int]$ReceiverDeadlineMs = 6000,
    [string]$Session = "poc-$(Get-Random -Maximum 1000000)"
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
Set-Location $here

# Force UTF-8 everywhere so the captured artefact matches the Node.js stdout byte-for-byte
# (default Windows PowerShell uses OEM/ANSI and would mangle non-ASCII characters).
[System.Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[System.Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding                  = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['Out-File:Encoding']    = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'

$resultsDir = Join-Path $here 'results'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

$receiverLog = Join-Path $resultsDir 'two-process-receiver.log'
$senderLog   = Join-Path $resultsDir 'two-process-sender.log'
$combinedLog = Join-Path $resultsDir 'two-process-run.txt'

Remove-Item $receiverLog, $senderLog, $combinedLog -ErrorAction SilentlyContinue

Write-Host "[capture] session=$Session  count=$Count  interval=${IntervalMs}ms  deadline=${ReceiverDeadlineMs}ms"

# Start the receiver in the background with the shared session tag and a finite deadline.
$receiver = Start-Process -FilePath 'npx.cmd' `
    -ArgumentList 'tsx','poc-multicast.ts',"--role=receiver","--session-tag=$Session","--deadline-ms=$ReceiverDeadlineMs" `
    -WorkingDirectory $here `
    -RedirectStandardOutput $receiverLog `
    -RedirectStandardError  "$receiverLog.err" `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Milliseconds 1500  # give the receiver time to bind + join

# Start the sender with the same session tag; it will exit on its own after --count.
$sender = Start-Process -FilePath 'npx.cmd' `
    -ArgumentList 'tsx','poc-multicast.ts',"--role=sender","--session-tag=$Session","--count=$Count","--interval-ms=$IntervalMs" `
    -WorkingDirectory $here `
    -RedirectStandardOutput $senderLog `
    -RedirectStandardError  "$senderLog.err" `
    -WindowStyle Hidden `
    -PassThru

Wait-Process -Id $sender.Id
Write-Host "[capture] sender exited with code $($sender.ExitCode)"

# Let the receiver drain any in-flight frames, then wait for its deadline to fire.
Wait-Process -Id $receiver.Id -Timeout ([math]::Ceiling($ReceiverDeadlineMs / 1000) + 2) `
    -ErrorAction SilentlyContinue
if (-not $receiver.HasExited) {
    Stop-Process -Id $receiver.Id -Force
    Write-Host "[capture] receiver forcibly stopped"
} else {
    Write-Host "[capture] receiver exited with code $($receiver.ExitCode)"
}

# Merge stderr into the primary logs for a single combined artefact.
$receiverErr = "$receiverLog.err"
if (Test-Path $receiverErr) {
    $errContent = Get-Content $receiverErr -Raw
    if ($errContent) { Add-Content -Path $receiverLog -Value "`n[stderr]`n$errContent" }
    Remove-Item $receiverErr
}
$senderErr = "$senderLog.err"
if (Test-Path $senderErr) {
    $errContent = Get-Content $senderErr -Raw
    if ($errContent) { Add-Content -Path $senderLog -Value "`n[stderr]`n$errContent" }
    Remove-Item $senderErr
}

# Build the combined artefact with clear section dividers.
$header = @"
================================================================================
 SoB 2026 - Nostream - Project 1 competency test - two-process run (PowerShell)
================================================================================
 host      : $(hostname)
 os        : $([System.Environment]::OSVersion.VersionString)
 node      : $(node --version)
 session   : $Session
 captured  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
 params    : count=$Count  interval=${IntervalMs}ms  receiver-deadline=${ReceiverDeadlineMs}ms

"@

$receiverBlock = @"
--------------------------------------------------------------------------------
 RECEIVER  (terminal 1)  --  npx tsx poc-multicast.ts --role=receiver --session-tag=$Session --deadline-ms=$ReceiverDeadlineMs
--------------------------------------------------------------------------------

"@

$senderBlock = @"

--------------------------------------------------------------------------------
 SENDER    (terminal 2)  --  npx tsx poc-multicast.ts --role=sender --session-tag=$Session --count=$Count --interval-ms=$IntervalMs
--------------------------------------------------------------------------------

"@

Set-Content -Path $combinedLog -Value $header -Encoding utf8
Add-Content -Path $combinedLog -Value $receiverBlock -Encoding utf8
if (Test-Path $receiverLog) {
    Add-Content -Path $combinedLog -Value (Get-Content $receiverLog -Raw -Encoding utf8) -Encoding utf8
}
Add-Content -Path $combinedLog -Value $senderBlock -Encoding utf8
if (Test-Path $senderLog) {
    Add-Content -Path $combinedLog -Value (Get-Content $senderLog -Raw -Encoding utf8) -Encoding utf8
}

Remove-Item $receiverLog, $senderLog -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== results/two-process-run.txt ==="
Get-Content $combinedLog -Encoding utf8

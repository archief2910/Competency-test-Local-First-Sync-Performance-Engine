<#
.SYNOPSIS
    Record a full demo session (selftest + loopback + two-process) to a text
    transcript that a reviewer can read top-to-bottom without running anything.

.DESCRIPTION
    Uses PowerShell's built-in Start-Transcript (Windows-native analogue of
    `asciinema rec`). Produces results/demo-session.txt with every command,
    timestamp, and its output in chronological order.

    Unix / macOS / WSL equivalent: scripts/record-demo.sh (uses asciinema).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
Set-Location $here

[System.Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['Out-File:Encoding']    = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'

$resultsDir = Join-Path $here 'results'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$transcript = Join-Path $resultsDir 'demo-session.txt'

Start-Transcript -Path $transcript -Force | Out-Null

Write-Host "================================================================================"
Write-Host " SoB 2026 - Nostream - Project 1 competency test - recorded demo session"
Write-Host "================================================================================"
Write-Host " host       : $(hostname)"
Write-Host " os         : $([System.Environment]::OSVersion.VersionString)"
Write-Host " node       : $(node --version)"
Write-Host " npm        : $(npm --version)"
Write-Host " captured   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Write-Host " transcript : $transcript"
Write-Host "================================================================================"
Write-Host ""

Write-Host ">>> [1/4] typecheck  (tsc --noEmit)"
npm run typecheck
Write-Host ""

Write-Host ">>> [2/4] selftest  (13 pure-function assertions)"
npm run selftest
Write-Host ""

Write-Host ">>> [3/4] loopback  (bind -> send -> self-receive -> parse)"
npm run loopback
Write-Host ""

Write-Host ">>> [4/4] two-process  (sender + receiver on the LAN via PowerShell jobs)"
& "$here\scripts\capture-two-process.ps1"
Write-Host ""

Write-Host "================================================================================"
Write-Host " DEMO SESSION COMPLETE - all four phases exited 0."
Write-Host "================================================================================"

Stop-Transcript | Out-Null

Write-Host ""
Write-Host "recorded to: $transcript  ($((Get-Item $transcript).Length) bytes)"

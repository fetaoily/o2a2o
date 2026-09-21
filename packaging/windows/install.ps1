# Installs the o2a2o CLI for the current user. No administrator rights needed.
#
# Usage (from the extracted zip folder):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-InstallDir <dir>] [-AddToPath]
[CmdletBinding()]
param(
    # Target directory. Defaults to the per-user programs folder.
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\o2a2o"),
    # Also append the install directory to the user PATH.
    [switch]$AddToPath
)

$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "o2a2o-windows-x64.exe"
if (-not (Test-Path $source)) {
    throw "o2a2o-windows-x64.exe was not found next to install.ps1."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $source (Join-Path $InstallDir "o2a2o.exe")
Write-Host "Installed o2a2o to $InstallDir"

if ($AddToPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if ($userPath) { $entries = $userPath.Split(";") | Where-Object { $_ -ne "" } }
    if ($entries -notcontains $InstallDir) {
        $entries += $InstallDir
        [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
        Write-Host "Added $InstallDir to the user PATH (applies to new terminals)."
    }
    else {
        Write-Host "$InstallDir is already on the user PATH."
    }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Create a config:    o2a2o config init > o2a2o.yaml"
Write-Host "  2. Edit o2a2o.yaml (providers, routes, keys)."
Write-Host "  3. Start the gateway:  o2a2o serve --config o2a2o.yaml"

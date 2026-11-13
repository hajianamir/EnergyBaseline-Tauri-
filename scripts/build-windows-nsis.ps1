#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a self-contained Windows NSIS installer for EnergyBaseline (Tauri 2 + PyInstaller Sidecar + Frontend).
.PARAMETER OfflineWebView2
  When specified, downloads the Evergreen Standalone WebView2 x64 installer and overrides Tauri webviewInstallMode to offlineInstaller.
#>
param(
  [switch]$OfflineWebView2
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "==> [1/5] Installing & building Vite frontend (local @fontsource fonts included)..."
npm ci
npm run lint
npm run build

Write-Host "==> [2/5] Creating Python venv & installing pinned sidecar requirements..."
$VenvDir = Join-Path $RepoRoot "sidecar\.venv"
if (-not (Test-Path $VenvDir)) {
  python -m venv $VenvDir
}
$PipExe = Join-Path $VenvDir "Scripts\pip.exe"
$PyInstallerExe = Join-Path $VenvDir "Scripts\pyinstaller.exe"
& $PipExe install --upgrade pip
& $PipExe install -r "sidecar\requirements-lock.txt"

Write-Host "==> [3/5] Running Python sidecar unit tests..."
$PyExe = Join-Path $VenvDir "Scripts\python.exe"
& $PyExe -m unittest -v tests/python/test_sidecar.py

Write-Host "==> [4/5] Freezing Python sidecar (--onedir)..."
Push-Location (Join-Path $RepoRoot "sidecar")
& $PyInstallerExe --clean --noconfirm energybaseline_sidecar.spec
Pop-Location

if ($OfflineWebView2) {
  Write-Host "==> [4b] Fetching WebView2 Evergreen Standalone x64 installer for air-gapped setup..."
  $WvDir = Join-Path $RepoRoot "src-tauri\webview2"
  New-Item -ItemType Directory -Force -Path $WvDir | Out-Null
  $WvPath = Join-Path $WvDir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
  Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $WvPath
  $OverrideCfg = '{"bundle":{"windows":{"webviewInstallMode":{"type":"offlineInstaller","path":"webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"}}}}'
  Write-Host "==> [5/5] Building Tauri 2 NSIS Installer..."
  npm run tauri:build -- --config $OverrideCfg
} else {
  Write-Host "==> [5/5] Building Tauri 2 NSIS Installer..."
  npm run tauri:build
}
Write-Host "Done. NSIS installer output is under src-tauri/target/release/bundle/nsis/."

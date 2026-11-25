<#
.SYNOPSIS
  启动「Claude 的工作室」桌面版。首次运行会自动安装依赖并编译（只装在本项目目录里）。
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Bridge = Join-Path $Root 'packages\bridge'
$Desktop = Join-Path $Root 'apps\desktop'

function Invoke-Npm([string]$Dir, [string[]]$NpmArgs) {
  Push-Location $Dir
  try {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') 失败（$Dir）" }
  } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $Bridge 'node_modules'))) { Write-Host '安装 bridge 依赖…' -ForegroundColor Yellow; Invoke-Npm $Bridge @('install', '--no-audit', '--no-fund') }
if (-not (Test-Path (Join-Path $Bridge 'dist\index.js'))) { Write-Host '编译 bridge…' -ForegroundColor Yellow; Invoke-Npm $Bridge @('run', 'build') }
if (-not (Test-Path (Join-Path $Desktop 'node_modules'))) { Write-Host '安装桌面版依赖…' -ForegroundColor Yellow; Invoke-Npm $Desktop @('install', '--no-audit', '--no-fund') }
$electron = Join-Path $Desktop 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Write-Host '下载 Electron…' -ForegroundColor Yellow; Push-Location $Desktop; try { node node_modules\electron\install.js } finally { Pop-Location } }

# 源码比编译结果新时重新编译
$out = Join-Path $Desktop 'out\main\index.js'
$newest = Get-ChildItem (Join-Path $Desktop 'src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $out) -or $newest.LastWriteTime -gt (Get-Item $out).LastWriteTime) { Write-Host '编译桌面版…' -ForegroundColor Yellow; Invoke-Npm $Desktop @('run', 'build') }

Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Desktop
Write-Host '已启动「Claude 的工作室」' -ForegroundColor Cyan

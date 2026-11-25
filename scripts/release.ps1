<#
.SYNOPSIS
  发布新版本：改版本号 → 打包 → 提交并推送 → 在 GitHub 建 Release 并上传安装包、latest.yml、blockmap。
  已安装的应用会从这个 Release 自动更新。

.EXAMPLE
  .\scripts\release.ps1 1.1.0
  .\scripts\release.ps1 patch            # 1.1.0 -> 1.1.1
  .\scripts\release.ps1 minor -Notes "新功能：……"

  需要：git 工作区干净、在 main 分支、gh 已登录（gh auth login）。
  GitHub 登录由 gh 自己处理，本脚本不读取、不保存任何 token。
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = ""
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = Join-Path $Root 'apps\desktop'
$Repo = 'WenzhuoFAN/claude-studio'

function Invoke-Checked([string]$What, [scriptblock]$Block) {
  # Windows PowerShell 5.1 turns any stderr line of a native command (e.g. git's CRLF warning)
  # into an error under 'Stop'; judge success by the exit code instead.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "$What 失败（退出码 $LASTEXITCODE）" }
}

Push-Location $Root
try {
  if (git status --porcelain) { throw 'git 工作区有未提交的改动，先提交或撤销再发布。' }
  if ((git rev-parse --abbrev-ref HEAD) -ne 'main') { throw '请在 main 分支上发布。' }
  Invoke-Checked 'gh 登录检查' { gh auth status *> $null }

  # 1) 版本号（只改 apps/desktop/package.json，不建 git tag；tag 由 gh release 创建）
  Push-Location $Desktop
  try { Invoke-Checked 'npm version' { npm version $Version --no-git-tag-version | Out-Null } } finally { Pop-Location }
  $v = (Get-Content (Join-Path $Desktop 'package.json') -Raw | ConvertFrom-Json).version
  Write-Host "版本 v$v" -ForegroundColor Cyan

  # 2) 打包
  Push-Location $Desktop
  try { Invoke-Checked '打包' { npm run dist } } finally { Pop-Location }
  $dist = Join-Path $Root 'dist'
  $files = @("ClaudeStudio-Setup-$v.exe", "ClaudeStudio-Setup-$v.exe.blockmap", 'latest.yml') | ForEach-Object { Join-Path $dist $_ }
  foreach ($f in $files) { if (-not (Test-Path $f)) { throw "缺少打包产物：$f" } }
  if (-not (Select-String -Path (Join-Path $dist 'latest.yml') -Pattern "version: $v" -Quiet)) { throw 'latest.yml 的版本号不对' }

  # 3) 提交并推送版本号
  Invoke-Checked 'git commit' { git commit -q -am "Release v$v" }
  Invoke-Checked 'git push' { git push origin main }

  # 4) GitHub Release（应用的自动更新从这里下载）
  if (-not $Notes) { $Notes = "Claude 的工作室 v$v`n`n已安装 1.1.0 及以上版本的电脑会自动更新；更早的版本请手动下载安装包安装一次。" }
  $notesFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($notesFile, $Notes, (New-Object Text.UTF8Encoding $false))
    Invoke-Checked 'gh release create' { gh release create "v$v" @files --repo $Repo --target main --title "Claude 的工作室 v$v" --notes-file $notesFile }
  } finally { Remove-Item $notesFile -ErrorAction SilentlyContinue }
  Write-Host "已发布：https://github.com/$Repo/releases/tag/v$v" -ForegroundColor Green
} finally { Pop-Location }

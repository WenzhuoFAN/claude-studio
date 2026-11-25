<#
.SYNOPSIS
  让 Claude（主管）在指定工作目录里完成一个任务，并通过 mao-bridge 把子任务委派给 Codex / DeepSeek。

.EXAMPLE
  .\scripts\run-task.ps1 "用 TypeScript 写一个命令行待办事项工具，支持 add/list/done，并配上单元测试"

.EXAMPLE
  .\scripts\run-task.ps1 "给这个项目补测试" -Workdir D:\code\myproj -MaxBudgetUsd 3
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Task,
  [string]$Workdir,
  [string]$Model,
  [double]$MaxBudgetUsd = 0,
  [int]$DelegateTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $LogDir | Out-Null

if (-not $Workdir) { $Workdir = Join-Path $Root 'sandbox\demo' }
New-Item -ItemType Directory -Force $Workdir | Out-Null
$Workdir = (Resolve-Path $Workdir).Path

# 1) bridge 必须已编译
$Bridge = Join-Path $Root 'packages\bridge\dist\index.js'
if (-not (Test-Path $Bridge)) {
  Write-Host '首次运行：编译 bridge ...' -ForegroundColor Yellow
  Push-Location (Join-Path $Root 'packages\bridge')
  try { npm install --no-audit --no-fund | Out-Null; npm run build | Out-Null } finally { Pop-Location }
}

# 2) 生成带绝对路径的 MCP 配置（工作目录可能不在本仓库下）
$mcp = @{ mcpServers = @{ 'mao-bridge' = @{
  type = 'stdio'; command = 'node'; args = @($Bridge)
  env = @{ MAO_LOG_DIR = $LogDir; MAO_DEFAULT_TIMEOUT_SEC = "$DelegateTimeoutSec" }
} } }
$McpFile = Join-Path $LogDir 'mcp.runtime.json'
[IO.File]::WriteAllText($McpFile, ($mcp | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))

# 3) 允许的工具：bridge + 文件读写 + 构建/测试相关命令。其余一律拒绝（dontAsk 模式）。
#    清单与桌面版共用：config\claude-allowed-tools.json
$allowed = @(Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'config\claude-allowed-tools.json') | ConvertFrom-Json)

$claudeArgs = @(
  '-p', '--output-format', 'stream-json', '--verbose',
  '--mcp-config', $McpFile, '--strict-mcp-config',
  '--permission-mode', 'dontAsk',
  '--allowedTools') + $allowed
if ($Model) { $claudeArgs += @('--model', $Model) }
if ($MaxBudgetUsd -gt 0) { $claudeArgs += @('--max-budget-usd', "$MaxBudgetUsd") }

# 工作目录不在本仓库下时，CLAUDE.md 不会被自动加载，就显式附加分工规则
$rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
if (-not ($Workdir + '\').StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
  $claudeArgs += @('--append-system-prompt', (Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'CLAUDE.md')))
}

$prompt = @"
$Task

工作目录（所有文件都放在这里；委派时 cwd 一律用这个绝对路径）：$Workdir
请按 CLAUDE.md 的分工规则执行：先规划，再委派给 Codex / DeepSeek，逐个审查结果并运行测试，最后给出分工总结。
"@

$stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
$Transcript = Join-Path $LogDir "${stamp}_claude.jsonl"
$Summary = Join-Path $LogDir "${stamp}_claude-summary.md"

# 4) 运行并实时显示（原始 stream-json 存到 logs/）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = New-Object Text.UTF8Encoding $false
$env:MCP_TOOL_TIMEOUT = [string](($DelegateTimeoutSec + 120) * 1000)  # 委派可能跑很久
$env:MCP_TIMEOUT = '60000'

Write-Host "工作目录: $Workdir" -ForegroundColor Cyan
Write-Host "记录文件: $Transcript" -ForegroundColor Cyan
$writer = New-Object IO.StreamWriter($Transcript, $false, (New-Object Text.UTF8Encoding $false))
$final = $null
$ErrorActionPreference = 'Continue'   # PS 5.1: stderr 行会变成 ErrorRecord，不能让它中断
Push-Location $Workdir
try {
  $prompt | & claude @claudeArgs 2>&1 | ForEach-Object {
    $line = "$_"
    $writer.WriteLine($line); $writer.Flush()
    try { $ev = $line | ConvertFrom-Json } catch { Write-Host $line -ForegroundColor DarkGray; return }
    switch ($ev.type) {
      'system' { if ($ev.subtype -eq 'init') { Write-Host "[claude] 模型 $($ev.model)，MCP: $(($ev.mcp_servers | ForEach-Object { "$($_.name)=$($_.status)" }) -join ', ')" -ForegroundColor DarkCyan } }
      'assistant' {
        foreach ($c in $ev.message.content) {
          if ($c.type -eq 'text' -and $c.text) { Write-Host "[claude] $($c.text)" }
          elseif ($c.type -eq 'tool_use') {
            $who = switch -Wildcard ($c.name) { '*codex*' { 'Codex' } '*deepseek*' { 'DeepSeek' } default { $c.name } }
            $hint = if ($c.input.task) { ($c.input.task -replace '\s+', ' ') } elseif ($c.input.command) { $c.input.command } elseif ($c.input.file_path) { $c.input.file_path } else { '' }
            if ($hint.Length -gt 140) { $hint = $hint.Substring(0, 140) + '…' }
            $color = if ($c.name -like 'mcp__*') { 'Yellow' } else { 'DarkYellow' }
            Write-Host "  -> $who  $hint" -ForegroundColor $color
          }
        }
      }
      'user' {
        foreach ($c in $ev.message.content) {
          if ($c.type -eq 'tool_result') {
            $txt = if ($c.content -is [string]) { $c.content } else { ($c.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n" }
            $first = ($txt -split "`n")[0]
            if ($first -match '^agent: ') { Write-Host "  <- $first" -ForegroundColor Green }
            elseif ($c.is_error) { Write-Host "  <- (error) $($first.Substring(0, [Math]::Min(160, $first.Length)))" -ForegroundColor Red }
          }
        }
      }
      'result' { $final = $ev }
    }
  }
} finally {
  Pop-Location
  $writer.Close()
}

if ($final) {
  $cost = '{0:N4}' -f [double]$final.total_cost_usd
  Write-Host ''
  Write-Host "==== 完成：$($final.subtype)  耗时 $([math]::Round($final.duration_ms / 1000))s  轮数 $($final.num_turns)  Claude 费用 `$$cost ====" -ForegroundColor Cyan
  Write-Host $final.result
  $md = "# 任务`n`n$Task`n`n工作目录: $Workdir`n`nClaude: $($final.subtype), $([math]::Round($final.duration_ms / 1000))s, $($final.num_turns) turns, `$$cost`n`n---`n`n$($final.result)`n"
  [IO.File]::WriteAllText($Summary, $md, (New-Object Text.UTF8Encoding $false))
  Write-Host "总结已存: $Summary" -ForegroundColor Cyan
  if ($final.is_error) { exit 1 }
} else {
  Write-Host '没有收到 result 事件，查看记录文件排查。' -ForegroundColor Red
  exit 1
}

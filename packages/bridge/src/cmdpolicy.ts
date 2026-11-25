// Supervision of the commands DeepSeek (dsh) runs.
//
// The hard boundary is dsh's own Windows sandbox (workspace-write: writes only inside cwd and the
// extra --add-dir folders, enforced by the OS). dsh has no per-command approval hook in headless
// mode, so this monitor watches every command as dsh reports it and
//   allow  – ordinary build / test / read commands
//   block  – dangerous by nature: the bridge ends DeepSeek at once and the delegation fails
//   review – unusual (network, installs, paths outside the workspace…): allowed by the sandbox,
//            flagged for Claude's review
// Every command and its verdict is returned to Claude with the delegation result.
import path from "node:path";

export type Verdict = "allow" | "block" | "review";
export interface CmdRecord {
  command: string;
  verdict: Verdict;
  reason: string;
}

const BLOCK: [RegExp, string][] = [
  [/\bformat(\.com)?\s+[a-z]:(?!\w)/i, "格式化磁盘"],
  [/\b(diskpart|bcdedit|vssadmin|cipher(\.exe)?\s+\/w|mountvol|Format-Volume|Clear-Disk|Initialize-Disk)\b/i, "磁盘 / 启动配置操作"],
  [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore|copy|save)\b/i, "修改注册表"],
  [/\b(Set|New|Remove|Rename)-ItemProperty\b|\b(New|Remove|Set)-Item\b[^\n]*\bHK(LM|CU|CR|U|CC):|\bHKEY_(LOCAL_MACHINE|CURRENT_USER)\b[^\n]*\b(Set|New|Remove)-/i, "修改注册表"],
  [/\bSet-ExecutionPolicy\b/i, "修改 PowerShell 执行策略"],
  [/\bsc(\.exe)?\s+(create|delete|config|stop|start|failure)\b|\b(New|Set|Stop|Start|Remove|Restart)-Service\b|\bschtasks\b|\b(Register|Unregister|Set|Enable|Start)-ScheduledTask\b/i, "服务 / 计划任务"],
  [/\b(shutdown(\.exe)?|Restart-Computer|Stop-Computer|logoff)\b/i, "关机 / 重启 / 注销"],
  [/\b(icacls|cacls|takeown|Set-Acl|Add-LocalGroupMember|Remove-LocalGroupMember|New-LocalUser|Set-LocalUser|Remove-LocalUser)\b|\bnet(\.exe)?\s+(user|localgroup|group|share)\b/i, "用户 / 权限修改"],
  [/\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression|sh|bash|cmd|powershell|pwsh|node|python)\b/i, "下载后直接执行"],
  [/\b(iex|Invoke-Expression)\b[^\n]*(DownloadString|DownloadFile|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|http)/i, "下载后直接执行"],
  [/\bDownloadFile\b[^\n]*;[^\n]*\b(Start-Process|&|\.\\)/i, "下载后直接执行"],
  [/\.ssh\b|\.dsh[\\/]+\.?credentials|\.codex[\\/]+auth|\.claude[\\/]+\.?credentials|\.git-credentials|\.aws[\\/]+credentials|\.npmrc|\\User Data\\|Login Data|\bCookies\b|\.docker[\\/]+config\.json|\bcmdkey\b|\bvaultcmd\b|CredentialManager/i, "读取或修改凭据文件"],
  [/\[(System\.)?Environment\]::SetEnvironmentVariable\b|\bsetx(\.exe)?\b/i, "修改用户 / 系统环境变量"],
  [/\bgit\s+push\b|\bnpm\s+(publish|unpublish|deprecate|owner)\b|\bgh\s+(release|repo|pr\s+(create|merge)|gist)\b|\b(twine|cargo|dotnet\s+nuget)\s+(upload|publish|push)\b|\bnpx\s+(np|semantic-release)\b/i, "推送 / 发布到外部"],
  [/\b(Disable|Set)-(MpPreference|NetFirewallProfile)\b|\bnetsh\s+(advfirewall|firewall)\b/i, "关闭安全防护"],
];

const REVIEW: [RegExp, string][] = [
  [/\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|DownloadFile|DownloadString)\b|https?:\/\//i, "联网下载"],
  [/\bnpm\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\b(winget|choco|scoop|pip|pip3|pipx|cargo|go)\s+install\b|\bInstall-(Module|Package)\b/i, "安装全局工具"],
  [/\bStart-Process\b|\bInvoke-Item\b|\bcmd(\.exe)?\s+\/c\s+start\b/i, "启动外部程序"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|commit|rebase|remote)\b/i, "改写 git 历史 / 配置"],
  [/\b(Stop-Process|taskkill|kill)\b/i, "结束进程"],
];

const RECURSIVE_DELETE = /\b(Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^\n]*(-Recurse|-r\b|-rf\b|-fr\b|\/s\b)/i;

/** Absolute Windows paths mentioned in a command (C:\…, \\server\…, ~, $env:…). */
function absPaths(cmd: string): string[] {
  const out: string[] = [];
  // quoted paths may contain spaces
  const quoted = /(["'])((?:[A-Za-z]:[\\/]|\\\\)[^"']*)\1/g;
  for (const m of cmd.matchAll(quoted)) out.push(m[2]);
  cmd = cmd.replace(quoted, " ");
  for (const m of cmd.matchAll(/(?:^|[\s"'=(,])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'|;,)]*)/g)) out.push(m[1]);
  return out;
}

const insideAny = (p: string, roots: string[]) => {
  const a = path.resolve(p).toLowerCase();
  return roots.some((r) => {
    const b = path.resolve(r).toLowerCase();
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  });
};

export function classifyCommand(command: string, cwd: string, extraRoots: string[] = []): CmdRecord {
  const cmd = String(command ?? "");
  const r = (verdict: Verdict, reason: string): CmdRecord => ({ command: cmd, verdict, reason });
  for (const [re, why] of BLOCK) if (re.test(cmd)) return r("block", why);

  const roots = [cwd, ...extraRoots];
  const outside = absPaths(cmd).filter((p) => !insideAny(p, roots));
  if (RECURSIVE_DELETE.test(cmd)) {
    if (outside.length) return r("block", `递归删除工作目录以外的路径：${outside[0]}`);
    // whole workspace / home / drive roots / parent folders
    if (/(?:^|[\s"'])(\.|\.\\|\.\/|\*|\.\.[\\/]?[^\s]*|~[\\/]?|\$env:\w+|\$HOME|[\\/])(?:\s|$|["'])/i.test(cmd)) return r("block", "递归删除整个工作目录或上级目录");
  }
  for (const [re, why] of REVIEW) if (re.test(cmd)) return r("review", why);
  if (outside.length) return r("review", `涉及工作目录以外的路径：${outside[0]}`);
  return r("allow", "");
}

export const VERDICT_ICON: Record<Verdict, string> = { allow: "✓", block: "⛔", review: "❓" };

/** Lines appended to the delegation result so Claude can review them. */
export function formatCommands(list: CmdRecord[]): string {
  if (!list.length) return "";
  const lines = list.map((c) => `  ${VERDICT_ICON[c.verdict]} ${c.verdict}${c.reason ? `（${c.reason}）` : ""}: ${c.command.replace(/\s+/g, " ").slice(0, 300)}`);
  return `commands run (${list.length}) — supervised; review them:\n${lines.join("\n")}`;
}

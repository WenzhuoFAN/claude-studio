// Paths the user attaches to a conversation in place (「+」→「添加文件路径」): not copied, every agent
// gets access for that conversation. Read-only by default; credential folders are refused.
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PathCheck, PathGrant } from "../shared/types";

const lower = (p: string) => path.resolve(p).toLowerCase();
const inside = (p: string, root: string) => {
  const a = lower(p);
  const r = lower(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

const HOME = os.homedir();
const APPDATA = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
const LOCAL = process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");

/** Never: credentials, keys, browser profiles (cookies, saved passwords). */
const SECRET_ROOTS = [
  path.join(HOME, ".ssh"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".azure"),
  path.join(HOME, ".kube"),
  path.join(HOME, ".docker"),
  path.join(HOME, ".dsh"),
  path.join(HOME, ".codex"),
  path.join(HOME, ".claude"),
  path.join(HOME, ".gemini"),
  path.join(HOME, ".config", "gh"),
  path.join(HOME, ".git-credentials"),
  path.join(HOME, ".npmrc"),
  path.join(APPDATA, "Microsoft", "Credentials"),
  path.join(APPDATA, "Microsoft", "Protect"),
  path.join(APPDATA, "Microsoft", "Crypto"),
  path.join(APPDATA, "Microsoft", "SystemCertificates"),
  path.join(APPDATA, "Mozilla", "Firefox", "Profiles"),
  path.join(LOCAL, "Microsoft", "Credentials"),
  path.join(LOCAL, "Google", "Chrome", "User Data"),
  path.join(LOCAL, "Microsoft", "Edge", "User Data"),
  path.join(LOCAL, "BraveSoftware"),
  path.join(APPDATA, "Claude 的工作室"),
];

/** Allowed after an explicit warning: very broad folders. */
function broad(p: string): string | undefined {
  const win = process.env.SystemRoot ?? "C:\\Windows";
  const r = lower(p);
  if (path.parse(p).root.toLowerCase() === r || /^[a-z]:\\?$/i.test(p)) return "这是整个磁盘的根目录";
  if (inside(p, win)) return "这是 Windows 系统文件夹";
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter(Boolean) as string[])
    if (inside(p, pf)) return "这是程序安装 / 系统数据文件夹";
  if (r === lower(HOME)) return "这是你的整个用户文件夹（包含各种登录信息）";
  if (r === lower(path.join(HOME, "AppData")) || r === lower(APPDATA) || r === lower(LOCAL)) return "这是应用数据文件夹（包含各种程序的登录信息）";
  return undefined;
}

export function checkPath(raw: string): PathCheck {
  let p = String(raw ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!p) return { path: "", kind: "dir", error: "路径为空" };
  if (!path.isAbsolute(p)) return { path: p, kind: "dir", error: "请填写完整的绝对路径，例如 D:\\资料\\报告" };
  if (!existsSync(p)) return { path: p, kind: "dir", error: "找不到这个文件或文件夹" };
  try {
    p = realpathSync.native(p);
  } catch {
    p = path.resolve(p);
  }
  const kind = statSync(p).isDirectory() ? "dir" : "file";
  // refuse a credential folder itself, anything inside it, and any folder that contains one only via the warning
  for (const s of SECRET_ROOTS) if (inside(p, s)) return { path: p, kind, error: "这是保存登录凭据 / 密钥 / 浏览器资料的位置，不能交给智能体" };
  const w = broad(p);
  return { path: p, kind, ...(w ? { warn: `${w}，范围很大，里面可能有隐私或系统文件。确定要交给所有智能体访问吗？` } : {}) };
}

/** Re-validate what the renderer sends (drop anything refused or no longer there). */
export function cleanGrants(list: unknown): PathGrant[] {
  if (!Array.isArray(list)) return [];
  const out: PathGrant[] = [];
  for (const g of list.slice(0, 20)) {
    const c = checkPath(String((g as any)?.path ?? ""));
    if (c.error) continue;
    if (out.some((x) => lower(x.path) === lower(c.path))) continue;
    out.push({ path: c.path, kind: c.kind, write: !!(g as any)?.write });
  }
  return out;
}

/** Claude Code permission rule for a path: //c/Users/x/dir/** or //c/Users/x/file.txt */
export function claudeRule(g: PathGrant): string {
  const posix = g.path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
  return "/" + posix.replace(/\/+$/, "") + (g.kind === "dir" ? "/**" : "");
}

export function grantsPrompt(list: PathGrant[]): string {
  if (!list.length) return "";
  return (
    "\n[用户附加的路径] 用户把下面这些文件 / 文件夹交给了本对话（原地访问，没有复制）：\n" +
    list.map((g) => `- ${g.path}（${g.kind === "dir" ? "文件夹" : "文件"}，${g.write ? "可修改" : "只读"}）`).join("\n") +
    "\n- 你可以直接用 Read / Glob / Grep 读取它们；标为「只读」的不许修改、删除、移动（Edit/Write 已被禁止，也不要用命令行改）。「可修改」的才可以改。\n" +
    "- Codex、DeepSeek、Gemini 也能读到这些路径（「可修改」的也能写）：委派时在 task 里写明需要的绝对路径和只读要求。API 类智能体读不到文件，需要时把内容写进 task。Codex 和 DeepSeek 的只读由沙箱强制；Gemini 等其他命令行智能体只靠提示，所以不要把涉及只读路径的修改类任务交给它们。"
  );
}

// Agent registry (agents.json, maintained by the desktop app) and generic adapters.
//   builtin  -> codex / deepseek (existing code paths)
//   cli      -> any command-line agent: args template with {task} {cwd} {model}, task via stdin or arg,
//               output plain text or JSONL (answerField = dotted path of the final answer)
//   openai   -> OpenAI-compatible chat API. Run by the desktop app (it holds the encrypted key); the bridge
//               calls the app over 127.0.0.1 with a per-session token, so keys never reach this process.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runAgent, type AgentResult, type Parser } from "./runner.js";

export interface AgentDef {
  id: string;
  name: string;
  builtin?: "codex" | "deepseek";
  type: "builtin" | "cli" | "openai";
  color: string;
  role: string;
  canEdit: boolean;
  canRun: boolean;
  enabled: boolean;
  avatar?: string;
  cli?: {
    exe: string;
    args: string;
    input: "stdin" | "arg";
    output: "text" | "jsonl";
    answerField?: string;
    healthCmd?: string;
    loginCmd?: string;
  };
  openai?: { baseUrl: string; model: string; hasKey?: boolean };
}

export function readAgents(): AgentDef[] {
  const f = process.env.MAO_AGENTS_PATH;
  if (!f || !existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return [];
  }
}

/** Split a command line into tokens, honouring "double quotes". */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

function getPath(obj: any, dotted: string): unknown {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

class GenericParser implements Parser {
  private lines: string[] = [];
  private answer = "";
  private errs: string[] = [];
  constructor(private mode: "text" | "jsonl", private field?: string) {}
  onRaw(line: string) {
    if (this.mode === "text") this.lines.push(line);
  }
  onEvent(ev: any) {
    if (this.mode === "text") {
      this.lines.push(JSON.stringify(ev));
      return;
    }
    const v = this.field ? getPath(ev, this.field) : (ev?.text ?? ev?.message ?? ev?.content);
    if (typeof v === "string" && v.trim()) this.answer = v;
    if (ev?.type === "error" || ev?.error) this.errs.push(String(ev.error?.message ?? ev.error ?? ev.message ?? "error"));
  }
  finalAnswer() {
    return this.mode === "text" ? this.lines.join("\n").trim() : this.answer;
  }
  usage() {
    return undefined;
  }
  errors() {
    return this.errs;
  }
  completed() {
    return true;
  }
}

/** Run a registered CLI agent. Exit code 0 = success. */
export async function runCliAgent(def: AgentDef, task: string, cwd: string, timeoutSec: number, model?: string): Promise<AgentResult> {
  const c = def.cli!;
  if (!c.exe) throw new Error(`智能体 ${def.name} 没有设置可执行文件`);
  const isScript = /\.(cmd|bat)$/i.test(c.exe);
  if (isScript && c.input === "arg") throw new Error(`${def.name}: .cmd/.bat 程序只支持通过 stdin 传任务（避免命令行注入）`);
  const fill = (tok: string) => tok.replace(/\{cwd\}/g, cwd).replace(/\{model\}/g, model ?? "").replace(/\{task\}/g, c.input === "arg" ? task : "");
  const args = splitArgs(c.args ?? "").map(fill).filter((a) => a !== "");
  if (c.input === "arg" && !(c.args ?? "").includes("{task}")) args.push(task);
  const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return runAgent({
    agent: def.id,
    command: isScript ? (process.env.ComSpec ?? "cmd.exe") : c.exe,
    args: isScript ? ["/d", "/s", "/c", `""${c.exe}" ${args.map(quote).join(" ")}"`] : args,
    windowsVerbatimArguments: isScript,
    cwd,
    task: c.input === "stdin" ? task : "",
    timeoutSec,
    parser: new GenericParser(c.output, c.answerField),
  });
}

/** Health / login check of a CLI agent: exit code 0 = ok. No command configured = ok. */
export function cliHealthy(def: AgentDef): Promise<boolean> {
  const cmd = def.cli?.healthCmd?.trim();
  if (!cmd) return Promise.resolve(true);
  const [exe, ...args] = splitArgs(cmd);
  return new Promise((resolve) => execFile(exe, args, { windowsHide: true, timeout: 20000, shell: /\.(cmd|bat)$/i.test(exe) }, (err) => resolve(!err)));
}

/** Ask the desktop app to run an OpenAI-compatible agent (the app holds the key). */
export async function runOpenAiAgent(def: AgentDef, task: string, cwd: string, timeoutSec: number, model?: string): Promise<AgentResult> {
  const url = process.env.MAO_APP_URL;
  const token = process.env.MAO_APP_TOKEN;
  const started = Date.now();
  const base: AgentResult = {
    agent: def.id,
    ok: false,
    status: "failed",
    finalAnswer: "",
    filesChanged: { added: [], modified: [], deleted: [] },
    durationSec: 0,
    exitCode: null,
    errors: [],
    stderrTail: "",
    logFile: "",
  };
  if (!url || !token) return { ...base, status: "spawn_error", errors: ["API 类智能体只能在桌面版里使用（需要应用保管的密钥）"] };
  try {
    const res = await fetch(`${url}/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentId: def.id, task, cwd, timeoutSec, model, logDir: process.env.MAO_LOG_DIR }),
      signal: AbortSignal.timeout((timeoutSec + 15) * 1000),
    });
    const j: any = await res.json();
    return {
      ...base,
      ok: !!j.ok,
      status: j.ok ? "completed" : j.timeout ? "timeout" : "failed",
      finalAnswer: String(j.text ?? ""),
      durationSec: Math.round((Date.now() - started) / 100) / 10,
      usage: j.usage,
      errors: j.error ? [String(j.error)] : [],
      logFile: String(j.logFile ?? ""),
    };
  } catch (e: any) {
    return { ...base, durationSec: Math.round((Date.now() - started) / 100) / 10, errors: [String(e?.message ?? e)] };
  }
}

export const agentsFile = () => process.env.MAO_AGENTS_PATH ?? "";
export const dirOf = (f: string) => path.dirname(f);

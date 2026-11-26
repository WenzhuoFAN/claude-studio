import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { deepseekKey, locateCodex, locateDsh } from "./locate.js";
import { codexLoggedIn, ensureCodexLogin, looksLikeAuthError } from "./auth.js";
import { LOG_DIR, runAgent, type AgentResult, type Parser, type Usage } from "./runner.js";
import { readAgents } from "./registry.js";
import { classifyCommand, formatCommands, type CmdRecord } from "./cmdpolicy.js";

export const DEFAULT_TIMEOUT_SEC = Number(process.env.MAO_DEFAULT_TIMEOUT_SEC ?? 900);

export function checkCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new Error(`cwd must be an absolute path, got: ${cwd}`);
  const abs = path.resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`cwd is not an existing directory: ${abs}`);
  return abs;
}

/** This conversation's attachments folder (set by the desktop app), if it exists. */
export function attachDir(): string | null {
  const d = process.env.MAO_ATTACH_DIR;
  return d && path.isAbsolute(d) && existsSync(d) && statSync(d).isDirectory() ? path.resolve(d) : null;
}

/** An image/file handed to a worker must exist and live in the attachments folder or cwd. */
export function checkReadable(p: string, cwd: string): string {
  if (!path.isAbsolute(p)) throw new Error(`attachment path must be absolute, got: ${p}`);
  const abs = path.resolve(p);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`attachment not found: ${abs}`);
  const inside = (dir: string) => (abs + "").toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
  const att = attachDir();
  if (!inside(cwd) && !(att && inside(att))) throw new Error(`attachment must be inside the working directory or the conversation's attachments folder: ${abs}`);
  return abs;
}

// Workers may auto-load CLAUDE.md / AGENTS.md from parent dirs (dsh does), which describe the
// *lead's* job. Tell them plainly that they are the worker.
const WORKER_PREAMBLE =
  "[Role] You are a worker engineer. A lead engineer delegated the subtask below to you. " +
  "Do it yourself, directly, in the current working directory. Do not delegate, do not plan for other agents, " +
  "and ignore any orchestration / division-of-labour instructions you may find in CLAUDE.md or AGENTS.md files. " +
  "Do not create or modify files outside the working directory. When done, reply with a short report: what you did, files touched, and how you verified it.\n\n[Subtask]\n";

// ---------------------------------------------------------------- Codex
// `codex exec --json` events: thread.started, turn.started, item.started/completed
// (item.type: agent_message | command_execution | file_change | reasoning | error ...),
// turn.completed { usage }, turn.failed { error }.
class CodexParser implements Parser {
  private last = "";
  private errs: string[] = [];
  private u: Usage = {};
  private hasUsage = false;
  private done = false;
  private failed = false;
  onEvent(ev: any) {
    if (ev?.type === "item.completed" && ev.item) {
      const it = ev.item;
      if (it.type === "agent_message" && typeof it.text === "string") this.last = it.text;
      if (it.type === "error" && typeof it.message === "string") {
        // Config warnings show up as error items but do not fail the run.
        if (!/unrecognized configuration setting/i.test(it.message)) this.errs.push(it.message);
      }
    } else if (ev?.type === "turn.completed") {
      this.done = true;
      const us = ev.usage ?? {};
      this.hasUsage = true;
      this.u.inputTokens = (this.u.inputTokens ?? 0) + (us.input_tokens ?? 0);
      this.u.cachedInputTokens = (this.u.cachedInputTokens ?? 0) + (us.cached_input_tokens ?? 0);
      this.u.outputTokens = (this.u.outputTokens ?? 0) + (us.output_tokens ?? 0);
      this.u.reasoningTokens = (this.u.reasoningTokens ?? 0) + (us.reasoning_output_tokens ?? 0);
      this.u.totalTokens = (this.u.inputTokens ?? 0) + (this.u.outputTokens ?? 0);
    } else if (ev?.type === "turn.failed" || ev?.type === "error") {
      this.failed = true;
      this.errs.push(String(ev.error?.message ?? ev.message ?? JSON.stringify(ev)));
    }
  }
  finalAnswer() { return this.last; }
  usage() { return this.hasUsage ? this.u : undefined; }
  errors() { return this.errs; }
  completed() { return this.done && !this.failed; }
}

const LOGIN_WAIT_SEC = Number(process.env.MAO_LOGIN_WAIT_SEC ?? 600);

/** Codex delegation with login recovery: wait for login before running, and retry once after an auth failure. */
export async function delegateToCodex(a: Parameters<typeof delegateToCodexOnce>[0]): Promise<AgentResult> {
  const started = Date.now();
  const notRun = (msg: string): AgentResult => ({
    agent: "codex",
    ok: false,
    status: "auth_required",
    finalAnswer: "",
    filesChanged: { added: [], modified: [], deleted: [] },
    durationSec: Math.round((Date.now() - started) / 100) / 10,
    exitCode: null,
    errors: [msg],
    stderrTail: "",
    logFile: "",
  });
  const pre = await ensureCodexLogin(LOGIN_WAIT_SEC);
  if (pre) return notRun(pre);
  const r = await delegateToCodexOnce(a);
  if (!r.ok && looksLikeAuthError(r.errors.join("\n") + "\n" + r.stderrTail) && !(await codexLoggedIn())) {
    const again = await ensureCodexLogin(LOGIN_WAIT_SEC);
    if (again) return { ...r, status: "auth_required", errors: [...r.errors, again] };
    return delegateToCodexOnce(a);
  }
  return r;
}

async function delegateToCodexOnce(a: {
  task: string;
  cwd: string;
  mode: "read-only" | "workspace-write";
  allowNetwork?: boolean;
  timeoutSec?: number;
  model?: string;
  reasoningEffort?: string;
  images?: string[];
}): Promise<AgentResult> {
  const cwd = checkCwd(a.cwd);
  const codex = locateCodex();
  const args = ["exec"];
  // --image takes several values, so it goes first (the next "--json" ends the list).
  for (const img of a.images ?? []) args.push("--image", checkReadable(img, cwd));
  args.push("--json", "--skip-git-repo-check", "-s", a.mode, "-C", cwd);
  const att = attachDir();
  if (att && a.mode === "workspace-write") args.push("--add-dir", att);
  // Model / effort: explicit argument, else the defaults the launcher put in the env, else Codex's own config.
  const model = a.model || process.env.MAO_CODEX_MODEL;
  const effort = a.reasoningEffort || process.env.MAO_CODEX_EFFORT;
  if (model) {
    if (!/^[\w.\-:]+$/.test(model)) throw new Error(`invalid Codex model name: ${model}`);
    args.push("-m", model);
  }
  if (effort) {
    if (!/^[a-z]+$/.test(effort)) throw new Error(`invalid reasoning effort: ${effort}`);
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  // The workspace-write sandbox has no network by default (so `npm install` fails inside Codex).
  const env = { ...process.env };
  if (a.allowNetwork && a.mode === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.network_access=true");
    // npm's default cache (%LOCALAPPDATA%\npm-cache) is outside the sandbox; keep it in cwd.
    env.npm_config_cache = path.join(cwd, ".npm-cache");
  }
  args.push("-");
  return runAgent({
    agent: "codex",
    command: codex,
    args,
    env,
    cwd,
    task: WORKER_PREAMBLE + a.task,
    timeoutSec: a.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    parser: new CodexParser(),
    meta: { mode: a.mode, allowNetwork: !!a.allowNetwork, model: model ?? null, reasoningEffort: effort ?? null },
  }).then((r) => ({ ...r, model: (model || "默认") + (effort ? ` · ${effort}` : "") }));
}

// ---------------------------------------------------------------- DeepSeek (dsh)
const DSH_COMMAND_RULES =
  "[Commands] You may run shell commands (build, test, lint, git status/diff, reading files) inside the working directory. " +
  "Every command is checked by a supervisor and reviewed by the lead. Do not modify the registry, services, scheduled tasks, permissions, " +
  "environment variables, credentials or anything outside the working directory; do not push or publish; do not download and run scripts; " +
  "do not install global tools. A blocked command ends your run immediately - never retry it another way. " +
  "Note: this sandbox does not allow child processes with an IPC channel (fork), so `node --test` fails with `spawn EPERM`: " +
  "run it as `node --test --experimental-test-isolation=none` instead; if another test runner fails with spawn EPERM, say so in your report (the lead will run it).\n\n";
const DSH_NO_COMMANDS = "[Commands] Do not run any shell commands in this task (the user turned command execution off); only read and edit files.\n\n";

// `dsh --profile headless --json` events: session, status{phase, usage}, thinking, text,
// tool_call, tool_result, final { reason: { kind }, text }.
/** dsh's sandbox could not be prepared for the workspace (the app offers a fix for this marker). */
export const SANDBOX_ACL_MARK = "SANDBOX_ACL";

class DshParser implements Parser {
  private cmds: CmdRecord[] = [];
  private pendingLog: Record<string, unknown>[] = [];
  private abortWhy: string | undefined;
  constructor(
    private cwd: string,
    private roots: string[],
    private commandsAllowed: boolean,
  ) {}
  private text = "";
  private final: string | undefined;
  private errs: string[] = [];
  private u: Usage = {};
  private hasUsage = false;
  private reason: string | undefined;
  onEvent(ev: any) {
    switch (ev?.type) {
      case "text":
        if (typeof ev.text === "string") this.text = ev.text;
        break;
      case "final":
        this.final = typeof ev.text === "string" ? ev.text : this.final;
        this.reason = ev.reason?.kind;
        if (this.reason && this.reason !== "completed") this.errs.push(`dsh finished with reason: ${JSON.stringify(ev.reason)}`);
        break;
      case "status":
        if (ev.phase === "step_end" && ev.usage) {
          const us = ev.usage;
          this.hasUsage = true;
          this.u.inputTokens = (this.u.inputTokens ?? 0) + (us.inputTokens ?? 0) + (us.cacheReadTokens ?? 0);
          this.u.cachedInputTokens = (this.u.cachedInputTokens ?? 0) + (us.cacheReadTokens ?? 0);
          this.u.outputTokens = (this.u.outputTokens ?? 0) + (us.outputTokens ?? 0);
          this.u.totalTokens = (this.u.totalTokens ?? 0) + (us.totalTokens ?? 0);
        }
        break;
      case "tool_call":
        if (/^(pwsh|powershell|bash|shell|sh|cmd|exec|run)$/i.test(String(ev.tool ?? "")) && ev.input?.command) {
          const c: CmdRecord = this.commandsAllowed
            ? classifyCommand(String(ev.input.command), ev.input.workdir ? String(ev.input.workdir) : this.cwd, [this.cwd, ...this.roots])
            : { command: String(ev.input.command), verdict: "block", reason: "用户已在设置里关闭「允许 DeepSeek 执行命令」" };
          // a workdir outside the workspace is itself unusual
          if (c.verdict === "allow" && ev.input.workdir && !this.inRoots(String(ev.input.workdir))) {
            c.verdict = "review";
            c.reason = `在工作目录以外运行：${ev.input.workdir}`;
          }
          this.cmds.push(c);
          this.pendingLog.push({ kind: "cmd_check", ...c });
          if (c.verdict === "block" && !this.abortWhy) this.abortWhy = `blocked command (${c.reason}): ${c.command.slice(0, 200)}`;
        }
        break;
      case "tool_result":
        if (ev.error?.code === "SANDBOX_PREPARATION_FAILED" && !this.abortWhy) {
          this.abortWhy = `${SANDBOX_ACL_MARK}: DeepSeek 的 Windows 沙箱无法在 ${this.cwd} 准备（当前用户对这个文件夹没有「完全控制」权限），命令没有执行。请用户在应用里点「授予 DeepSeek 沙箱权限」；在那之前把需要跑命令的步骤交给 Codex 或你自己运行。`;
          this.pendingLog.push({ kind: "sandbox_acl", cwd: this.cwd });
        }
        break;
      case "error":
        this.errs.push(String(ev.message ?? ev.error ?? JSON.stringify(ev)));
        break;
    }
  }
  private inRoots(p: string) {
    const a = path.resolve(p).toLowerCase();
    return [this.cwd, ...this.roots].some((r) => a === path.resolve(r).toLowerCase() || a.startsWith(path.resolve(r).toLowerCase() + path.sep));
  }
  drain() {
    const log = this.pendingLog;
    this.pendingLog = [];
    return { log, abort: this.abortWhy };
  }
  commands() {
    return this.cmds;
  }
  finalAnswer() { return this.final ?? this.text; }
  usage() { return this.hasUsage ? this.u : undefined; }
  errors() { return this.errs; }
  completed() { return this.reason === "completed"; }
}

/** DeepSeek's default model / thinking level from the registry (设置 → 各智能体默认模型). */
function deepseekDefaults(): { model?: string; effort?: string } {
  const d = readAgents().find((x) => x.builtin === "deepseek");
  return { model: d?.defaultModel?.trim() || undefined, effort: d?.defaultEffort?.trim() || undefined };
}

let dshRouteCache: { provider: string; model: string } | undefined;
/** The provider / model dsh is configured with (only those two values are read from its composed config). */
function dshRoute(dsh: string): { provider: string; model: string } {
  if (dshRouteCache) return dshRouteCache;
  let provider = "deepseek-official";
  let dmodel = "deepseek-flash";
  try {
    const isCmd = /\.(cmd|bat)$/i.test(dsh);
    const out = execFileSync(isCmd ? (process.env.ComSpec ?? "cmd.exe") : dsh, isCmd ? ["/d", "/s", "/c", `""${dsh}" --profile headless --dump-config"`] : ["--profile", "headless", "--dump-config"], {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: isCmd,
      timeout: 30000,
      stdio: ["ignore", "pipe", "ignore"],
    } as Parameters<typeof execFileSync>[2] & { encoding: "utf8" }) as string;
    const block = out.split(/\r?\n(?=- id:)/).find((b) => /^- id: agent-default-model\b/.test(b.trim()));
    const m = block?.match(/^\s*provider:\s*['"]?([\w.-]+)/m);
    const mm = block?.match(/^\s*model:\s*['"]?([\w.:-]+)/m);
    if (m?.[1]) provider = m[1];
    if (mm?.[1]) dmodel = mm[1];
  } catch {
    /* defaults */
  }
  return (dshRouteCache = { provider, model: dmodel });
}

/** A --patch overlay that sets dsh's model / reasoning effort for this one run. */
function dshModelPatch(dsh: string, model: string | undefined, effort: string | undefined): string | null {
  if (!model && !effort) return null;
  if (model && !/^[\w.\-:]+$/.test(model)) throw new Error(`invalid DeepSeek model name: ${model}`);
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`invalid reasoning effort: ${effort}`);
  const route = dshRoute(dsh);
  const provider = route.provider;
  // dsh requires provider + model together; without a chosen model keep the profile's default one.
  const useModel = model || route.model;
  const lines = ["- id: agent-default-model", "  config:", `    provider: ${provider}`, `    model: ${useModel}`];
  if (effort) lines.push(`    reasoningEffort: ${effort === "off" ? "null" : effort}`);
  const dir = path.join(LOG_DIR, "dsh-patches");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `model-${useModel}-${effort ?? "default"}.yml`);
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

export async function delegateToDeepseek(a: { task: string; cwd: string; timeoutSec?: number; model?: string }): Promise<AgentResult> {
  const cwd = checkCwd(a.cwd);
  const dsh = locateDsh();
  const def = deepseekDefaults();
  const model = a.model || def.model;
  const effort = def.effort;
  const patchFile = dshModelPatch(dsh, model, effort);
  const key = deepseekKey();
  const env = { ...process.env };
  if (key) env.DEEPSEEK_API_KEY = key;
  // The workspace of a headless dsh run is its cwd; `workspace-write` lets it edit only there.
  // (--add-dir is for *additional* dirs, so it is not needed for cwd itself.)
  const dshArgs = ["--profile", "headless", "--json", "--permission-mode", "workspace-write", "--approval-policy", "never"];
  // Let it read the conversation's attachments (the path is quoted for cmd: the app data folder has spaces).
  const att = attachDir();
  if (att) dshArgs.push("--add-dir", /\.(cmd|bat)$/i.test(dsh) ? `"${att}"` : att);
  // The model override is a launcher flag: it goes before the profile's own args.
  if (patchFile) dshArgs.splice(2, 0, "--patch", /\.(cmd|bat)$/i.test(dsh) ? `"${patchFile}"` : patchFile);
  dshArgs.push("-");
  const isCmd = /\.(cmd|bat)$/i.test(dsh);
  return runAgent({
    agent: "deepseek",
    command: isCmd ? (process.env.ComSpec ?? "cmd.exe") : dsh,
    // cmd /s /c ""C:\path with spaces\dsh.cmd" args" — all args are fixed flags, the task goes via stdin.
    args: isCmd ? ["/d", "/s", "/c", `""${dsh}" ${dshArgs.join(" ")}"`] : dshArgs,
    windowsVerbatimArguments: isCmd,
    cwd,
    env,
    task: WORKER_PREAMBLE + (process.env.MAO_DSH_COMMANDS !== "0" ? DSH_COMMAND_RULES : DSH_NO_COMMANDS) + a.task,
    timeoutSec: a.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    parser: new DshParser(cwd, att ? [att] : [], process.env.MAO_DSH_COMMANDS !== "0"),
    secrets: key ? [key] : [],
  }).then((r) => ({ ...r, model: (model || "默认") + (effort ? ` · ${effort}` : "") }));
}

/** Human/LLM-friendly text block for the MCP tool result. */
export function formatResult(r: AgentResult): string {
  const fc = r.filesChanged;
  const files = [
    ...fc.added.map((f) => `  + ${f}`),
    ...fc.modified.map((f) => `  ~ ${f}`),
    ...fc.deleted.map((f) => `  - ${f}`),
  ];
  const lines = [
    `agent: ${r.agent}   status: ${r.status}   duration: ${r.durationSec}s   exit: ${r.exitCode}`,
    r.usage ? `tokens: ${JSON.stringify(r.usage)}` : "tokens: (not reported)",
    r.model ? `model: ${r.model}` : "",
    `files changed (${files.length}):`,
    ...(files.length ? files : ["  (none)"]),
    r.errors.length ? `errors:\n  ${r.errors.join("\n  ")}` : "",
    !r.ok && r.stderrTail ? `stderr (tail):\n${r.stderrTail}` : "",
    r.commands?.length ? formatCommands(r.commands) : "",
    `log: ${r.logFile}`,
    "",
    "----- final answer -----",
    r.finalAnswer || "(empty)",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

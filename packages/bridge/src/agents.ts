import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { deepseekKey, locateCodex, locateDsh } from "./locate.js";
import { codexLoggedIn, ensureCodexLogin, looksLikeAuthError } from "./auth.js";
import { runAgent, type AgentResult, type Parser, type Usage } from "./runner.js";

export const DEFAULT_TIMEOUT_SEC = Number(process.env.MAO_DEFAULT_TIMEOUT_SEC ?? 900);

export function checkCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new Error(`cwd must be an absolute path, got: ${cwd}`);
  const abs = path.resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`cwd is not an existing directory: ${abs}`);
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
}): Promise<AgentResult> {
  const cwd = checkCwd(a.cwd);
  const codex = locateCodex();
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", a.mode, "-C", cwd];
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
  });
}

// ---------------------------------------------------------------- DeepSeek (dsh)
// `dsh --profile headless --json` events: session, status{phase, usage}, thinking, text,
// tool_call, tool_result, final { reason: { kind }, text }.
class DshParser implements Parser {
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
      case "error":
        this.errs.push(String(ev.message ?? ev.error ?? JSON.stringify(ev)));
        break;
    }
  }
  finalAnswer() { return this.final ?? this.text; }
  usage() { return this.hasUsage ? this.u : undefined; }
  errors() { return this.errs; }
  completed() { return this.reason === "completed"; }
}

export async function delegateToDeepseek(a: { task: string; cwd: string; timeoutSec?: number }): Promise<AgentResult> {
  const cwd = checkCwd(a.cwd);
  const dsh = locateDsh();
  const key = deepseekKey();
  const env = { ...process.env };
  if (key) env.DEEPSEEK_API_KEY = key;
  // The workspace of a headless dsh run is its cwd; `workspace-write` lets it edit only there.
  // (--add-dir is for *additional* dirs, so it is not needed for cwd itself.)
  const dshArgs = ["--profile", "headless", "--json", "--permission-mode", "workspace-write", "--approval-policy", "never", "-"];
  const isCmd = /\.(cmd|bat)$/i.test(dsh);
  return runAgent({
    agent: "deepseek",
    command: isCmd ? (process.env.ComSpec ?? "cmd.exe") : dsh,
    // cmd /s /c ""C:\path with spaces\dsh.cmd" args" — all args are fixed flags, the task goes via stdin.
    args: isCmd ? ["/d", "/s", "/c", `""${dsh}" ${dshArgs.join(" ")}"`] : dshArgs,
    windowsVerbatimArguments: isCmd,
    cwd,
    env,
    task: WORKER_PREAMBLE + a.task,
    timeoutSec: a.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    parser: new DshParser(),
    secrets: key ? [key] : [],
  });
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
    `files changed (${files.length}):`,
    ...(files.length ? files : ["  (none)"]),
    r.errors.length ? `errors:\n  ${r.errors.join("\n  ")}` : "",
    !r.ok && r.stderrTail ? `stderr (tail):\n${r.stderrTail}` : "",
    `log: ${r.logFile}`,
    "",
    "----- final answer -----",
    r.finalAnswer || "(empty)",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

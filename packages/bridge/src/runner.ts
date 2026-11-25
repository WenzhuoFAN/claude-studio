// Generic "spawn an agent CLI, feed the task on stdin, parse JSONL events" runner.
import { spawn, execFile } from "node:child_process";
import type { CmdRecord } from "./cmdpolicy.js";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, snapshot, type FileChanges } from "./snapshot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/ -> packages/bridge -> packages -> repo root
export const REPO_ROOT = path.resolve(here, "..", "..", "..");
export const LOG_DIR = process.env.MAO_LOG_DIR ?? path.join(REPO_ROOT, "logs");

export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AgentResult {
  agent: string;
  ok: boolean;
  status: "completed" | "failed" | "timeout" | "spawn_error" | "auth_required";
  finalAnswer: string;
  filesChanged: FileChanges;
  durationSec: number;
  usage?: Usage;
  exitCode: number | null;
  errors: string[];
  stderrTail: string;
  logFile: string;
  /** Commands the agent ran, with the supervisor's verdict (DeepSeek). */
  commands?: CmdRecord[];
}

export interface Parser {
  /** Called for every parsed JSON event on stdout. */
  onEvent(ev: any): void;
  /** Optional: called for stdout lines that are not JSON. */
  onRaw?(line: string): void;
  finalAnswer(): string;
  usage(): Usage | undefined;
  errors(): string[];
  /** true if the agent itself reported success */
  completed(): boolean;
  /** Optional: records to append to the call log, and a reason to stop the agent right now. */
  drain?(): { log: Record<string, unknown>[]; abort?: string };
  commands?(): CmdRecord[];
}

export interface RunSpec {
  agent: string;
  command: string;
  args: string[];
  cwd: string;
  task: string;
  timeoutSec: number;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  parser: Parser;
  /** strings to scrub from anything written to logs or returned */
  secrets?: string[];
  meta?: Record<string, unknown>;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  // On Windows child.kill() only kills the direct child (cmd.exe / electron launcher), not the tree.
  execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}

export async function runAgent(spec: RunSpec): Promise<AgentResult> {
  mkdirSync(LOG_DIR, { recursive: true });
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(LOG_DIR, `${stamp}_${spec.agent}.jsonl`);
  const scrub = (s: string) => {
    let out = s;
    for (const sec of spec.secrets ?? []) if (sec && sec.length >= 8) out = out.split(sec).join("***");
    return out;
  };
  const log = (obj: Record<string, unknown>) => {
    try {
      appendFileSync(logFile, scrub(JSON.stringify({ t: new Date().toISOString(), ...obj })) + "\n");
    } catch {
      /* logging must never break a call */
    }
  };

  log({ kind: "call", agent: spec.agent, cwd: spec.cwd, timeoutSec: spec.timeoutSec, command: spec.command, args: spec.args, task: spec.task, ...spec.meta });

  const before = snapshot(spec.cwd);
  let stderr = "";
  let buf = "";
  let timedOut = false;
  let aborted = "";

  const exit = await new Promise<{ code: number | null; spawnError?: string }>((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      resolve({ code: null, spawnError: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      log({ kind: "timeout", afterSec: spec.timeoutSec });
      killTree(child.pid);
    }, spec.timeoutSec * 1000);

    const handleLine = (line: string) => {
      const l = line.trim();
      if (!l) return;
      try {
        const ev = JSON.parse(l);
        log({ kind: "event", ev });
        spec.parser.onEvent(ev);
        const d = spec.parser.drain?.();
        if (d) {
          for (const rec of d.log) log(rec);
          if (d.abort && !aborted) {
            aborted = d.abort;
            log({ kind: "abort", reason: d.abort });
            killTree(child.pid);
          }
        }
      } catch {
        log({ kind: "stdout", line: l });
        spec.parser.onRaw?.(l);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, spawnError: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf) handleLine(buf);
      resolve({ code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(spec.task, "utf8");
  });

  const after = snapshot(spec.cwd);
  const durationSec = Math.round((Date.now() - started.getTime()) / 100) / 10;
  const errors = spec.parser.errors().map(scrub);
  if (exit.spawnError) errors.push(`spawn error: ${exit.spawnError}`);
  if (aborted) errors.push(`stopped by supervisor: ${aborted}`);

  const status: AgentResult["status"] = exit.spawnError
    ? "spawn_error"
    : timedOut
      ? "timeout"
      : !aborted && exit.code === 0 && spec.parser.completed()
        ? "completed"
        : "failed";

  const result: AgentResult = {
    agent: spec.agent,
    ok: status === "completed",
    status,
    finalAnswer: scrub(spec.parser.finalAnswer()),
    filesChanged: diffSnapshots(before, after),
    durationSec,
    usage: spec.parser.usage(),
    exitCode: exit.code,
    errors,
    stderrTail: scrub(stderr.slice(-4000)),
    logFile,
    ...(spec.parser.commands ? { commands: spec.parser.commands().map((c) => ({ ...c, command: scrub(c.command) })) } : {}),
  };
  log({ kind: "stderr", text: scrub(stderr) });
  log({ kind: "result", result });
  return result;
}

// Tails the bridge's per-call JSONL logs (<runDir>/<stamp>_codex.jsonl / _deepseek.jsonl)
// while a run is active, and turns them into short "what is the worker doing now" lines.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { RunEventBody, Worker } from "../shared/types";

type Emit = (body: RunEventBody) => void;

const clip = (s: string, n = 220) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};

/** Codex runs shell commands as `powershell.exe -Command "<script>"`; show just the script. */
function codexCommand(cmd: string): string {
  const dq = cmd.match(/-Command\s+"([\s\S]*)"\s*$/);
  if (dq) return clip(dq[1].replace(/\\"/g, '"'));
  const sq = cmd.match(/-Command\s+'([\s\S]*)'\s*$/);
  if (sq) return clip(sq[1].replace(/''/g, "'"));
  return clip(cmd);
}

interface FileState {
  offset: number;
  partial: string;
  who: Worker;
  delegateId?: string;
  task?: string;
  tokens?: number;
}

export class WorkerTail {
  private files = new Map<string, FileState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private runDir: string,
    private emit: Emit,
    /** returns the Claude tool_use id of the pending delegation with this worker + task */
    private resolve: (who: Worker, task: string) => string | undefined,
  ) {}

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 700);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tick(); // final flush
  }

  private tick() {
    let names: string[] = [];
    try {
      names = existsSync(this.runDir) ? readdirSync(this.runDir) : [];
    } catch {
      return;
    }
    for (const name of names) {
      const m = name.match(/_([a-z0-9][a-z0-9-]*)\.jsonl$/);
      if (!m) continue;
      const full = path.join(this.runDir, name);
      let st = this.files.get(full);
      if (!st) {
        st = { offset: 0, partial: "", who: m[1] as Worker };
        this.files.set(full, st);
      }
      this.read(full, st);
    }
  }

  private read(file: string, st: FileState) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= st.offset) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      st.offset = size;
      const text = st.partial + buf.toString("utf8");
      const lines = text.split("\n");
      st.partial = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) this.line(st, l);
    } finally {
      closeSync(fd);
    }
  }

  private line(st: FileState, line: string) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.kind === "call") {
      const raw = String(rec.task ?? "");
      st.task = raw.includes("[Subtask]\n") ? raw.split("[Subtask]\n").slice(1).join("[Subtask]\n") : raw;
      st.delegateId = this.resolve(st.who, st.task);
      return;
    }
    if (!st.delegateId && st.task) st.delegateId = this.resolve(st.who, st.task);
    const id = st.delegateId;
    if (!id) return;
    const out = (kind: "cmd" | "tool" | "say" | "file" | "error", text: string) => text && this.emit({ k: "worker", id, who: st.who, kind, text });

    if (rec.kind === "timeout") return out("error", `超时（${rec.afterSec}s），已结束进程`);
    // Registry agents (not codex / deepseek): show plain output lines as they come.
    if (st.who !== "codex" && st.who !== "deepseek") {
      if (rec.kind === "stdout") out("say", clip(rec.line));
      else if (rec.kind === "event") out("say", clip(JSON.stringify(rec.ev), 160));
      return;
    }
    if (rec.kind !== "event") return;
    const ev = rec.ev;
    if (st.who === "codex") {
      const it = ev?.item;
      if (ev?.type === "item.started" && it?.type === "command_execution") out("cmd", codexCommand(it.command ?? ""));
      else if (ev?.type === "item.completed" && it?.type === "command_execution" && it.exit_code && it.exit_code !== 0) out("error", `命令退出码 ${it.exit_code}`);
      else if (ev?.type === "item.completed" && it?.type === "agent_message") out("say", clip(it.text));
      else if (ev?.type === "item.completed" && it?.type === "file_change") {
        const files = (it.changes ?? []).map((c: any) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${path.basename(String(c.path ?? ""))}`);
        out("file", files.join("  "));
      } else if (ev?.type === "turn.failed") out("error", clip(ev.error?.message ?? "turn failed"));
    } else {
      if (ev?.type === "status" && ev.phase === "step_end" && ev.usage) {
        const total = (st.tokens ?? 0) + (ev.usage.totalTokens ?? 0);
        st.tokens = total;
        this.emit({ k: "worker_tokens", id, tokens: total });
        return;
      }
      if (ev?.type === "tool_call") {
        const inp = ev.input ?? {};
        const target = inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? "";
        const isWrite = /write|edit|patch/i.test(String(ev.tool));
        out(isWrite ? "file" : "tool", `${ev.tool} ${clip(isWrite ? path.basename(String(target)) : String(target), 180)}`);
      } else if (ev?.type === "tool_result" && ev.status === "error") out("error", clip(ev.result ?? "", 180));
      else if (ev?.type === "text") out("say", clip(ev.text));
    }
  }
}

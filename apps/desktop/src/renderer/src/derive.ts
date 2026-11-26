// Turn the flat event list into what the chat and the 分工面板 need.
import type { AgentDef, RunEvent, Worker } from "../../shared/types";

export interface Card {
  id: string;
  who: Worker;
  task: string;
  mode?: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** moved to the background so Claude could read a steering message */
  detached?: boolean;
  startedAt: number;
  endedAt?: number;
  durationSec?: number;
  tokens?: number;
  files: string[];
  error?: string;
  answer?: string;
  verdict?: { pass: boolean; text: string };
  activity: Activity[];
  /** token count reported while still running (DeepSeek only) */
  liveTokens?: number;
  /** "Codex 单元 2", "DeepSeek 修复 #2" … */
  label: string;
  /** set when this delegation re-sends an earlier one for fixes */
  parentId?: string;
}

export interface Activity {
  kind: "cmd" | "tool" | "say" | "file" | "error";
  text: string;
  t: number;
}

export interface LeadStats {
  /** number of finished turns (cost is only known after a turn ends) */
  results: number;
  costUsd: number;
  turns: number;
  outputTokens: number;
  tools: number;
  model?: string;
  mcp?: string;
}

export function deriveCards(events: RunEvent[]): Card[] {
  const cards: Card[] = [];
  const byId = new Map<string, Card>();
  for (const ev of events) {
    if (ev.k === "delegate") {
      // A re-send for fixes: same worker, after an earlier card of theirs was rejected or failed,
      // or the task itself says it is a fix.
      const sameWorker = cards.filter((x) => x.who === ev.who);
      const rejected = [...sameWorker].reverse().find((x) => (x.verdict && !x.verdict.pass) || x.status === "failed");
      const saysFix = /\b(fix|fixes|rework|revise)\b|修复|返工|修改上次|修正/i.test(ev.task.slice(0, 400));
      const parent = rejected ?? (saysFix ? sameWorker[sameWorker.length - 1] : undefined);
      let label: string;
      let parentId: string | undefined;
      if (parent && !cards.some((x) => x.parentId === parent.id && x.status === "running")) {
        const root = parent.parentId ? (byId.get(parent.parentId) ?? parent) : parent;
        parentId = root.id;
        const n = cards.filter((x) => x.parentId === root.id).length + 2;
        // 修复 = Claude's review rejected the work; 重试 = the previous attempt failed to run (timeout, login …)
        const rejectedByReview = !!(parent.verdict && !parent.verdict.pass) || saysFix;
        label = `${who(ev.who).name} ${rejectedByReview ? "修复" : "重试"} #${n}`;
      } else {
        label = `${who(ev.who).name} ${ev.who === "codex" ? "单元" : "任务"} ${sameWorker.filter((x) => !x.parentId).length + 1}`;
      }
      const c: Card = { id: ev.id, who: ev.who, task: ev.task, mode: ev.mode, status: "running", startedAt: ev.t, files: [], activity: [], label, parentId };
      cards.push(c);
      byId.set(ev.id, c);
    } else if (ev.k === "delegate_detached") {
      const c = byId.get(ev.id);
      if (c) c.detached = true;
    } else if (ev.k === "worker_tokens") {
      const c = byId.get(ev.id);
      if (c) c.liveTokens = ev.tokens;
    } else if (ev.k === "worker") {
      byId.get(ev.id)?.activity.push({ kind: ev.kind, text: ev.text, t: ev.t });
    } else if (ev.k === "delegate_result") {
      const c = byId.get(ev.id);
      if (!c) continue;
      Object.assign(c, {
        status: ev.ok ? "done" : ev.status === "cancelled" ? "cancelled" : "failed",
        detached: false,
        endedAt: ev.t,
        durationSec: ev.durationSec,
        tokens: ev.tokens,
        files: ev.files,
        error: ev.error,
        answer: ev.answer,
      });
    } else if (ev.k === "verdict") {
      // Attach to the most recent finished card that has no verdict yet.
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i].status !== "running" && !cards[i].verdict) {
          cards[i].verdict = { pass: ev.pass, text: ev.text };
          break;
        }
      }
    } else if (ev.k === "exit") {
      for (const c of cards) if (c.status === "running") Object.assign(c, { status: "failed", endedAt: ev.t, error: ev.redirect ? "已打断（打断并改向）" : ev.stopped ? "已手动停止" : "主进程已退出，委派被中断" });
    }
  }
  return cards;
}

export function deriveLead(events: RunEvent[]): LeadStats {
  const s: LeadStats = { results: 0, costUsd: 0, turns: 0, outputTokens: 0, tools: 0 };
  for (const ev of events) {
    if (ev.k === "init") {
      s.model = ev.model;
      s.mcp = ev.mcp;
    } else if (ev.k === "tool") s.tools++;
    else if (ev.k === "result") {
      s.results++;
      s.costUsd += ev.costUsd ?? 0;
      s.turns += ev.turns ?? 0;
      s.outputTokens += ev.outputTokens ?? 0;
    }
  }
  return s;
}

export interface AgentInfo {
  name: string;
  role: string;
  color: string;
  /** image URL (built-in asset or data URL of a custom avatar) */
  avatar?: string;
  /** API (text-only) agent */
  textOnly?: boolean;
}

/** Display info per agent id; filled from the registry by setRegistry(). */
export const WHO: Record<string, AgentInfo> = {
  claude: { name: "Claude", role: "主管 · 规划 / 审查 / 测试", color: "#d97757" },
  codex: { name: "Codex", role: "实现 / 重构", color: "#19c37d" },
  deepseek: { name: "DeepSeek", role: "测试 / 文档 / 评审", color: "#5b7cff" },
};

export function who(id: string): AgentInfo {
  return WHO[id] ?? { name: id, role: "", color: "#9aa4b2" };
}

/** Registry order (enabled agents), used for presence avatars. */
export let AGENT_ORDER: string[] = ["codex", "deepseek"];

export function setRegistry(list: AgentDef[], avatars: Record<string, string>, builtinAvatars: Record<string, string>) {
  for (const id of Object.keys(WHO)) if (id !== "claude" && !list.some((a) => a.id === id)) delete WHO[id];
  for (const a of list) {
    WHO[a.id] = {
      name: a.name,
      role: a.role,
      color: a.color || "#9aa4b2",
      avatar: avatars[a.id] ?? builtinAvatars[a.id],
      textOnly: a.type === "openai",
    };
  }
  AGENT_ORDER = list.filter((a) => a.enabled).map((a) => a.id);
}

export const ACT_ICON: Record<Activity["kind"], string> = { cmd: "›", tool: "◇", say: "💬", file: "✎", error: "⚠" };

export const EFFORT_TEXT: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极限",
};

export function fmtSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

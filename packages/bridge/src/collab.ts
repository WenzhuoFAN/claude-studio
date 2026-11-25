// Project-coordination tools. Active only when the launcher passes MAO_BOARD_PATH,
// MAO_PROJECT_DIR and MAO_CONVERSATION_ID (the desktop app does; the CLI does not).
import { findConflicts, normPath, overlaps, readBoard, unreadNotes, withBoard, type Board, type Conflict, type Note } from "./board.js";
import type { FileChanges } from "./snapshot.js";

export const COLLAB = {
  board: process.env.MAO_BOARD_PATH ?? "",
  projectDir: process.env.MAO_PROJECT_DIR ?? "",
  me: process.env.MAO_CONVERSATION_ID ?? "",
};
export const collabEnabled = () => !!(COLLAB.board && COLLAB.projectDir && COLLAB.me);

const title = (b: Board, id: string) => (id === "app" ? "系统" : (b.conversations[id]?.title ?? id));

function nextAt(b: Board) {
  const last = b.notes[b.notes.length - 1]?.at ?? 0;
  return Math.max(Date.now(), last + 1);
}

function fmtNotes(b: Board, notes: Note[]): string {
  return notes.map((n) => `- [${n.kind === "decision" ? "优先级决定" : "留言"}] 来自「${title(b, n.from)}」(${n.from}) → ${n.to === "all" ? "所有对话" : n.to === COLLAB.me ? "你" : n.to}: ${n.text}`).join("\n");
}

/** Mark notes as read and return a block to append to any tool result (empty if none). */
export function takeUnread(): string {
  if (!collabEnabled()) return "";
  return withBoard(COLLAB.board, (b) => {
    const un = unreadNotes(b, COLLAB.me);
    if (!un.length) return "";
    b.readUpTo[COLLAB.me] = un[un.length - 1].at;
    return `\n\n📨 项目里其他对话给你的新消息（请考虑并必要时回复）：\n${fmtNotes(b, un)}`;
  });
}

export function projectStatus(): string {
  const b = readBoard(COLLAB.board);
  const lines: string[] = [`你是对话 ${COLLAB.me}（「${title(b, COLLAB.me)}」）。项目文件夹：${COLLAB.projectDir}`];
  const others = Object.entries(b.conversations).filter(([id]) => id !== COLLAB.me);
  const active = others.filter(([, c]) => c.status === "running" || c.status === "waiting");
  if (!active.length) lines.push("项目里没有其他正在运行的对话。");
  for (const [id, c] of active) {
    lines.push(`\n● 对话 ${id}「${c.title}」 状态：${c.status === "waiting" ? `等待中（等 ${c.waitingFor?.conversationId}）` : "运行中"}，开始于 ${new Date(c.startedAt).toLocaleTimeString("zh-CN")}`);
    lines.push(`  目标：${c.goal}`);
    if (c.planStep) lines.push(`  当前进度：${c.planStep}`);
    lines.push(c.claims.length ? `  已占用文件：${c.claims.map((x) => `${x.path}（${x.reason}）`).join("；")}` : "  没有占用文件");
  }
  const mine = b.conversations[COLLAB.me]?.claims ?? [];
  lines.push(`\n你当前占用：${mine.length ? mine.map((x) => x.path).join(", ") : "无"}`);
  const recent = b.notes.slice(-8);
  if (recent.length) lines.push(`\n最近的留言/决定：\n${fmtNotes(b, recent)}`);
  return lines.join("\n");
}

export function claimFiles(paths: string[], reason: string): string {
  const norm = [...new Set(paths.map((p) => normPath(p, COLLAB.projectDir)).filter(Boolean))];
  return withBoard(COLLAB.board, (b) => {
    const me = ensureMe(b);
    const conflicts = findConflicts(b, COLLAB.me, norm);
    const blocked = new Set(conflicts.map((c) => c.path));
    const granted = norm.filter((p) => !blocked.has(p));
    for (const p of granted) if (!me.claims.some((c) => c.path === p)) me.claims.push({ path: p, reason, at: Date.now() });
    me.updatedAt = Date.now();
    const out = [`已占用：${granted.length ? granted.join(", ") : "（无）"}`];
    if (conflicts.length) {
      out.push(`⚠ 冲突（这些文件已被其他对话占用，未授予）：`);
      for (const c of conflicts) out.push(`  - ${c.path} ← 对话 ${c.heldBy}「${c.title}」占用了 ${c.claim}（${c.reason}）`);
      out.push(
        "请你作为主管判断优先级（紧急程度、依赖关系、谁先开始、对方进度），然后选一种：" +
          "1) wait_for_files 排队等对方释放；2) 先做不冲突的部分；3) post_note 和对方协商/请求交接。" +
          "无论选哪种，都要用 post_note(kind=\"decision\") 记录你的决定和理由。",
      );
    }
    return out.join("\n");
  });
}

export function releaseFiles(paths?: string[]): string {
  return withBoard(COLLAB.board, (b) => {
    const me = ensureMe(b);
    if (!paths || !paths.length) {
      const n = me.claims.length;
      me.claims = [];
      return `已释放全部 ${n} 项占用。`;
    }
    const norm = new Set(paths.map((p) => normPath(p, COLLAB.projectDir)));
    const before = me.claims.length;
    me.claims = me.claims.filter((c) => !norm.has(c.path));
    return `已释放 ${before - me.claims.length} 项占用。`;
  });
}

export function postNote(to: string, text: string, kind: "note" | "decision"): string {
  return withBoard(COLLAB.board, (b) => {
    ensureMe(b);
    if (to !== "all" && !b.conversations[to]) return `没有对话 ${to}。用 project_status 查看对话编号，或者用 "all"。`;
    b.notes.push({ id: Math.random().toString(36).slice(2, 10), from: COLLAB.me, to, kind, text, at: nextAt(b) });
    return `已发送${kind === "decision" ? "（优先级决定）" : ""}给 ${to === "all" ? "所有对话" : `「${title(b, to)}」`}。`;
  });
}

export function readNotes(): string {
  const t = takeUnread();
  return t ? t.trim() : "没有新消息。";
}

/** Block until none of `paths` is claimed by another active conversation (or timeout). */
export async function waitForFiles(paths: string[], timeoutSec: number, reason: string): Promise<string> {
  const norm = paths.map((p) => normPath(p, COLLAB.projectDir));
  const start = Date.now();
  let conflicts: Conflict[] = findConflicts(readBoard(COLLAB.board), COLLAB.me, norm);
  if (!conflicts.length) return "这些文件现在没有被占用，可以直接 claim_files。";
  withBoard(COLLAB.board, (b) => {
    const me = ensureMe(b);
    me.status = "waiting";
    me.waitingFor = { conversationId: conflicts[0].heldBy, paths: norm, since: Date.now() };
    me.planStep = `等待「${conflicts[0].title}」释放 ${norm.join(", ")}${reason ? `（${reason}）` : ""}`;
    me.updatedAt = Date.now();
  });
  try {
    while (Date.now() - start < timeoutSec * 1000) {
      await new Promise((r) => setTimeout(r, 2000));
      conflicts = findConflicts(readBoard(COLLAB.board), COLLAB.me, norm);
      if (!conflicts.length) {
        const granted = claimFiles(norm, reason || "等待后获得");
        return `对方已释放，等了 ${Math.round((Date.now() - start) / 1000)} 秒。${granted}`;
      }
    }
    return `等待超时（${timeoutSec}s），仍被占用：${conflicts.map((c) => `${c.path} ← 「${c.title}」`).join("；")}。请重新判断：继续等、先做别的、或 post_note 协商。`;
  } finally {
    withBoard(COLLAB.board, (b) => {
      const me = ensureMe(b);
      if (me.status === "waiting") me.status = "running";
      delete me.waitingFor;
      me.updatedAt = Date.now();
    });
  }
}

/** After a delegation: did the worker touch files another conversation has claimed? */
export function delegationConflicts(fc: FileChanges): string {
  if (!collabEnabled()) return "";
  const changed = [...fc.added, ...fc.modified, ...fc.deleted].map((p) => normPath(p, COLLAB.projectDir));
  if (!changed.length) return "";
  const b = readBoard(COLLAB.board);
  const conflicts = findConflicts(b, COLLAB.me, changed);
  const mine = b.conversations[COLLAB.me]?.claims ?? [];
  const unclaimed = changed.filter((p) => !mine.some((c) => overlaps(c.path, p)));
  const out: string[] = [];
  if (conflicts.length) {
    out.push(`\n\n🚩 CONFLICT：这次委派改动了其他对话占用的文件：`);
    for (const c of conflicts) out.push(`  - ${c.path} ← 对话 ${c.heldBy}「${c.title}」（${c.reason}）`);
    out.push("你必须处理：检查改动是否会和对方冲突，必要时撤销/合并，并用 post_note 通知对方，记录你的决定。");
  }
  if (unclaimed.length) out.push(`\n提示：这些改动的文件你还没有 claim：${unclaimed.join(", ")}`);
  return out.join("\n");
}

function ensureMe(b: Board) {
  if (!b.conversations[COLLAB.me])
    b.conversations[COLLAB.me] = { title: COLLAB.me, goal: "", status: "running", planStep: "", claims: [], startedAt: Date.now(), updatedAt: Date.now() };
  return b.conversations[COLLAB.me];
}

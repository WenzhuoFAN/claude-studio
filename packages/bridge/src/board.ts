// Project board: shared state for all conversations of one project, so they can see each
// other, claim files and leave notes. The file lives in the app's data dir (never in the
// user's project folder) and is guarded by a lock file. Shared by the bridge and the app.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Claim {
  path: string; // normalized, relative to the project folder, forward slashes; may contain * / **
  reason: string;
  at: number;
}

export interface ConvState {
  title: string;
  goal: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped" | "interrupted";
  planStep: string;
  claims: Claim[];
  waitingFor?: { conversationId: string; paths: string[]; since: number };
  startedAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  from: string; // conversation id, or "app"
  to: string; // conversation id or "all"
  kind: "note" | "decision";
  text: string;
  at: number;
}

export interface Board {
  conversations: Record<string, ConvState>;
  notes: Note[];
  /** per conversation: id of the last note it has read */
  readUpTo: Record<string, number>;
}

const empty = (): Board => ({ conversations: {}, notes: [], readUpTo: {} });

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn with an exclusive lock on the board file. Stale locks (>15s) are broken. */
export function withBoard<T>(boardPath: string, fn: (b: Board) => T, write = true): T {
  mkdirSync(path.dirname(boardPath), { recursive: true });
  const lock = boardPath + ".lock";
  const deadline = Date.now() + 10_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) unlinkSync(lock);
      } catch {
        /* lock vanished */
      }
      if (Date.now() > deadline) throw new Error("project board is locked (timeout)");
      sleepSync(25);
    }
  }
  try {
    let b = empty();
    if (existsSync(boardPath)) {
      try {
        b = { ...empty(), ...JSON.parse(readFileSync(boardPath, "utf8")) };
      } catch {
        b = empty();
      }
    }
    const r = fn(b);
    if (write) {
      if (b.notes.length > 300) b.notes = b.notes.slice(-300);
      const tmp = boardPath + ".tmp";
      writeFileSync(tmp, JSON.stringify(b, null, 2));
      renameSync(tmp, boardPath);
    }
    return r;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

export function readBoard(boardPath: string): Board {
  if (!existsSync(boardPath)) return empty();
  try {
    return { ...empty(), ...JSON.parse(readFileSync(boardPath, "utf8")) };
  } catch {
    return empty();
  }
}

/** Normalize a path to project-relative, forward slashes, lower case (Windows is case-insensitive). */
export function normPath(p: string, projectDir: string): string {
  let s = String(p).trim().replace(/\\/g, "/");
  const root = path.resolve(projectDir).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "") + "/";
  if (s.toLowerCase().startsWith(root)) s = s.slice(root.length);
  s = s.replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
  return s.toLowerCase();
}

function globRe(g: string): RegExp {
  const re = g
    .split("**")
    .map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp("^" + re + "$");
}

/** Do two claim patterns overlap? (exact, glob match, or one is a directory prefix of the other) */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes("*") && globRe(a).test(b)) return true;
  if (b.includes("*") && globRe(b).test(a)) return true;
  if (b.startsWith(a + "/") || a.startsWith(b + "/")) return true;
  if (a.includes("*") && b.includes("*")) {
    const pa = a.split("*")[0];
    const pb = b.split("*")[0];
    return pa.startsWith(pb) || pb.startsWith(pa);
  }
  return false;
}

export interface Conflict {
  path: string;
  heldBy: string;
  title: string;
  claim: string;
  reason: string;
}

/** Claims of *other* active conversations that overlap the given paths. */
export function findConflicts(b: Board, me: string, paths: string[]): Conflict[] {
  const out: Conflict[] = [];
  for (const [cid, c] of Object.entries(b.conversations)) {
    if (cid === me || !(c.status === "running" || c.status === "waiting")) continue;
    for (const p of paths)
      for (const cl of c.claims) if (overlaps(p, cl.path)) out.push({ path: p, heldBy: cid, title: c.title, claim: cl.path, reason: cl.reason });
  }
  return out;
}

export function unreadNotes(b: Board, me: string): Note[] {
  const seen = b.readUpTo[me] ?? 0;
  return b.notes.filter((n) => n.at > seen && n.from !== me && (n.to === me || n.to === "all"));
}

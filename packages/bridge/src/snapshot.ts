// Cheap before/after directory snapshot so we can report which files an agent changed,
// independent of whether the directory is a git repo.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".turbo"]);
const MAX_FILES = 5000;
const HASH_LIMIT = 2 * 1024 * 1024;

export type Snapshot = Map<string, string>; // relPath -> fingerprint

export function snapshot(root: string): Snapshot {
  const snap: Snapshot = new Map();
  const walk = (dir: string) => {
    if (snap.size >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          let fp = `${st.size}`;
          if (st.size <= HASH_LIMIT) fp += ":" + createHash("sha1").update(readFileSync(full)).digest("hex");
          else fp += ":" + st.mtimeMs;
          snap.set(path.relative(root, full).replace(/\\/g, "/"), fp);
        } catch {
          /* file vanished */
        }
        if (snap.size >= MAX_FILES) return;
      }
    }
  };
  walk(root);
  return snap;
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [k, v] of after) {
    const b = before.get(k);
    if (b === undefined) added.push(k);
    else if (b !== v) modified.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) deleted.push(k);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

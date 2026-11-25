// Attachments the user pastes / drops / picks in the composer.
// They are copied into the app data folder (never the project folder):
//   attachments\_staging\<rand>\<name>   while the message is being written
//   attachments\<runId>\<name>           once it is sent (one folder per conversation)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Attachment, StageResult } from "../shared/types";
import { USER_DIR } from "./paths";

export const ATTACH_DIR = path.join(USER_DIR, "attachments");
const STAGING = path.join(ATTACH_DIR, "_staging");

export const MAX_IMAGE = 20 * 1024 * 1024;
export const MAX_FILE = 50 * 1024 * 1024;
const MAX_COUNT = 20;

/** Image types Claude accepts as image content. */
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const OTHER_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const mimeOf = (name: string) => IMAGE_MIME[path.extname(name).toLowerCase()] ?? OTHER_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
const isImage = (name: string) => !!IMAGE_MIME[path.extname(name).toLowerCase()];

export const runAttachDir = (runId: string) => path.join(ATTACH_DIR, runId);

/** Keep the original name but drop characters Windows does not allow. */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  return base || "附件";
}

/** `a.png`, then `a (2).png`, … if the name is taken in dir. */
function uniqueIn(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

function inside(p: string, dir: string) {
  return path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
}

function tooBig(name: string, size: number): string | null {
  const lim = isImage(name) ? MAX_IMAGE : MAX_FILE;
  return size > lim ? `「${name}」有 ${mb(size)}，超过了${isImage(name) ? "图片" : "文件"}上限 ${mb(lim)}` : null;
}

function stagingSlot(): string {
  const d = path.join(STAGING, `${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function describe(p: string): Attachment {
  const name = path.basename(p);
  return { name, path: p, size: statSync(p).size, mime: mimeOf(name), image: isImage(name) };
}

export function stageFiles(paths: string[]): StageResult {
  const out: StageResult = { files: [], errors: [] };
  for (const src of paths.slice(0, MAX_COUNT)) {
    const name = path.basename(src);
    try {
      if (!path.isAbsolute(src) || !existsSync(src)) {
        out.errors.push(`找不到「${name}」`);
        continue;
      }
      const st = statSync(src);
      if (st.isDirectory()) {
        out.errors.push(`「${name}」是文件夹，只能附加文件`);
        continue;
      }
      const big = tooBig(name, st.size);
      if (big) {
        out.errors.push(big);
        continue;
      }
      const dst = path.join(stagingSlot(), safeName(name));
      copyFileSync(src, dst);
      out.files.push(describe(dst));
    } catch (e) {
      out.errors.push(`「${name}」无法读取：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (paths.length > MAX_COUNT) out.errors.push(`一次最多附加 ${MAX_COUNT} 个文件`);
  return out;
}

/** A pasted screenshot (or any clipboard file without a path). */
export function stageBlob(name: string, mime: string, data: Uint8Array): StageResult {
  let n = safeName(name || "");
  if (!path.extname(n)) {
    const ext = Object.entries(IMAGE_MIME).find(([, m]) => m === mime)?.[0] ?? "";
    n = (n === "附件" ? "粘贴的图片" : n) + ext;
  }
  const big = tooBig(n, data.byteLength);
  if (big) return { files: [], errors: [big] };
  const dst = path.join(stagingSlot(), n);
  writeFileSync(dst, data);
  return { files: [describe(dst)], errors: [] };
}

/**
 * Move staged attachments into the conversation's folder. Only files inside the attachments
 * folder are accepted (the renderer cannot make Claude read arbitrary paths this way).
 */
export function adopt(runId: string, list: Attachment[] | undefined): Attachment[] {
  if (!list?.length) return [];
  const dir = runAttachDir(runId);
  mkdirSync(dir, { recursive: true });
  const out: Attachment[] = [];
  for (const a of list.slice(0, MAX_COUNT)) {
    const p = path.resolve(String(a?.path ?? ""));
    if (!inside(p, ATTACH_DIR) || !existsSync(p) || !statSync(p).isFile()) continue;
    if (inside(p, dir)) {
      out.push(describe(p));
      continue;
    }
    const dst = uniqueIn(dir, path.basename(p));
    try {
      renameSync(p, dst);
    } catch {
      copyFileSync(p, dst);
    }
    try {
      rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      /* leftover staging folder; cleaned up on next start */
    }
    out.push(describe(dst));
  }
  return out;
}

/** data: URL for an image thumbnail; only for images inside the attachments folder. */
export function preview(p: string): string | null {
  try {
    const abs = path.resolve(String(p));
    if (!inside(abs, ATTACH_DIR) || !isImage(abs) || !existsSync(abs)) return null;
    if (statSync(abs).size > MAX_IMAGE) return null;
    return `data:${mimeOf(abs)};base64,${readFileSync(abs).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Remove staging folders older than a day (attachments that were never sent). */
export function cleanStaging() {
  try {
    for (const d of existsSync(STAGING) ? readdirSync(STAGING) : []) {
      const p = path.join(STAGING, d);
      if (Date.now() - statSync(p).mtimeMs > 24 * 3600 * 1000) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

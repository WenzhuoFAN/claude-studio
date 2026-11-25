import { app } from "electron";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

export const APP_NAME = "Claude 的工作室";
// Must happen before any app.getPath("userData") call so dev and installed builds share one data folder.
app.setName(APP_NAME);
// MAO_USER_DATA: use a separate data folder (demos / screenshots), leaving the real data untouched.
if (process.env.MAO_USER_DATA) app.setPath("userData", process.env.MAO_USER_DATA);

/** Running from the installer build? */
export const PACKAGED = app.isPackaged;
/** Repo root in development (apps/desktop -> ../..). Not meaningful when packaged. */
export const ROOT = path.resolve(app.getAppPath(), "..", "..");
/** Read-only resources: the repo in development, <install>/resources when packaged. */
export const RES = PACKAGED ? process.resourcesPath : ROOT;

/** All user data (projects, boards, quota, agents, settings) and run logs live under userData. */
export const USER_DIR = app.getPath("userData");
export const DATA = path.join(USER_DIR, "data");
export const RUNS = path.join(USER_DIR, "runs");
export const LOGS = RUNS;

export const BRIDGE = PACKAGED ? path.join(RES, "bridge", "dist", "index.js") : path.join(ROOT, "packages", "bridge", "dist", "index.js");
export const CLAUDE_MD = path.join(RES, "CLAUDE.md");
export const ALLOWED_TOOLS = path.join(RES, "config", "claude-allowed-tools.json");
export const DEFAULT_WORKDIR = path.join(USER_DIR, "workspace");
/** Project boards live in the app's data dir, never inside the user's project folder. */
export const BOARDS = path.join(DATA, "boards");
export const boardPath = (projectId: string) => path.join(BOARDS, projectId, "board.json");

/**
 * One-time move of the development data (repo/data and repo/logs/runs) into userData,
 * so nothing is lost when switching to the installed app. Existing userData is never overwritten.
 */
export function migrateRepoData(): string[] {
  const done: string[] = [];
  mkdirSync(DATA, { recursive: true });
  mkdirSync(RUNS, { recursive: true });
  if (process.env.MAO_USER_DATA) return done; // separate demo data folder: start empty
  const repoData = path.join(ROOT, "data");
  if (!PACKAGED && existsSync(repoData) && !existsSync(path.join(DATA, "projects.json"))) {
    cpSync(repoData, DATA, { recursive: true, force: false, errorOnExist: false });
    done.push(`data → ${DATA}`);
  }
  const repoRuns = path.join(ROOT, "logs", "runs");
  if (!PACKAGED && existsSync(repoRuns)) {
    let n = 0;
    for (const id of readdirSync(repoRuns)) {
      const to = path.join(RUNS, id);
      if (!existsSync(to)) {
        cpSync(path.join(repoRuns, id), to, { recursive: true });
        n++;
      }
    }
    if (n) done.push(`${n} runs → ${RUNS}`);
  }
  return done;
}

let claudeCache: string | null | undefined;

/** Find the native claude.exe (the npm shim is claude.cmd / claude.ps1 next to node). */
export function locateClaude(): string | null {
  if (claudeCache !== undefined) return claudeCache;
  const override = process.env.CLAUDE_PATH;
  if (override && existsSync(override)) return (claudeCache = override);
  const where = (name: string): string[] => {
    try {
      return execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  for (const p of where("claude.exe")) if (existsSync(p)) return (claudeCache = p);
  for (const shim of [...where("claude.cmd"), ...where("claude")]) {
    const exe = path.join(path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return (claudeCache = exe);
  }
  // Installed apps started from the Start Menu may have a shorter PATH: try the usual npm locations.
  for (const dir of [process.env.NVM_SYMLINK, "C:\\nvm4w\\nodejs", path.join(process.env.APPDATA ?? "", "npm")]) {
    if (!dir) continue;
    const exe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return (claudeCache = exe);
  }
  return (claudeCache = null);
}

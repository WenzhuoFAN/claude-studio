// Codex login checks for the bridge. The bridge never reads tokens: it only runs
// `codex login status` (exit code 0 = logged in). When the desktop app passes MAO_AUTH_DIR,
// the bridge asks the app to start `codex login` by writing <MAO_AUTH_DIR>/codex.json and
// then waits (polling) instead of failing the delegation.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { locateCodex } from "./locate.js";

/** Read at call time: the desktop app sets MAO_AUTH_DIR after this module is imported. */
const authDir = () => process.env.MAO_AUTH_DIR ?? "";

export interface AuthState {
  state: "ok" | "needed" | "logging_in" | "timeout" | "cancelled";
  reason?: string;
  at: number;
  /** who asked (conversation id), for the UI */
  by?: string;
}

/** True if `codex login status` says we are logged in. MAO_SIM_CODEX_LOGGED_OUT=<file> simulates a logout while that file exists (tests). */
export function codexLoggedIn(): Promise<boolean> {
  const sim = process.env.MAO_SIM_CODEX_LOGGED_OUT;
  if (sim && existsSync(sim)) return Promise.resolve(false);
  let exe: string;
  try {
    exe = locateCodex();
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(exe, ["login", "status"], { windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
  });
}

const file = (agent: string) => path.join(authDir(), `${agent}.json`);

export function readAuth(agent: string): AuthState | null {
  try {
    return JSON.parse(readFileSync(file(agent), "utf8"));
  } catch {
    return null;
  }
}

export function writeAuth(agent: string, s: AuthState) {
  if (!authDir()) return;
  mkdirSync(authDir(), { recursive: true });
  writeFileSync(file(agent), JSON.stringify(s, null, 2));
}

/** Looks like Codex failed because of authentication (expired / logged out / switched account). */
export function looksLikeAuthError(text: string): boolean {
  return /\b401\b|unauthori[sz]ed|not logged in|log ?in again|please (re-)?log ?in|token (has )?expired|refresh token|invalid_grant|authenticat/i.test(text);
}

/**
 * Generic version for registered CLI agents with a health/login command: ask the app to run the
 * agent's login command, then wait until `check` passes. Returns null when ok, else a message.
 */
export async function ensureAgentLogin(agentId: string, name: string, check: () => Promise<boolean>, waitSec: number): Promise<string | null> {
  if (await check()) return null;
  if (!authDir()) return `${name} 的健康检查没有通过（可能需要登录）。`;
  const cur = readAuth(agentId);
  if (!cur || cur.state === "ok" || cur.state === "timeout" || cur.state === "cancelled")
    writeAuth(agentId, { state: "needed", reason: "需要登录", at: Date.now(), by: process.env.MAO_CONVERSATION_ID });
  const start = Date.now();
  while (Date.now() - start < waitSec * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await check()) {
      writeAuth(agentId, { state: "ok", at: Date.now() });
      return null;
    }
    const s = readAuth(agentId);
    if (s?.state === "cancelled" || s?.state === "timeout") break;
  }
  return `${name} 需要登录：等待了 ${Math.round((Date.now() - start) / 1000)} 秒仍未就绪，这个子任务没有执行。请你决定改派、自己完成或稍后重试，并告诉用户。`;
}

/**
 * Make sure Codex is logged in. If not: ask the app to open the login page and wait up to
 * waitSec. Returns null when logged in, otherwise a message explaining why the task did not run.
 */
export async function ensureCodexLogin(waitSec: number, onWaiting?: () => void): Promise<string | null> {
  if (await codexLoggedIn()) {
    const cur = readAuth("codex");
    if (cur && cur.state !== "ok") writeAuth("codex", { state: "ok", at: Date.now() });
    return null;
  }
  if (!authDir()) return "Codex 没有登录（`codex login status` 显示未登录）。请在终端运行 `codex login` 登录后重试。";
  const cur = readAuth("codex");
  if (!cur || cur.state === "ok" || cur.state === "timeout" || cur.state === "cancelled")
    writeAuth("codex", { state: "needed", reason: "需要登录", at: Date.now(), by: process.env.MAO_CONVERSATION_ID });
  onWaiting?.();
  const start = Date.now();
  while (Date.now() - start < waitSec * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await codexLoggedIn()) {
      writeAuth("codex", { state: "ok", at: Date.now() });
      return null;
    }
    const s = readAuth("codex");
    if (s?.state === "cancelled" || s?.state === "timeout") break;
  }
  return (
    `Codex 需要登录：已为用户打开登录页并等待了 ${Math.round((Date.now() - start) / 1000)} 秒，仍未登录，这个子任务没有执行。` +
    "请你决定：改派给 DeepSeek（delegate_to_deepseek）、自己完成，或稍后再次调用 delegate_to_codex（届时会继续等待登录），并在回复里告诉用户你的决定。"
  );
}

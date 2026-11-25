// Locate the Codex and dsh executables at runtime. Nothing here is a versioned path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

let codexCache: string | undefined;
let dshCache: string | undefined;

export function locateCodex(): string {
  if (codexCache) return codexCache;
  const override = process.env.CODEX_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`CODEX_PATH points to a missing file: ${override}`);
    return (codexCache = override);
  }
  // 1) Ask Windows where the Codex app package is installed.
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    ).trim();
    if (out) {
      const p = path.join(out, "app", "resources", "codex.exe");
      if (existsSync(p)) return (codexCache = p);
    }
  } catch {
    /* fall through */
  }
  // 2) Fallback: scan WindowsApps for OpenAI.Codex_* (pick the newest by name).
  const root = "C:\\Program Files\\WindowsApps";
  try {
    const dirs = readdirSync(root).filter((d) => d.startsWith("OpenAI.Codex_")).sort().reverse();
    for (const d of dirs) {
      const p = path.join(root, d, "app", "resources", "codex.exe");
      if (existsSync(p)) return (codexCache = p);
    }
  } catch {
    /* WindowsApps is usually not listable; ignore */
  }
  // 3) Last resort: codex on PATH.
  try {
    const out = execFileSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]?.trim();
    if (out && existsSync(out)) return (codexCache = out);
  } catch {
    /* ignore */
  }
  throw new Error("Codex executable not found. Install the Codex app or set CODEX_PATH.");
}

export function locateDsh(): string {
  if (dshCache) return dshCache;
  const override = process.env.DSH_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_PATH points to a missing file: ${override}`);
    return (dshCache = override);
  }
  const local = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const p = path.join(local, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd");
  if (existsSync(p)) return (dshCache = p);
  try {
    const out = execFileSync("where.exe", ["dsh"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]?.trim();
    if (out && existsSync(out)) return (dshCache = out);
  } catch {
    /* ignore */
  }
  throw new Error("dsh not found. Install DeepSeek Harness or set DSH_PATH.");
}

/**
 * Return DEEPSEEK_API_KEY from the process env, or read it from HKCU\Environment
 * (user env var set after this process started). The value is never logged.
 */
export function deepseekKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const out = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", "DEEPSEEK_API_KEY"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    const m = out.match(/DEEPSEEK_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

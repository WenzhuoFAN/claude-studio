// App settings: <userData>/data/settings.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings } from "../shared/types";
import { DATA } from "./paths";

const FILE = path.join(DATA, "settings.json");

export const DEFAULT_SETTINGS: Settings = {
  claudeModel: "",
  claudeEffort: "",
  codexModel: "",
  codexEffort: "",
  splitSmall: false,
  dshCommands: true,
  delegateTimeoutSec: 900,
  loginWaitSec: 600,
};

export function loadSettings(): Settings {
  try {
    if (existsSync(FILE)) return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    /* fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Partial<Settings>): Settings {
  const cur = loadSettings();
  const next: Settings = { ...cur, ...s };
  next.delegateTimeoutSec = Math.min(3600, Math.max(60, Math.round(Number(next.delegateTimeoutSec) || 900)));
  next.loginWaitSec = Math.min(3600, Math.max(30, Math.round(Number(next.loginWaitSec) || 600)));
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

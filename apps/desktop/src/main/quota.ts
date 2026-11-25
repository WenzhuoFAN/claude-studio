// Subscription quota (Claude, Codex) and DeepSeek balance. Sources:
//  - Claude:   `rate_limit_event` lines in `claude -p --output-format stream-json` (five_hour / seven_day utilization)
//  - Codex:    `codex app-server` JSON-RPC `account/rateLimits/read` (primary = short window, secondary = weekly)
//  - DeepSeek: GET https://api.deepseek.com/user/balance (official API, Bearer DEEPSEEK_API_KEY; key never logged)
// Last known values are cached in <repo>/data/quota.json so they show right after startup.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const statMtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Quota, QuotaWindow } from "../shared/types";
import { deepseekKey, locateCodex } from "../../../../packages/bridge/src/locate";
import { DATA } from "./paths";

const FILE = path.join(DATA, "quota.json");

export class QuotaTracker extends EventEmitter {
  q: Quota = {};
  private codexBusy = false;

  constructor() {
    super();
    try {
      if (existsSync(FILE)) this.q = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      this.q = {};
    }
  }

  private changed() {
    try {
      writeFileSync(FILE, JSON.stringify(this.q, null, 2));
    } catch {
      /* ignore */
    }
    this.emit("changed", this.q);
  }

  /** At startup: take the newest `rate_limit_event` from saved Claude transcripts (if newer than the cache). */
  seedClaudeFromLogs(files: string[]) {
    let best: { at: number; info: any } | null = null;
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const i = text.lastIndexOf('"type":"rate_limit_event"');
      if (i < 0) continue;
      const start = text.lastIndexOf("\n", i) + 1;
      const end = text.indexOf("\n", i);
      try {
        const ev = JSON.parse(text.slice(start, end < 0 ? undefined : end));
        const at = statMtime(f);
        if (!best || at > best.at) best = { at, info: ev.rate_limit_info };
      } catch {
        /* ignore */
      }
    }
    if (best && (!this.q.claude || this.q.claude.at < best.at)) {
      this.fromClaudeEvent(best.info);
      if (this.q.claude) this.q.claude.at = best.at;
    }
  }

  /** From a stream-json `rate_limit_event`. */
  fromClaudeEvent(info: any) {
    const w = info?.unifiedWindows ?? {};
    const win = (x: any): QuotaWindow | undefined =>
      x && typeof x.utilization === "number" ? { usedPercent: Math.round(x.utilization * 1000) / 10, resetsAt: (x.resetsAt ?? 0) * 1000, status: x.status } : undefined;
    this.q.claude = { short: win(w.five_hour), weekly: win(w.seven_day), shortLabel: "5 小时", at: Date.now() };
    this.changed();
  }

  /** Ask Codex's app-server for the account's rate limits. */
  refreshCodex(): Promise<void> {
    if (this.codexBusy) return Promise.resolve();
    let exe: string;
    try {
      exe = locateCodex();
    } catch {
      return Promise.resolve();
    }
    this.codexBusy = true;
    return new Promise<void>((resolve) => {
      const p = spawn(exe, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let buf = "";
      const done = () => {
        clearTimeout(timer);
        this.codexBusy = false;
        try {
          p.kill();
        } catch {
          /* ignore */
        }
        resolve();
      };
      const timer = setTimeout(done, 20000);
      const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
      p.on("error", done);
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          } else if (m.id === 2) {
            const rl = m.result?.rateLimits;
            if (rl) {
              const win = (x: any): QuotaWindow | undefined =>
                x ? { usedPercent: x.usedPercent, resetsAt: (x.resetsAt ?? 0) * 1000, windowMins: x.windowDurationMins } : undefined;
              const short = win(rl.primary);
              this.q.codex = {
                short,
                weekly: win(rl.secondary),
                shortLabel: short?.windowMins ? (short.windowMins % 60 === 0 ? `${short.windowMins / 60} 小时` : `${short.windowMins} 分钟`) : "短周期",
                plan: rl.planType ?? undefined,
                at: Date.now(),
              };
              this.changed();
            }
            done();
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "claude-studio", title: "Claude 的工作室", version: "0.2.0" } } });
    });
  }

  async refreshDeepseek(): Promise<void> {
    if (process.env.MAO_DEMO_MODE === "1") return; // screenshots: never show the account balance
    const key = deepseekKey();
    if (!key) return;
    try {
      const res = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
      if (!res.ok) {
        this.q.deepseek = { ...(this.q.deepseek ?? { balances: [] }), error: `HTTP ${res.status}`, at: Date.now() };
      } else {
        const j: any = await res.json();
        this.q.deepseek = {
          available: !!j.is_available,
          balances: (j.balance_infos ?? []).map((b: any) => ({ currency: String(b.currency), total: String(b.total_balance) })),
          at: Date.now(),
        };
      }
    } catch (e: any) {
      this.q.deepseek = { ...(this.q.deepseek ?? { balances: [] }), error: String(e?.message ?? e).slice(0, 120), at: Date.now() };
    }
    this.changed();
  }
}

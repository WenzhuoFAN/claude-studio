// Login recovery for Codex and Claude Code.
// - Detects "not logged in" with the CLIs' own status commands (`codex login status`, `claude auth status`);
//   tokens are never read or logged.
// - The bridge requests a Codex login by writing data/auth/codex.json {state:"needed"}; this manager then runs
//   ONE `codex login` (it opens the browser OAuth page), polls the status, and marks it "ok" when done, which
//   lets the waiting delegation continue. Timeout / cancel are written back so the bridge stops waiting and
//   Claude can decide to reassign.
// - MAO_SIM_CODEX_LOGGED_OUT=<file> (tests): pretend Codex is logged out while that file exists, and do not
//   launch a real login (so the user's account is never touched).
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { shell } from "electron";
import { codexLoggedIn, readAuth, writeAuth, type AuthState } from "../../../../packages/bridge/src/auth";
import { locateCodex } from "../../../../packages/bridge/src/locate";
import { cliHealthy, splitArgs, type AgentDef } from "../../../../packages/bridge/src/registry";
import { readdirSync } from "node:fs";
import type { AuthInfo, AuthStatus } from "../shared/types";
import { DATA, locateClaude } from "./paths";

export const AUTH_DIR = path.join(DATA, "auth");
process.env.MAO_AUTH_DIR = AUTH_DIR; // used by the bridge helpers imported above
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const simulated = () => !!process.env.MAO_SIM_CODEX_LOGGED_OUT;

function claudeLoggedIn(): Promise<boolean> {
  const exe = locateClaude();
  if (!exe) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(exe, ["auth", "status"], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      try {
        resolve(!!JSON.parse(stdout).loggedIn); // only this field is read
      } catch {
        resolve(!err);
      }
    });
  });
}

interface Flow {
  proc: ChildProcess | null;
  url?: string;
  startedAt: number;
  poll: NodeJS.Timeout;
}

export class AuthManager extends EventEmitter {
  info: AuthInfo = { codex: { state: "ok", at: 0 }, claude: { state: "ok", at: 0 } };
  private flows: Partial<Record<string, Flow>> = {};
  /** Registry lookup for agents other than codex / claude (set by index.ts). */
  findAgent: (id: string) => AgentDef | undefined = () => undefined;

  private check(agent: string): Promise<boolean> {
    if (agent === "codex") return codexLoggedIn();
    if (agent === "claude") return claudeLoggedIn();
    const def = this.findAgent(agent);
    return def ? cliHealthy(def) : Promise.resolve(true);
  }

  constructor() {
    super();
    mkdirSync(AUTH_DIR, { recursive: true });
    // A stale "needed"/"logging_in" from a previous session: re-check below.
    setInterval(() => this.watchRequests(), 1500);
  }

  private set(agent: string, s: AuthStatus) {
    this.info = { ...this.info, [agent]: s };
    if (agent !== "claude") writeAuth(agent, { state: s.state === "simulated" ? "logging_in" : s.state, reason: s.reason, at: s.at } as AuthState);
    if (false) writeAuth("codex", { state: s.state === "simulated" ? "logging_in" : s.state, reason: s.reason, at: s.at } as AuthState);
    this.emit("changed", this.info);
  }

  /** Startup check of both CLIs. */
  async checkAll() {
    if (!(await codexLoggedIn())) this.startLogin("codex", "需要登录");
    else this.set("codex", { state: "ok", at: Date.now() });
    if (!(await claudeLoggedIn())) this.startLogin("claude", "需要登录");
    else this.set("claude", { state: "ok", at: Date.now() });
  }

  /** The bridge asks for a Codex login by writing codex.json. */
  private watchRequests() {
    let files: string[] = [];
    try {
      files = readdirSync(AUTH_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      const id = f.slice(0, -5);
      if (id === "claude") continue;
      const s = readAuth(id);
      if (s?.state === "needed" && !this.flows[id]) this.startLogin(id, s.reason ?? "需要登录");
    }
  }

  /** Called when a Claude run failed in a way that looks like an auth problem. */
  async claudeMaybeLoggedOut() {
    if (!this.flows.claude && !(await claudeLoggedIn())) this.startLogin("claude", "登录已失效");
  }

  startLogin(agent: string, reason: string) {
    if (this.flows[agent]) return; // only one login process per agent
    let proc: ChildProcess | null = null;
    const flow: Flow = { proc: null, startedAt: Date.now(), poll: setInterval(() => this.pollFlow(agent), 3000) };
    this.flows[agent] = flow;
    if (agent === "codex" && simulated()) {
      this.set("codex", { state: "simulated", reason: `${reason}（模拟测试，未打开浏览器）`, at: Date.now() });
      return;
    }
    try {
      if (agent === "codex") proc = spawn(locateCodex(), ["login"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      else if (agent !== "claude") {
        const cmd = this.findAgent(agent)?.cli?.loginCmd?.trim();
        if (!cmd) throw new Error("这个智能体没有设置登录命令，请在设置里补上，或手动登录后点「重新登录」");
        const [exe, ...args] = splitArgs(cmd);
        proc = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: /\.(cmd|bat)$/i.test(exe) });
      } else {
        const exe = locateClaude();
        if (!exe) throw new Error("找不到 claude.exe");
        proc = spawn(exe, ["auth", "login"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (e: any) {
      this.finish(agent, { state: "timeout", reason: `无法启动登录：${e?.message ?? e}`, at: Date.now() });
      return;
    }
    flow.proc = proc;
    // Remember the login URL the CLI prints (only the URL; nothing else from its output is kept).
    const grabUrl = (d: Buffer) => {
      const m = String(d).match(/https?:\/\/[^\s"'<>]+/);
      if (m && !flow.url) {
        flow.url = m[0];
        this.set(agent, { ...this.info[agent], state: "logging_in", hasUrl: true });
      }
    };
    proc.stdout?.on("data", grabUrl);
    proc.stderr?.on("data", grabUrl);
    proc.on("exit", () => {
      if (this.flows[agent]?.proc === proc) flow.proc = null;
    });
    this.set(agent, { state: "logging_in", reason, at: Date.now(), hasUrl: false });
  }

  private async pollFlow(agent: string) {
    const flow = this.flows[agent];
    if (!flow) return;
    const ok = await this.check(agent);
    if (ok) return this.finish(agent, { state: "ok", at: Date.now() });
    if (Date.now() - flow.startedAt > LOGIN_TIMEOUT_MS) this.finish(agent, { state: "timeout", reason: "等待登录超时", at: Date.now() });
  }

  private finish(agent: string, s: AuthStatus) {
    const flow = this.flows[agent];
    if (flow) {
      clearInterval(flow.poll);
      try {
        flow.proc?.kill();
      } catch {
        /* ignore */
      }
      delete this.flows[agent];
    }
    this.set(agent, s);
  }

  /** "重新打开登录页": reopen the URL the CLI printed, or restart the login process. */
  reopen(agent: string) {
    const flow = this.flows[agent];
    if (flow?.url) {
      shell.openExternal(flow.url);
      return;
    }
    if (flow && !flow.proc && !(agent === "codex" && simulated())) {
      this.finish(agent, { ...this.info[agent], at: Date.now() });
    }
    if (!this.flows[agent]) this.startLogin(agent, this.info[agent].reason ?? "需要登录");
  }

  cancel(agent: string) {
    this.finish(agent, { state: "cancelled", reason: "已取消登录", at: Date.now() });
  }

  /** Retry after timeout / cancel. */
  retry(agent: string) {
    if (!this.flows[agent]) this.startLogin(agent, "需要登录");
  }

  stopAll() {
    for (const a of Object.keys(this.flows)) {
      const f = this.flows[a];
      if (f) {
        clearInterval(f.poll);
        try {
          f.proc?.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const authFileExists = () => existsSync(path.join(AUTH_DIR, "codex.json"));

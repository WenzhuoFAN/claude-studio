import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readBoard } from "../../../../packages/bridge/src/board";
import path from "node:path";
import { deepseekKey, freshUserEnv, locateCodex, locateDsh } from "../../../../packages/bridge/src/locate";
import type { Attachment, CodexModel, EnvStatus, RunOptions } from "../shared/types";
import { cleanStaging, preview, stageBlob, stageFiles } from "./attachments";

if (process.platform === "win32") app.setAppUserModelId("claude-studio");
import { APP_NAME, BRIDGE, DATA, DEFAULT_WORKDIR, PACKAGED, ROOT, RUNS, USER_DIR, boardPath, locateClaude, migrateRepoData } from "./paths";
import { RunManager } from "./runs";
import { ProjectStore } from "./projects";
import { QuotaTracker } from "./quota";
import { AuthManager } from "./auth";
import { AGENTS_FILE, AgentStore } from "./agents";
import { callOpenAi, startAppServer } from "./appserver";
import { loadSettings, saveSettings } from "./settings";
import { Updater } from "./updater";

let updater: Updater;
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import { extractAnswer, splitArgs, type AgentDef } from "../../../../packages/bridge/src/registry";
import type { AgentTestResult, Settings } from "../shared/types";

let win: BrowserWindow | null = null;
let runs: RunManager;
let projects: ProjectStore;
let quota: QuotaTracker;
let auth: AuthManager;
let agents: AgentStore;

const safe = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

function envStatus(): EnvStatus {
  return {
    claude: locateClaude(),
    codex: safe(locateCodex),
    dsh: safe(locateDsh),
    deepseekKey: !!safe(deepseekKey), // only a boolean ever leaves this function
    bridgeBuilt: existsSync(BRIDGE),
    root: ROOT,
    agents: Object.fromEntries((agents?.all() ?? []).filter((a) => !a.builtin).map((a) => [a.id, agentUnavailable(a)])),
  };
}

/** "" when a registry agent looks usable, otherwise a short reason. */
function agentUnavailable(a: AgentDef): string {
  if (!a.enabled) return "已停用";
  if (a.type === "cli") {
    const exe = a.cli?.exe ?? "";
    if (!exe) return "没有设置可执行文件";
    if (/[\\/]/.test(exe) && !existsSync(exe)) return "找不到可执行文件";
    return "";
  }
  if (a.type === "openai") return a.openai?.baseUrl ? "" : "没有设置接口地址";
  return "";
}

/** "测试连接": run a tiny prompt through the agent. */
async function testAgent(def: AgentDef, apiKey?: string | null): Promise<AgentTestResult> {
  const prompt = "This is a connection test. Reply with exactly: OK";
  if (def.type === "openai") {
    const key = apiKey ?? (def.id ? agents.secret(def.id) : null);
    const r = await callOpenAi({ ...def, openai: { baseUrl: def.openai?.baseUrl ?? "", model: def.openai?.model ?? "" } }, key, prompt, 120);
    return { ok: r.ok, text: r.text, error: r.error, durationSec: r.durationSec };
  }
  if (def.type === "cli") {
    const c = def.cli;
    if (!c?.exe) return { ok: false, text: "", error: "没有设置可执行文件", durationSec: 0 };
    const dir = mkdtempSync(path.join(os.tmpdir(), "studio-agent-test-"));
    const started = Date.now();
    const isScript = /\.(cmd|bat)$/i.test(c.exe);
    if (isScript && c.input === "arg") return { ok: false, text: "", error: ".cmd/.bat 只支持 stdin 方式传任务", durationSec: 0 };
    const args = splitArgs(c.args ?? "").map((x) => x.replace(/\{cwd\}/g, dir).replace(/\{model\}/g, "").replace(/\{task\}/g, c.input === "arg" ? prompt : "")).filter(Boolean);
    if (c.input === "arg" && !(c.args ?? "").includes("{task}")) args.push(prompt);
    return new Promise((resolve) => {
      let out = "";
      let err = "";
      const q = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      const { env } = freshUserEnv(); // pick up an API key the user set after the app started
      const p = isScript
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${c.exe}" ${args.map(q).join(" ")}"`], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(c.exe, args, { cwd: dir, env, windowsHide: true });
      const timer = setTimeout(() => {
        execFile("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], () => {});
        done(false, "超时（240s）");
      }, 240000); // cloud CLIs retry on "server busy" before answering
      let finished = false;
      const done = (ok: boolean, e?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        resolve({ ok, text: extractAnswer(c, out).slice(-2000), error: e, durationSec: Math.round((Date.now() - started) / 100) / 10 });
      };
      p.stdout?.on("data", (d) => (out += d));
      p.stderr?.on("data", (d) => (err += d));
      p.on("error", (e) => done(false, e.message));
      p.on("close", (code) => done(code === 0, code === 0 ? undefined : `退出码 ${code}${err ? "：" + err.trim().slice(-400) : ""}`));
      p.stdin?.end(c.input === "stdin" ? prompt : "");
    });
  }
  return { ok: true, text: "内置智能体：请用环境检查和一次真实委派来验证。", durationSec: 0 };
}

/** Find Gemini CLI's node entry script (npm global install): returns node.exe + bundle/gemini.js, or null. */
function locateGemini(): { node: string; script: string } | null {
  const dirs: string[] = [];
  try {
    for (const p of execFileSync("where.exe", ["gemini.cmd"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)) if (p.trim()) dirs.push(path.dirname(p.trim()));
  } catch {
    /* not on PATH */
  }
  dirs.push(process.env.NVM_SYMLINK ?? "", "C:\\nvm4w\\nodejs", path.join(process.env.APPDATA ?? "", "npm"));
  for (const d of dirs) {
    if (!d) continue;
    const script = path.join(d, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    const node = existsSync(path.join(d, "node.exe")) ? path.join(d, "node.exe") : "node.exe";
    if (existsSync(script)) return { node, script };
  }
  return null;
}

/** Ready-made agent definitions for 设置 →「从模板添加」. The avatar is a bundled image (renderer side). */
function agentPresets(): { key: string; label: string; note: string; def: AgentDef | null }[] {
  const g = locateGemini();
  return [
    {
      key: "gemini",
      label: "Gemini CLI",
      note: g ? "需要用户环境变量 GEMINI_API_KEY（Google AI Studio 申请）" : "没找到 Gemini CLI：先运行 npm install -g @google/gemini-cli",
      def: g
        ? {
            id: "gemini",
            name: "Gemini",
            type: "cli",
            color: "#8E6CF0",
            role: "长上下文，适合通读整个项目、找 bug、代码审查第二意见、写文档；免费额度有限，不派大批量生成",
            canEdit: true,
            canRun: false,
            enabled: true,
            cli: {
              exe: g.node,
              args: `"${g.script}" -m gemini-3-flash-preview -p " " -o stream-json --approval-mode auto_edit --skip-trust`,
              input: "stdin",
              output: "jsonl",
              answerField: "content",
              healthCmd: `"${g.node}" -e "process.exit(process.env.GEMINI_API_KEY ? 0 : 1)"`,
              loginCmd: "explorer.exe https://aistudio.google.com/apikey",
            },
          }
        : null,
    },
    {
      key: "dafeiyu",
      label: "本地大肥鱼（llama.cpp 本地模型）",
      note: "OpenAI 兼容接口 http://127.0.0.1:18141/v1，不需要 Key",
      def: {
        id: "",
        name: "本地大肥鱼",
        type: "openai",
        color: "#4FB6D8",
        role: "本机运行的免费模型（DeepSeek V4.1-Flash 量化版，通过 OpenAI 兼容接口）：适合写文档、注释、简单函数和第二意见评审；速度较慢，不能直接改文件，由 Claude 落地。",
        canEdit: false,
        canRun: false,
        enabled: true,
        openai: { baseUrl: "http://127.0.0.1:18141/v1", model: "deepseek-v4.1-flash" },
      },
    },
  ];
}

let modelsCache: CodexModel[] | null = null;

/** Codex's own model catalog (`codex debug models`), visible models only. */
function codexModels(): Promise<CodexModel[]> {
  if (modelsCache) return Promise.resolve(modelsCache);
  const codex = safe(locateCodex);
  if (!codex) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(codex, ["debug", "models"], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(stdout);
        const list: any[] = Array.isArray(j) ? j : (j.models ?? []);
        modelsCache = list
          .filter((m) => m.visibility === "list")
          .map((m) => ({
            slug: String(m.slug),
            name: String(m.display_name ?? m.slug),
            description: String(m.description ?? ""),
            defaultEffort: String(m.default_reasoning_level ?? ""),
            efforts: (m.supported_reasoning_levels ?? []).map((l: any) => String(l.effort ?? l)).filter(Boolean),
          }));
        resolve(modelsCache);
      } catch {
        resolve([]);
      }
    });
  });
}

/** npm install (if needed) + npm run build in packages/bridge. */
function buildBridge(): Promise<{ ok: boolean; output: string }> {
  if (PACKAGED) return Promise.resolve({ ok: existsSync(BRIDGE), output: "安装版已内置 bridge" });
  const dir = path.join(ROOT, "packages", "bridge");
  const run = (args: string) =>
    new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args}`], { cwd: dir, windowsHide: true, timeout: 300000 }, (err, so, se) =>
        resolve({ ok: !err, output: `${so}\n${se}`.trim().slice(-3000) }),
      );
    });
  return (async () => {
    if (!existsSync(path.join(dir, "node_modules"))) {
      const r = await run("install --no-audit --no-fund");
      if (!r.ok) return r;
    }
    return run("run build");
  })();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: "#0f1115",
    title: APP_NAME,
    icon: path.join(app.getAppPath(), "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep rendering live progress even when the window is behind other windows.
      backgroundThrottling: false,
    },
  });
  // Window title shows the running build, e.g. "Claude 的工作室 v1.0.1" (or "… 开发版").
  const title = `${APP_NAME} v${app.getVersion()}${PACKAGED ? "" : " 开发版"}`;
  win.setTitle(title);
  win.on("page-title-updated", (e) => e.preventDefault());
  // Never open external pages inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function registerIpc() {
  ipcMain.handle("status", () => envStatus());
  ipcMain.handle("defaultWorkdir", () => DEFAULT_WORKDIR);
  ipcMain.handle("pickDir", async (_e, current?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择工作目录",
      defaultPath: current || DEFAULT_WORKDIR,
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle("listRuns", () => runs.list());
  ipcMain.handle("getRun", (_e, id: string) => {
    const meta = runs.meta(id);
    return meta ? { meta, events: runs.events(id) } : null;
  });
  ipcMain.handle("listProjects", () => projects.list());
  ipcMain.handle("listAgents", () => agents.all());
  ipcMain.handle("agentAvatars", () => Object.fromEntries(agents.all().map((a) => [a.id, agents.avatarDataUrl(a.id)]).filter(([, v]) => v)));
  ipcMain.handle("agentPresets", () => agentPresets());
  ipcMain.handle("getUpdate", () => updater.status);
  ipcMain.handle("checkUpdate", () => updater.check());
  ipcMain.handle("installUpdate", () => updater.install());
  ipcMain.handle("saveAgent", (_e, def: AgentDef, apiKey?: string | null) => agents.upsert(def, apiKey));
  ipcMain.handle("removeAgent", (_e, id: string) => agents.remove(id));
  ipcMain.handle("setAgentAvatar", (_e, id: string, png: string) => agents.setAvatar(id, png));
  ipcMain.handle("testAgent", (_e, def: AgentDef, apiKey?: string | null) => testAgent(def, apiKey));
  ipcMain.handle("pickImage", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "选择头像图片", properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const f = r.filePaths[0];
    const ext = path.extname(f).slice(1).toLowerCase().replace("jpg", "jpeg");
    return `data:image/${ext};base64,` + readFileSync(f).toString("base64");
  });
  ipcMain.handle("pickExecutable", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "选择可执行文件", properties: ["openFile"], filters: [{ name: "程序", extensions: ["exe", "cmd", "bat", "com"] }, { name: "全部", extensions: ["*"] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("getSettings", () => loadSettings());
  ipcMain.handle("saveSettings", (_e, s: Partial<Settings>) => saveSettings(s));
  ipcMain.handle("appInfo", () => ({ version: app.getVersion(), packaged: PACKAGED, userDir: USER_DIR, dataDir: DATA, runsDir: RUNS, resDir: PACKAGED ? process.resourcesPath : ROOT, electron: process.versions.electron }));
  ipcMain.handle("refreshBalance", () => quota.refreshDeepseek());
  ipcMain.handle("getBoard", (_e, pid: string) => readBoard(boardPath(pid)));
  ipcMain.handle("getActivity", () => runs.activity());
  ipcMain.handle("getQuota", () => quota.q);
  ipcMain.handle("getAuth", () => auth.info);
  ipcMain.handle("authAction", (_e, agent: string, action: "reopen" | "cancel" | "retry") => {
    if (action === "reopen") auth.reopen(agent);
    else if (action === "cancel") auth.cancel(agent);
    else if (action === "retry") auth.retry(agent);
  });
  ipcMain.handle("createProject", (_e, name: string, folder: string) => projects.create(name, folder));
  ipcMain.handle("renameProject", (_e, id: string, name: string) => projects.rename(id, name));
  ipcMain.handle("removeProject", (_e, id: string) => projects.remove(id));
  ipcMain.handle("createFolder", (_e, parent: string, name: string) => {
    if (!parent || !path.isAbsolute(parent) || !existsSync(parent)) throw new Error("请先选择一个已存在的上级文件夹");
    const clean = String(name ?? "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
    if (!clean) throw new Error("文件夹名称无效");
    const dir = path.join(parent, clean);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle("startRun", (_e, task: string, projectId: string, options?: Partial<RunOptions>, attachments?: Attachment[]) => {
    if (!task?.trim() && !attachments?.length) throw new Error("任务不能为空");
    task = String(task ?? "");
    const project = projects.get(projectId);
    if (!project || project.removed) throw new Error("请先选择一个项目");
    if (!existsSync(project.folder)) throw new Error(`项目文件夹不存在：${project.folder}`);
    const workdir = project.folder;
    const st = envStatus();
    if (!st.claude) throw new Error("找不到 Claude Code（claude.exe），无法开始。");
    if (!st.bridgeBuilt) throw new Error("bridge 还没编译，请先点上方提示里的「编译 bridge」。");
    return runs.start(task.trim(), workdir, project.id, cleanOptions(options), Array.isArray(attachments) ? attachments : []);
  });
  ipcMain.handle("setRunOptions", (_e, id: string, o: Partial<RunOptions>) => runs.setOptions(id, cleanOptions(o)));
  ipcMain.handle("stageFiles", (_e, paths: string[]) => stageFiles(Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle("stageBlob", (_e, name: string, mime: string, data: Uint8Array) => stageBlob(String(name ?? ""), String(mime ?? ""), data));
  ipcMain.handle("pickAttachments", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "选择要附加的文件", properties: ["openFile", "multiSelections"] });
    return r.canceled ? { files: [], errors: [] } : stageFiles(r.filePaths);
  });
  ipcMain.handle("attachmentPreview", (_e, p: string) => preview(p));
  ipcMain.handle("sandboxAccess", async (_e, projectId: string) => {
    const p = projects.get(projectId);
    if (!p) throw new Error("没有这个项目");
    return { folder: p.folder, ok: await hasFullControl(p.folder) };
  });
  ipcMain.handle("grantSandbox", async (_e, projectId: string) => {
    // Only a registered project's folder, never an arbitrary path from the renderer.
    const p = projects.get(projectId);
    if (!p || p.removed || !existsSync(p.folder)) throw new Error("项目文件夹不存在");
    return grantFullControl(p.folder);
  });
  ipcMain.handle("openRunLogs", (_e, id: string) => {
    const d = runs.runDir(id);
    if (existsSync(d)) shell.openPath(d);
  });
  ipcMain.handle("codexModels", () => codexModels());
  ipcMain.handle("buildBridge", () => buildBridge());
  ipcMain.handle("sendMessage", (_e, id: string, text: string, attachments?: Attachment[]) => runs.send(id, text, attachments));
  ipcMain.handle("stopRun", (_e, id: string) => runs.stop(id));
  ipcMain.handle("openPath", (_e, p: string) => {
    if (existsSync(p)) shell.openPath(p);
  });
}

/** Validate run options from the renderer; missing Claude choices (older renderer) fall back to 设置. */
function cleanOptions(options?: Partial<RunOptions>): RunOptions {
  const s = loadSettings();
  const opts: RunOptions = {
    splitSmall: !!options?.splitSmall,
    codexModel: String(options?.codexModel ?? ""),
    codexEffort: String(options?.codexEffort ?? ""),
    claudeModel: String(options?.claudeModel ?? s.claudeModel ?? "").trim(),
    claudeEffort: String(options?.claudeEffort ?? s.claudeEffort ?? ""),
  };
  if (opts.claudeModel && !/^[\w.\-:\[\]]+$/.test(opts.claudeModel)) throw new Error(`Claude 模型名称无效：${opts.claudeModel}`);
  if (opts.claudeEffort && !/^[a-z]+$/.test(opts.claudeEffort)) throw new Error(`Claude 思考等级无效：${opts.claudeEffort}`);
  if (opts.codexModel && !/^[\w.\-:]+$/.test(opts.codexModel)) throw new Error(`Codex 模型名称无效：${opts.codexModel}`);
  if (opts.codexEffort && !/^[a-z]+$/.test(opts.codexEffort)) throw new Error(`Codex 推理强度无效：${opts.codexEffort}`);
  return opts;
}

// ---------------------------------------------------------------- DeepSeek sandbox access
// dsh's Windows sandbox re-labels the workspace before running a command, which needs Full Control
// (WRITE_OWNER). Folders under the user profile have it; folders on other drives often only give
// "Modify" to Authenticated Users. Granting the signed-in user Full Control on the project folder fixes it.
const currentUser = () => `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;

function icacls(args: string[], timeoutMs = 300_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile("icacls.exe", args, { windowsHide: true, timeout: timeoutMs, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // icacls prints in the OEM code page; the parts we look at (user names, rights) are ASCII.
      const out = Buffer.concat([stdout as Buffer, stderr as Buffer]).toString("latin1");
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out });
    });
  });
}

async function hasFullControl(folder: string): Promise<boolean> {
  if (!existsSync(folder)) return false;
  const { code, out } = await icacls([folder], 20_000);
  if (code !== 0) return false;
  const user = (process.env.USERNAME ?? "").toLowerCase();
  return out
    .toLowerCase()
    .split(/\r?\n/)
    .some((l) => (l.includes(`\\${user}:`) || l.includes(` ${user}:`) || l.trimStart().startsWith(`${user}:`)) && /\(f\)/.test(l) && !/\(io\)/.test(l));
}

async function grantFullControl(folder: string): Promise<{ ok: boolean; output: string }> {
  const { code, out } = await icacls([folder, "/grant", `${currentUser()}:(OI)(CI)(F)`]);
  const ok = code === 0 && (await hasFullControl(folder));
  return { ok, output: ok ? `已授予：${currentUser()} 对 ${folder} 的完全控制权限` : `授予失败（${code}）：${out.trim().slice(0, 400)}` };
}

/**
 * Automation for screenshots / smoke tests:
 *   MAO_AUTORUN_TASK, MAO_AUTORUN_WORKDIR   start a run when the window is ready
 *   MAO_SCREENSHOT=<png path>                capture the window when that run ends
 *   MAO_AUTOQUIT=1                           quit after the capture
 */
/**
 * MAO_UI_SCRIPT=<js file>: run a script in the page that drives the real UI (clicks, typing) for demos/tests.
 * The script can print "__SHOT__:<png path>" to take a screenshot and "__QUIT__" to close the app.
 */
function uiScript() {
  const f = process.env.MAO_UI_SCRIPT;
  if (!f || !win || PACKAGED) return; // development builds only
  win.webContents.on("console-message", (_e: unknown, _level: number, message: string) => {
    if (message.startsWith("__SHOT__:")) capture(message.slice(9).trim());
    else if (message === "__QUIT__") setTimeout(() => app.quit(), 3000);
  });
  win.webContents.executeJavaScript(readFileSync(f, "utf8")).catch(() => {});
}

async function capture(shot: string) {
  if (!win) return;
  // An occluded window may not repaint; bring it to the front and force a repaint first.
  win.show();
  win.moveTop();
  win.focus();
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, img.toPNG());
}

function autorun() {
  uiScript();
  // MAO_SHOW_RUN=<run id|latest> + MAO_SCREENSHOT: open an existing run and capture it (no new task).
  const show = process.env.MAO_SHOW_RUN;
  if (show && win) {
    const id = show === "latest" ? runs.list().find((r) => r.status === "done")?.id : show;
    if (id) win.webContents.send("selectRun", id);
    const shot = process.env.MAO_SCREENSHOT;
    setTimeout(async () => {
      if (shot) await capture(shot);
      if (process.env.MAO_AUTOQUIT === "1") app.quit();
    }, 1500);
    return;
  }
  const task = process.env.MAO_AUTORUN_TASK;
  if (!task || !win) return;
  const workdir = process.env.MAO_AUTORUN_WORKDIR || DEFAULT_WORKDIR;
  mkdirSync(workdir, { recursive: true });
  const project = projects.findByFolder(workdir) ?? projects.create(process.env.MAO_AUTORUN_PROJECT || path.basename(workdir), workdir);
  const meta = runs.start(task, workdir, project.id, {
    splitSmall: process.env.MAO_AUTORUN_SPLIT === "1",
    codexModel: process.env.MAO_AUTORUN_CODEX_MODEL ?? "",
    codexEffort: process.env.MAO_AUTORUN_CODEX_EFFORT ?? "",
  });
  win.webContents.send("selectRun", meta.id);
  const shot = process.env.MAO_SCREENSHOT;
  // MAO_AUTORUN_TASK2: a second conversation in the same project, started MAO_AUTORUN_TASK2_DELAY seconds later.
  const task2 = process.env.MAO_AUTORUN_TASK2;
  const waitFor = new Set<string>([meta.id]);
  let focus = meta.id;
  if (task2) {
    setTimeout(() => {
      const m2 = runs.start(task2, workdir, project.id, { splitSmall: false, codexModel: process.env.MAO_AUTORUN_CODEX_MODEL ?? "", codexEffort: process.env.MAO_AUTORUN_CODEX_EFFORT ?? "" });
      waitFor.add(m2.id);
      focus = m2.id;
      win?.webContents.send("selectRun", m2.id);
    }, Number(process.env.MAO_AUTORUN_TASK2_DELAY ?? 20) * 1000);
    // MAO_SCREENSHOT_DECISION: capture shortly after the first priority decision is posted.
    const decisionShot = process.env.MAO_SCREENSHOT_DECISION;
    if (decisionShot) {
      const onNote = (id: string, ev: { k: string; kind?: string; mine?: boolean }) => {
        if (ev.k !== "note" || ev.kind !== "decision" || !ev.mine) return;
        runs.off("event", onNote);
        win?.webContents.send("selectRun", id);
        setTimeout(() => capture(decisionShot), 3000);
      };
      runs.on("event", onNote);
    }
  }
  const onEv = async (id: string, ev: { k: string }) => {
    if (!waitFor.has(id) || ev.k !== "exit") return;
    waitFor.delete(id);
    if (waitFor.size > 0 || (task2 && focus === meta.id)) return;
    runs.off("event", onEv);
    if (shot) {
      win?.webContents.send("selectRun", focus);
      await new Promise((r) => setTimeout(r, 1500));
      await capture(shot);
    }
    if (process.env.MAO_AUTOQUIT === "1") app.quit();
  };
  runs.on("event", onEv);
  // MAO_SCREENSHOT_LIVE: also capture once a worker has been busy for a while (shows live progress).
  const live = process.env.MAO_SCREENSHOT_LIVE;
  if (live) {
    let n = 0;
    const onWorker = (id: string, ev: { k: string }) => {
      if (id !== meta.id || ev.k !== "worker" || ++n < 6) return;
      runs.off("event", onWorker);
      setTimeout(() => capture(live), 4000);
    };
    runs.on("event", onWorker);
  }
  // MAO_SCREENSHOT_AT=<png> + MAO_SCREENSHOT_AT_SEC: capture at a fixed time after start.
  if (process.env.MAO_SCREENSHOT_AT) {
    const at = process.env.MAO_SCREENSHOT_AT;
    setTimeout(() => capture(at), Number(process.env.MAO_SCREENSHOT_AT_SEC ?? 30) * 1000);
  }
  const stopAfter = Number(process.env.MAO_AUTOSTOP_AFTER_SEC ?? 0);
  if (stopAfter > 0) setTimeout(() => runs.stop(meta.id), stopAfter * 1000);
}

/**
 * Watch every project's board: forward changes to the UI and drop new notes into the chats
 * of the conversations they are addressed to (only those that are running or directly addressed).
 */
function watchBoards() {
  const seen = new Map<string, { mtime: number; lastNoteAt: number }>();
  const tick = () => {
    for (const p of projects.list()) {
      const f = boardPath(p.id);
      let mtime = 0;
      try {
        mtime = statSync(f).mtimeMs;
      } catch {
        continue;
      }
      const s = seen.get(p.id);
      if (s && s.mtime === mtime) continue;
      const b = readBoard(f);
      const maxAt = b.notes.reduce((m, n) => Math.max(m, n.at), 0);
      if (s) {
        for (const n of b.notes.filter((n) => n.at > s.lastNoteAt)) {
          const fromTitle = n.from === "app" ? "系统" : (b.conversations[n.from]?.title ?? n.from);
          for (const r of runs.list()) {
            if (r.projectId !== p.id) continue;
            const mine = r.id === n.from;
            const addressed = n.to === r.id || (n.to === "all" && r.status === "running");
            if (mine || addressed) runs.pushExternal(r.id, { k: "note", from: n.from, fromTitle, to: n.to, kind: n.kind, text: n.text, mine });
          }
        }
      }
      seen.set(p.id, { mtime, lastNoteAt: Math.max(maxAt, s?.lastNoteAt ?? 0) });
      win?.webContents.send("boardChanged", p.id, b);
    }
  };
  tick();
  setInterval(tick, 1000);
}

/** Runs from before projects existed go into a project named 「测试」 (folder: sandbox). Logs stay where they are. */
function migrateLegacyRuns() {
  const orphans = runs.list().filter((r) => !r.projectId);
  if (!orphans.length) return;
  if (PACKAGED) return;
  const pid = projects.ensureLegacy("测试", path.join(ROOT, "sandbox"));
  for (const r of orphans) runs.setProject(r.id, pid);
}

app.whenReady().then(async () => {
  migrateRepoData();
  cleanStaging();
  agents = new AgentStore();
  const appSrv = await startAppServer(agents);
  agents.on("changed", (list) => win?.webContents.send("agentsChanged", list));
  runs = new RunManager({ agents: () => agents.all(), settings: loadSettings, agentsFile: AGENTS_FILE, appUrl: appSrv.url, appToken: appSrv.token });
  projects = new ProjectStore();
  migrateLegacyRuns();
  runs.on("event", (id, ev) => win?.webContents.send("runEvent", id, ev));
  runs.on("runs", (list) => win?.webContents.send("runsChanged", list));
  runs.on("activity", (a) => win?.webContents.send("activity", a));
  auth = new AuthManager();
  auth.findAgent = (id) => agents.get(id);
  auth.on("changed", (a) => win?.webContents.send("auth", a));
  runs.on("claudeAuthSuspect", () => auth.claudeMaybeLoggedOut());
  auth.checkAll();
  quota = new QuotaTracker();
  quota.on("changed", (q) => win?.webContents.send("quota", q));
  runs.on("claudeQuota", (info) => quota.fromClaudeEvent(info));
  runs.on("workerDone", (who: string) => (who === "codex" ? quota.refreshCodex() : quota.refreshDeepseek()));
  quota.seedClaudeFromLogs(runs.list().slice(0, 10).map((r) => path.join(runs.runDir(r.id), "claude.jsonl")));
  quota.refreshCodex();
  quota.refreshDeepseek();
  setInterval(() => quota.refreshCodex(), 10 * 60 * 1000);
  projects.on("changed", (list) => win?.webContents.send("projectsChanged", list));
  watchBoards();
  updater = new Updater();
  updater.on("changed", (s) => {
    win?.webContents.send("update", s);
    // Test hook: MAO_UPDATE_SHOT=<png> captures the window once an update is ready.
    if (s.state === "ready" && process.env.MAO_UPDATE_SHOT) setTimeout(() => capture(process.env.MAO_UPDATE_SHOT!), 1500);
  });
  registerIpc();
  createWindow();
  updater.start();
  win!.webContents.once("did-finish-load", () => setTimeout(autorun, 800));
});

app.on("before-quit", () => {
  runs?.stopAll();
  auth?.stopAll();
});
app.on("window-all-closed", () => app.quit());

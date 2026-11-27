// Runs `claude -p --output-format stream-json` in a workdir, parses its stream into
// normalized RunEvents, persists everything under logs/runs/<id>/ and notifies listeners.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Activity, Attachment, RunEvent, RunEventBody, RunMeta, RunOptions, Worker } from "../shared/types";
import { adopt, runAttachDir } from "./attachments";
import { claudeRule, cleanGrants, grantsPrompt } from "./grants";
import { ALLOWED_TOOLS, BRIDGE, CLAUDE_MD, ROOT, RUNS, boardPath, locateClaude } from "./paths";
import { WorkerTail } from "./workers";
import { withBoard, type ConvState } from "../../../../packages/bridge/src/board";
import type { AgentDef } from "../../../../packages/bridge/src/registry";
import type { Settings } from "../shared/types";

/** Update this conversation's entry on its project board (best effort). */
function updateBoard(meta: RunMeta, patch: (c: ConvState) => void) {
  if (!meta.projectId) return;
  try {
    withBoard(boardPath(meta.projectId), (b) => {
      const c = (b.conversations[meta.id] ??= {
        title: meta.title,
        goal: "",
        status: "running",
        planStep: "",
        claims: [],
        startedAt: meta.startedAt,
        updatedAt: Date.now(),
      });
      c.title = meta.title;
      patch(c);
      c.updatedAt = Date.now();
    });
  } catch {
    /* the board is advisory; never break a run because of it */
  }
}

const COLLAB_RULES = `
[同项目协作] 这个项目里可能有其他对话同时在工作（它们都在同一个文件夹）。你有这些工具：project_status、claim_files、release_files、wait_for_files、post_note、read_notes。规则：
1. 开始时先调用 project_status，看其他对话在做什么、占用了哪些文件。
2. 自己改文件或委派给 Codex/DeepSeek 之前，先 claim_files 你要动的文件（可以用 src/** 这样的通配）。委派的 task 里写明只允许改哪些文件。
3. 如果需要的文件被别的对话占用，由你判断优先级（紧急程度、依赖关系、谁先开始、对方进度），三选一：
   a) wait_for_files 排队等对方释放（界面会显示“等待”，释放后自动继续）；
   b) 先做不冲突的部分；
   c) post_note 给对方协商或请求交接。
   无论哪种，都用 post_note(to="all", kind="decision") 写下决定和理由，格式如：「判定：<对话A> 优先，因为…；我先…」。同时在给用户的回复里单独写一行：优先级决定：…
4. 委派结果里出现 🚩 CONFLICT 时必须处理（检查、必要时撤销或合并，并通知对方）。
5. 收到 📨 新消息时要考虑并在需要时回复。
6. 结束前 release_files 释放所有占用。`;

const SPLIT_RULE = `
[拆小任务] 用户要求把 Codex 的工作拆小：
- 每次委派给 Codex 只做一个小单元（一个模块/一个文件/一组紧密相关的函数），目标是几分钟内完成；
- 每个单元回来后先审查、跑相关测试，确认通过再委派下一个单元；
- 宁可多委派几次，也不要一次把整个项目交给 Codex。`;

/** Supplied by index.ts: registry, settings and the local app endpoint for API agents. */
export interface RunContext {
  agents: () => AgentDef[];
  settings: () => Settings;
  agentsFile: string;
  appUrl: string;
  appToken: string;
}

/** Team roster for the lead, built from the registry at spawn time (so CLAUDE.md never needs editing). */
function teamRoster(agents: AgentDef[], dshCommands: boolean): string {
  const on = agents.filter((a) => a.enabled).map((a) => (a.builtin === "deepseek" && !dshCommands ? { ...a, canRun: false } : a));
  if (!on.length) return "";
  const lines = on.map((a) => {
    const how = a.builtin === "codex" ? "工具 delegate_to_codex（或 delegate_to_agent）" : a.builtin === "deepseek" ? "工具 delegate_to_deepseek（或 delegate_to_agent）" : `工具 delegate_to_agent，agentId="${a.id}"`;
    const can = a.type === "openai" ? "只返回文字/代码，不能改文件、不能运行命令（由你落地并验证）" : `${a.canEdit ? "能改文件" : "不能改文件"}、${a.canRun ? "能运行命令" : "不能运行命令"}`;
    return `- ${a.name}（id: ${a.id}）：${a.role || "通用"}；${can}；调用：${how}`;
  });
  return `\n[团队成员] 下面是用户当前启用的执行者，按各自擅长分派（CLAUDE.md 里的分工规则同样适用于新增成员）：\n${lines.join("\n")}`;
}

const GUI_RULES = `
[界面约定] 每审查完一个委派结果（读完改动、跑完相关测试）后，单独输出一行：
审查结论：通过
或
审查结论：需返工 — <一句话原因>
界面会把这一行显示在对应的分工卡片上。

[命令规则] 你在 dontAsk 权限模式下，只有白名单里的简单命令能执行（npm / npx / node / git status / git diff / Get-ChildItem / Get-Content 等）。
- 每次 Bash/PowerShell 调用只写一条命令；不要用 ; && || 管道 | 、if ($?)、$LASTEXITCODE、$env: 赋值、heredoc，这些会被直接拒绝。
- 创建或修改文件用 Write / Edit 工具，不要用 shell 写文件。
- 想知道退出码就单独运行那条命令，工具结果里会显示是否出错。`;

const STEER_RULES = `
[任务中引导] 用户可以在你工作时发消息引导你（消息以「[任务中引导]」开头，在你当前这一步完成后送到）。收到后：
- 先重新规划：引导优先于原计划；它改变了需求就按新需求做，不要把原计划做完再说。
- 正在后台运行的委派（工具结果里的 DETACHED 提示）：引导让它过时 → cancel_delegation 取消，检查它已经改过的文件，再按新要求重新委派；不受影响 → wait_delegation 继续等。已经完成的委派如果被引导推翻，同样要返工。
- 在你的下一段回复里先用一两句话确认你收到了什么、计划怎么调整。
- 本轮结束前，后台委派必须都等完或取消。
- 「[打断并改向]」表示用户中途停止了你上一轮的工作：上一轮可能只做了一半（文件可能改了一部分，委派已被终止），先检查现状再按新要求继续。`;

const STEER_LIVE = "[任务中引导] 用户在你工作时发来补充 / 纠正：\n";
const STEER_QUEUED = "[任务中引导] 用户在你上一轮工作时发来的补充（上一轮已结束才送达）：\n";
const STEER_REDIRECT = "[打断并改向] 用户打断了你上一轮的工作（已在中途停止），要求改为：\n";

const ATTACH_RULES = `
[附件] 用户可能在消息里附带图片或文件。它们保存在下面的附件文件夹里（应用数据目录，不在项目文件夹里），你可以用 Read 读取（含图片、PDF）。
- 不要修改或删除附件；需要把附件放进项目时，先问用户或在回复里说明。
- 委派时如果执行者需要附件：在 task 里写明附件的绝对路径。Codex 和 DeepSeek 能读这个文件夹；给 Codex 看图片时把图片路径放进 delegate_to_codex 的 images 参数。
- 其他智能体（API 类、其他命令行工具）不一定能读到这个文件夹：把它们需要的内容（文字、你对图片的描述）直接写进 task。`;

const DSH_RULES = `
[DeepSeek 跑命令] DeepSeek 可以在 Windows 沙箱里运行命令（只能写工作目录和附件文件夹），每条命令都经过监管：
- 委派结果末尾的 "commands run" 列出了它跑的每条命令：✓ allow 正常、❓ review 需要你复查（联网、安装、工作目录以外的路径等）、⛔ block 已拦截（DeepSeek 当场被终止）。
- 审查每个 DeepSeek 结果时必须看这份命令清单；发现可疑命令（哪怕是 ✓/❓）要在回复里单独一行告诉用户：「⚠ DeepSeek 命令提醒：…」。
- DeepSeek 的沙箱不允许带 IPC 的子进程（fork）：node 自带测试要用 \`node --test --experimental-test-isolation=none\`；jest / vitest 等测试框架在它那里可能报 spawn EPERM，这时由你来跑测试。
- 被拦截的命令不要换个方式再跑（不要自己跑、也不要让别的执行者跑）；确实需要时先问用户。
- 结果里出现 SANDBOX_ACL 表示这个项目文件夹还没给 DeepSeek 的沙箱授权：告诉用户在 DeepSeek 卡片上点「授予 DeepSeek 沙箱权限」，在那之前需要跑命令的步骤交给 Codex 或你自己。`;

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function killTree(pid?: number) {
  if (pid) execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}

function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const short = name.replace(/^mcp__[^_]+__/, "");
  if (short === "post_note") return clip(`→ ${input.to === "all" ? "所有对话" : input.to}${input.kind === "decision" ? "（判定）" : ""}：${input.text ?? ""}`, 200);
  if (short === "claim_files" || short === "wait_for_files") return clip(`${(input.paths ?? []).join(", ")}${input.reason ? ` — ${input.reason}` : ""}`, 200);
  if (short === "release_files") return input.paths?.length ? input.paths.join(", ") : "全部";
  if (short === "project_status" || short === "read_notes") return "";
  if (input.command) return clip(String(input.command), 160);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.query) return String(input.query);
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} 项待办`;
  return clip(JSON.stringify(input), 120);
}

function resultText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return "";
}

/** Parse the text block the bridge returns (see packages/bridge/src/agents.ts formatResult). */
function parseDelegateResult(text: string) {
  const head = text.match(/^agent:\s*(\S+)\s+status:\s*(\w+)\s+duration:\s*([\d.]+)s/m);
  const tok = text.match(/^tokens:\s*(\{.*\})/m);
  let tokens: number | undefined;
  if (tok) {
    try {
      const u = JSON.parse(tok[1]);
      tokens = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    } catch {
      /* ignore */
    }
  }
  const files: string[] = [];
  const fsec = text.match(/^files changed \(\d+\):\n((?:  [+~-] .*\n?)*)/m);
  if (fsec) for (const l of fsec[1].split("\n")) if (l.trim()) files.push(l.trim());
  const errs = text.match(/^errors:\n((?:  .*\n?)*)/m);
  const answer = text.split("----- final answer -----")[1]?.trim() ?? "";
  const bridgeErr = text.startsWith("bridge error:") ? text : undefined;
  const model = text.match(/^model:\s*(.+)$/m)?.[1]?.trim();
  return {
    status: head?.[2] ?? (bridgeErr ? "error" : "unknown"),
    durationSec: head ? Number(head[3]) : undefined,
    tokens,
    files,
    error: bridgeErr ?? errs?.[1]?.trim(),
    answer,
    ...(model ? { model } : {}),
  };
}

interface Active {
  child: ChildProcess;
  stopped: boolean;
  /** stdin still open: more user messages can go straight into the running turn */
  open: boolean;
  /** user messages written to stdin and not yet echoed back by claude (null = the turn's own message) */
  unacked: ({ text: string; files: Attachment[]; sid: string } | null)[];
  /** steering messages to send as the next turn once this process has exited */
  after: { text: string; files: Attachment[]; sid: string }[];
  /** the process was stopped to deliver `after` right away (打断并改向) */
  redirect: boolean;
}

interface SteerTurn {
  sids: string[];
  redirect: boolean;
}

export class RunManager extends EventEmitter {
  private active = new Map<string, Active>();
  /** per running conversation: how many delegations each worker is busy with */
  private busy = new Map<string, Record<string, number>>();

  /** Who is working right now, across all runs (drives the presence avatars). */
  activity(): Activity {
    const a: Activity = { claude: this.active.size };
    for (const b of this.busy.values()) for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
    return a;
  }

  private bump(id: string, who: Worker | null, d: number) {
    const b = this.busy.get(id) ?? {};
    if (who) b[who] = Math.max(0, (b[who] ?? 0) + d);
    this.busy.set(id, b);
    this.emit("activity", this.activity());
  }
  private seqs = new Map<string, number>();
  private metas = new Map<string, RunMeta>();

  constructor(private ctx: RunContext) {
    super();
    mkdirSync(RUNS, { recursive: true });
    // Runs that were "running" when the app last closed are interrupted.
    for (const m of this.list())
      if (m.status === "running") {
        this.saveMeta({ ...m, status: "interrupted" });
        updateBoard(m, (c) => {
          c.status = "interrupted";
          c.claims = [];
          delete c.waitingFor;
        });
      }
  }

  private dir(id: string) {
    return path.join(RUNS, id);
  }

  list(): RunMeta[] {
    const out: RunMeta[] = [];
    for (const id of existsSync(RUNS) ? readdirSync(RUNS) : []) {
      const m = this.meta(id);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  meta(id: string): RunMeta | null {
    const cached = this.metas.get(id);
    if (cached) return cached;
    const f = path.join(this.dir(id), "meta.json");
    if (!existsSync(f)) return null;
    try {
      const m = JSON.parse(readFileSync(f, "utf8")) as RunMeta;
      this.metas.set(id, m);
      return m;
    } catch {
      return null;
    }
  }

  private saveMeta(m: RunMeta) {
    this.metas.set(m.id, m);
    writeFileSync(path.join(this.dir(m.id), "meta.json"), JSON.stringify(m, null, 2));
    this.emit("runs", this.list());
  }

  events(id: string): RunEvent[] {
    const f = path.join(this.dir(id), "events.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEvent);
  }

  /** Append an event to a run from outside its claude process (e.g. a note from another conversation). */
  pushExternal(id: string, body: RunEventBody) {
    if (this.meta(id)) this.push(id, body);
  }

  private push(id: string, body: RunEventBody) {
    if (!this.seqs.has(id)) this.seqs.set(id, this.events(id).length);
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    const ev = { ...body, seq, t: Date.now() } as RunEvent;
    appendFileSync(path.join(this.dir(id), "events.jsonl"), JSON.stringify(ev) + "\n");
    this.emit("event", id, ev);
  }

  isRunning(id: string) {
    return this.active.has(id);
  }

  runDir(id: string) {
    return this.dir(id);
  }

  /** Link an existing run to a project (used to migrate runs from before projects existed). */
  setProject(id: string, projectId: string) {
    const m = this.meta(id);
    if (m && m.projectId !== projectId) this.saveMeta({ ...m, projectId });
  }

  start(task: string, workdir: string, projectId: string, options: RunOptions, attachments?: Attachment[]): RunMeta {
    const id = newId();
    mkdirSync(this.dir(id), { recursive: true });
    mkdirSync(workdir, { recursive: true });
    const meta: RunMeta = { id, title: clip(task || `附件：${(attachments ?? []).map((a) => a.name).join("、")}`, 60), workdir, projectId, options, startedAt: Date.now(), status: "running" };
    this.saveMeta(meta);
    this.spawnClaude(id, task, true, adopt(id, attachments));
    return meta;
  }

  /** Follow-up message in the same conversation (claude --resume). */
  send(id: string, text: string, attachments?: Attachment[]) {
    const m = this.meta(id);
    if (!m) throw new Error("没有这个任务");
    if (this.active.has(id)) throw new Error("任务仍在运行，请等它结束或先停止");
    if (!m.sessionId) throw new Error("这个任务没有可继续的会话");
    if (!text.trim() && !attachments?.length) throw new Error("消息不能为空");
    this.saveMeta({ ...m, status: "running", endedAt: undefined });
    this.spawnClaude(id, text, false, adopt(id, attachments));
  }

  /** Options for the next turns of a conversation (model / effort switched mid-conversation). */
  setOptions(id: string, options: RunOptions) {
    const m = this.meta(id);
    if (!m) throw new Error("没有这个对话");
    this.saveMeta({ ...m, options });
  }

  /**
   * A message while Claude is working.
   * steer: written into the running turn (claude reads it after its current step);
   *        if the turn is already finishing it is sent as the next turn instead.
   * redirect: stop the current turn now and resume the conversation with this message.
   */
  steer(id: string, text: string, attachments: Attachment[] | undefined, mode: "steer" | "redirect") {
    const m = this.meta(id);
    if (!m) throw new Error("没有这个对话");
    if (!text.trim() && !attachments?.length) throw new Error("消息不能为空");
    const a = this.active.get(id);
    if (!a) {
      // It finished in the meantime: an ordinary follow-up.
      if (m.sessionId) return this.send(id, text, attachments);
      throw new Error("任务已经结束");
    }
    const files = adopt(id, attachments);
    const sid = newId();
    const att = files.length ? { attachments: files } : {};
    if (mode === "steer" && a.open && !a.stopped) {
      this.push(id, { k: "user", text, ...att, steer: "live", sid });
      a.unacked.push({ text, files, sid });
      a.child.stdin!.write(this.userMessage(STEER_LIVE + (text.trim() || "（见附件）"), files), "utf8");
      // Tell the bridge: a delegation that is still running hands control back so Claude sees this now.
      const f = path.join(this.dir(id), "steer.json");
      let seq = 0;
      try {
        seq = Number(JSON.parse(readFileSync(f, "utf8")).seq) || 0;
      } catch {
        /* first steer */
      }
      writeFileSync(f, JSON.stringify({ seq: seq + 1, at: Date.now() }));
      return;
    }
    this.push(id, { k: "user", text, ...att, steer: mode === "redirect" ? "redirect" : "queued", sid });
    a.after.push({ text, files, sid });
    if (mode === "redirect" && !a.stopped) {
      a.redirect = true;
      this.stop(id);
    }
  }

  /** One stream-json user message: images as image blocks, then the text (with the attachment list). */
  private userMessage(text: string, files: Attachment[]): string {
    const images = files.filter((f) => f.image);
    const note = files.length
      ? `\n\n[附件] 用户随这条消息附带了 ${files.length} 个文件（已复制到应用的附件文件夹，不在项目里）${images.length ? "；图片已直接附在这条消息里" : ""}：\n` +
        files.map((f) => `- ${f.name}（${fmtSize(f.size)}${f.image ? "，图片" : ""}）：${f.path}`).join("\n") +
        (files.some((f) => !f.image) ? "\n需要时用 Read 工具读取这些文件（PDF 也可以直接 Read）。" : "")
      : "";
    const content: any[] = [];
    for (const f of images) {
      try {
        content.push({ type: "image", source: { type: "base64", media_type: f.mime, data: readFileSync(f.path).toString("base64") } });
      } catch {
        /* unreadable now: the path in the text still points at it */
      }
    }
    content.push({ type: "text", text: text + note });
    return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  }

  stop(id: string) {
    const a = this.active.get(id);
    if (!a) return;
    a.stopped = true;
    killTree(a.child.pid);
  }

  stopAll() {
    for (const id of this.active.keys()) this.stop(id);
  }

  private spawnClaude(id: string, text: string, first: boolean, files: Attachment[] = [], steer?: SteerTurn) {
    const meta = this.meta(id)!;
    const claude = locateClaude();
    // Steering messages were shown when the user sent them; now they are delivered.
    if (steer) for (const sid of steer.sids) this.push(id, { k: "steer_ack", sid });
    else this.push(id, files.length ? { k: "user", text, attachments: files } : { k: "user", text });
    if (!claude) {
      this.push(id, { k: "stderr", text: "找不到 claude.exe。请确认 Claude Code 已安装，或设置环境变量 CLAUDE_PATH。" });
      this.push(id, { k: "exit", code: null, stopped: false });
      this.saveMeta({ ...meta, status: "failed", endedAt: Date.now() });
      return;
    }
    const runDir = this.dir(id);
    const attDir = runAttachDir(id);
    // Paths attached in place (re-checked: one may have been deleted, or be refused by now).
    const grants = cleanGrants(meta.options?.paths);
    // Always readable: a steering message sent mid-turn may bring the first attachments.
    mkdirSync(attDir, { recursive: true });
    // Per-run MCP config: absolute bridge path, worker logs go into this run's folder.
    const mcpFile = path.join(runDir, "mcp.json");
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          "mao-bridge": {
            type: "stdio",
            // Run the bridge with Electron's own Node runtime: no separate Node install needed.
            command: process.execPath,
            args: [BRIDGE],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              MAO_LOG_DIR: runDir,
              MAO_AUTH_DIR: process.env.MAO_AUTH_DIR ?? "",
              ...(process.env.MAO_SIM_CODEX_LOGGED_OUT ? { MAO_SIM_CODEX_LOGGED_OUT: process.env.MAO_SIM_CODEX_LOGGED_OUT } : {}),
              // test override (env) wins over the setting
              MAO_LOGIN_WAIT_SEC: process.env.MAO_LOGIN_WAIT_SEC || String(this.ctx.settings().loginWaitSec),
              ...(meta.projectId
                ? { MAO_BOARD_PATH: boardPath(meta.projectId), MAO_PROJECT_DIR: meta.workdir, MAO_CONVERSATION_ID: meta.id }
                : {}),
              MAO_DEFAULT_TIMEOUT_SEC: String(this.ctx.settings().delegateTimeoutSec),
              MAO_AGENTS_PATH: this.ctx.agentsFile,
              MAO_APP_URL: this.ctx.appUrl,
              MAO_APP_TOKEN: this.ctx.appToken,
              ...(meta.options?.codexModel ? { MAO_CODEX_MODEL: meta.options.codexModel } : {}),
              ...(meta.options?.codexEffort ? { MAO_CODEX_EFFORT: meta.options.codexEffort } : {}),
              ...(existsSync(attDir) ? { MAO_ATTACH_DIR: attDir } : {}),
              MAO_DSH_COMMANDS: this.ctx.settings().dshCommands === false ? "0" : "1",
              ...(grants.length ? { MAO_PATH_GRANTS: JSON.stringify(grants) } : {}),
            },
          },
        },
      }),
    );
    const allowed: string[] = JSON.parse(readFileSync(ALLOWED_TOOLS, "utf8"));
    // stream-json in both directions: stdin stays open for steering messages; claude echoes each
    // user message back (--replay-user-messages) when it actually reads it.
    const args = ["-p", "--input-format", "stream-json", "--replay-user-messages", "--output-format", "stream-json", "--verbose", "--mcp-config", mcpFile, "--strict-mcp-config", "--permission-mode", "dontAsk", "--allowedTools", ...allowed];
    // Attached paths: readable (Read/Glob/Grep rules); read-only ones also get Edit/Write denied (deny wins).
    for (const g of grants) args.push(`Read(${claudeRule(g)})`);
    const deny = grants.filter((g) => !g.write).flatMap((g) => [`Edit(${claudeRule(g)})`, `Write(${claudeRule(g)})`]);
    if (deny.length) args.push("--disallowedTools", ...deny);
    if (!first && meta.sessionId) args.push("--resume", meta.sessionId);
    // Per-conversation choice (composer), else 设置 (conversations from before 1.1.1 have no choice stored).
    const st = this.ctx.settings();
    const o = meta.options;
    const model = o && o.claudeModel !== undefined ? o.claudeModel : st.claudeModel;
    const effort = o && o.claudeEffort !== undefined ? o.claudeEffort : st.claudeEffort;
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Earlier and current attachments of this conversation are readable (Read tool) on every turn.
    if (existsSync(attDir)) args.push("--add-dir", attDir);

    const inRepo = (path.resolve(meta.workdir) + path.sep).toLowerCase().startsWith((path.resolve(ROOT) + path.sep).toLowerCase());
    let sys = GUI_RULES + STEER_RULES + teamRoster(this.ctx.agents(), st.dshCommands !== false);
    if (st.dshCommands !== false) sys += "\n" + DSH_RULES;
    if (meta.projectId) sys += "\n" + COLLAB_RULES + `\n你的对话编号：${meta.id}`;
    if (meta.options?.splitSmall) sys += "\n" + SPLIT_RULE;
    sys += grantsPrompt(grants);
    sys += "\n[模型] 每个智能体的默认模型由用户在设置里选定；委派时不要传 model 参数，除非用户在对话里明确要求某个模型。";
    if (meta.options?.codexModel || meta.options?.codexEffort)
      sys += `\n[Codex 设置] 用户已为 Codex 选定模型 ${meta.options.codexModel || "默认"}、推理强度 ${meta.options.codexEffort || "默认"}；调用 delegate_to_codex 时不要传 model / reasoningEffort 参数。`;
    if (existsSync(attDir)) sys += "\n" + ATTACH_RULES + `\n本对话的附件文件夹：${attDir}`;
    if (!inRepo) sys = readFileSync(CLAUDE_MD, "utf8") + "\n" + sys;
    args.push("--append-system-prompt", sys);

    const body = (steer ? (steer.redirect ? STEER_REDIRECT : STEER_QUEUED) : "") + (text.trim() || "（见附件）");
    const prompt = first
      ? `${body}\n\n工作目录（所有文件都放在这里；委派时 cwd 一律用这个绝对路径）：${meta.workdir}\n请按 CLAUDE.md 的分工规则执行：先规划，再委派给 Codex / DeepSeek，逐个审查结果并运行测试，最后给出分工总结。`
      : body;
    const stdinText = this.userMessage(prompt, files);

    const child = spawn(claude, args, {
      cwd: meta.workdir,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String((this.ctx.settings().delegateTimeoutSec + this.ctx.settings().loginWaitSec + 120) * 1000), MCP_TIMEOUT: "60000" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const act: Active = { child, stopped: false, open: true, unacked: [null], after: [], redirect: false };
    this.active.set(id, act);
    this.bump(id, null, 0);
    updateBoard(meta, (c) => {
      c.status = "running";
      if (!c.goal) c.goal = clip(text, 240);
      c.planStep = first ? "规划中" : `继续：${clip(text, 80)}`;
    });
    let lastPlanAt = 0;
    const rawLog = path.join(runDir, "claude.jsonl");
    const delegates = new Map<string, Worker>();
    // Delegations whose worker log has not been matched yet (tool_use id -> who/task).
    const pending = new Map<string, { who: Worker; task: string }>();
    const tail = new WorkerTail(
      runDir,
      (body) => this.push(id, body),
      (who, task) => {
        for (const [tid, p] of pending) {
          if (p.who === who && p.task.trim() === task.trim()) {
            pending.delete(tid);
            return tid;
          }
        }
        return undefined;
      },
    );
    tail.start();
    let buf = "";
    let gotResult = false;
    let lastResultText = "";
    let closeTimer: NodeJS.Timeout | undefined;
    // bridge delegation id (d3) -> tool_use id of its card, for delegations moved to the background
    const background = new Map<string, string>();
    const finishDelegate = (tid: string, who: Worker, txt: string, isError: boolean) => {
      const r = parseDelegateResult(txt);
      this.bump(id, who, -1);
      const m = this.meta(id)!;
      this.saveMeta({ ...m, tokens: { ...m.tokens, [who]: (m.tokens?.[who] ?? 0) + (r.tokens ?? 0) } });
      this.emit("workerDone", who);
      this.push(id, { k: "delegate_result", id: tid, who, ok: !isError && r.status === "completed", ...r });
    };

    const onLine = (line: string) => {
      if (!line.trim()) return;
      appendFileSync(rawLog, line + "\n");
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        this.push(id, { k: "stderr", text: line });
        return;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        const mcp = (ev.mcp_servers ?? []).map((s: any) => `${s.name}=${s.status}`).join(", ");
        this.push(id, { k: "init", model: ev.model ?? "", mcp, sessionId: ev.session_id ?? "" });
        if (ev.session_id) this.saveMeta({ ...this.meta(id)!, sessionId: ev.session_id });
      } else if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) {
            this.push(id, { k: "text", text: c.text });
            if (Date.now() - lastPlanAt > 1500) {
              lastPlanAt = Date.now();
              const firstLine = c.text.split("\n").map((s: string) => s.replace(/^[#*\->\s]+/, "").trim()).find(Boolean) ?? "";
              updateBoard(meta, (b) => (b.planStep = clip(firstLine, 120)));
            }
            for (const m of c.text.matchAll(/审查结论[:：][ \t]*(通过|需返工|不通过)[ \t]*[—\-–:：]?[ \t]*(.*)/g)) {
              this.push(id, { k: "verdict", pass: m[1] === "通过", text: (m[2] ?? "").trim() });
            }
          } else if (c.type === "tool_use") {
            const name: string = c.name ?? "";
            const who: Worker | null = name.endsWith("delegate_to_codex")
              ? "codex"
              : name.endsWith("delegate_to_deepseek")
                ? "deepseek"
                : name.endsWith("delegate_to_agent") && c.input?.agentId
                  ? String(c.input.agentId)
                  : null;
            if (who) {
              updateBoard(meta, (b) => (b.planStep = `委派给 ${who === "codex" ? "Codex" : "DeepSeek"}：${clip(String(c.input?.task ?? ""), 80)}`));
              delegates.set(c.id, who);
              this.bump(id, who, +1);
              pending.set(c.id, { who, task: String(c.input?.task ?? "") });
              this.push(id, { k: "delegate", id: c.id, who, task: String(c.input?.task ?? ""), mode: c.input?.mode });
            } else if (name !== "ToolSearch") {
              this.push(id, { k: "tool", id: c.id, name, summary: toolSummary(name, c.input) });
            }
          }
        }
      } else if (ev.type === "user" && ev.isReplay) {
        // claude has read one of our stdin messages (in order).
        const u = act.unacked.shift();
        if (u) this.push(id, { k: "steer_ack", sid: u.sid });
        clearTimeout(closeTimer);
      } else if (ev.type === "user") {
        for (const c of ev.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const txt = resultText(c.content);
          const who = delegates.get(c.tool_use_id);
          // A delegation moved to the background so Claude could read a steering message.
          const det = who ? txt.match(/^DETACHED delegation: (d\d+)/) : null;
          if (det) {
            background.set(det[1], c.tool_use_id);
            this.push(id, { k: "delegate_detached", id: c.tool_use_id, bg: det[1] });
            continue;
          }
          // Its final result, returned later by wait_delegation / cancel_delegation.
          const late = !who ? txt.match(/(?:^|\n)delegation: (d\d+)\nagent:/) : null;
          const lateId = late ? background.get(late[1]) : undefined;
          if (lateId) {
            background.delete(late![1]);
            this.push(id, { k: "tool_result", id: c.tool_use_id, isError: !!c.is_error && !/status: cancelled/.test(txt), preview: clip(txt, 300) });
            finishDelegate(lateId, delegates.get(lateId)!, txt.slice(txt.indexOf("agent:")), !!c.is_error);
          } else if (who) {
            finishDelegate(c.tool_use_id, who, txt, !!c.is_error);
          } else if (txt || c.is_error) {
            this.push(id, { k: "tool_result", id: c.tool_use_id, isError: !!c.is_error, preview: clip(txt, 300) });
          }
        }
      } else if (ev.type === "rate_limit_event") {
        this.emit("claudeQuota", ev.rate_limit_info);
      } else if (ev.type === "result") {
        gotResult = true;
        if (ev.is_error) lastResultText = String(ev.result ?? "");
        const u = ev.usage ?? {};
        const turnTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
        this.push(id, {
          k: "result",
          ok: !ev.is_error && ev.subtype === "success",
          costUsd: ev.total_cost_usd,
          durationSec: ev.duration_ms ? Math.round(ev.duration_ms / 1000) : undefined,
          turns: ev.num_turns,
          text: String(ev.result ?? ""),
          outputTokens: ev.usage?.output_tokens,
          tokens: turnTokens,
        });
        const m = this.meta(id)!;
        this.saveMeta({ ...m, costUsd: (m.costUsd ?? 0) + (ev.total_cost_usd ?? 0), tokens: { ...m.tokens, claude: (m.tokens?.claude ?? 0) + turnTokens } });
        // Turn over. Nothing unread on stdin → close it so claude exits. Otherwise claude starts
        // another turn with the unread message (its echo cancels the fallback below).
        if (!act.unacked.length) closeStdin();
        else closeTimer = setTimeout(closeStdin, 20_000);
      }
    };
    const closeStdin = () => {
      if (!act.open) return;
      act.open = false;
      // Never read by claude: deliver as the next turn instead.
      for (const u of act.unacked.splice(0)) if (u) act.after.push(u);
      child.stdin!.end();
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      appendFileSync(path.join(runDir, "claude.stderr.log"), d);
      const t = d.trim();
      if (t) this.push(id, { k: "stderr", text: clip(t, 500) });
    });
    child.on("error", (e) => this.push(id, { k: "stderr", text: `启动 claude 失败：${e.message}` }));
    child.on("close", (code) => {
      if (buf) onLine(buf);
      tail.stop();
      this.active.delete(id);
      this.busy.delete(id);
      this.emit("activity", this.activity());
      this.push(id, { k: "exit", code, stopped: act.stopped, ...(act.redirect ? { redirect: true } : {}) });
      const status = act.stopped ? "stopped" : code === 0 && gotResult ? "done" : "failed";
      if (status === "failed") {
        let errText = "";
        try {
          errText = readFileSync(path.join(runDir, "claude.stderr.log"), "utf8").slice(-4000);
        } catch {
          /* no stderr */
        }
        if (/log ?in|auth|401|unauthori[sz]ed|oauth|expired/i.test(errText + lastResultText)) this.emit("claudeAuthSuspect", id);
      }
      this.saveMeta({ ...this.meta(id)!, status, endedAt: Date.now() });
      // A finished conversation must not keep blocking others: release whatever it still claims.
      updateBoard(meta, (c) => {
        c.status = status;
        c.claims = [];
        delete c.waitingFor;
        c.planStep = status === "done" ? "已完成" : status === "stopped" ? "已停止" : "已失败";
      });
      // Steering messages that did not get into this process: deliver them as the next turn
      // (unless the user stopped the task outright).
      clearTimeout(closeTimer);
      for (const u of act.unacked.splice(0)) if (u) act.after.push(u);
      const next = act.after.splice(0);
      const sessionId = this.meta(id)!.sessionId;
      if (next.length && (!act.stopped || act.redirect)) {
        if (!sessionId) {
          this.push(id, { k: "stderr", text: "引导消息没能送达：这个对话还没有可继续的会话。请重新发送。" });
          return;
        }
        this.saveMeta({ ...this.meta(id)!, status: "running", endedAt: undefined });
        this.spawnClaude(
          id,
          next.map((n) => n.text.trim()).filter(Boolean).join("\n\n"),
          false,
          next.flatMap((n) => n.files),
          { sids: next.map((n) => n.sid), redirect: act.redirect },
        );
      }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.write(stdinText, "utf8");
  }
}

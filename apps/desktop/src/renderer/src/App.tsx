import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { Activity, AgentDef, Attachment, AuthInfo, Settings, StageResult, Board, CodexModel, EnvStatus, MaoApi, Project, Quota, RunEvent, RunMeta, RunOptions, SubQuota, UpdateStatus } from "../../shared/types";
import { SettingsPage } from "./Settings";
import { ACT_ICON, AGENT_ORDER, EFFORT_TEXT, deriveCards, deriveLead, fmtSec, fmtTokens, setRegistry, WHO, who, type Activity as WorkerAct, type Card } from "./derive";

/** Short role labels for the built-ins (the registry text is longer, used in tooltips). */
const WHO_SHORT: Record<string, string> = { claude: "主管 · 规划 / 审查 / 测试", codex: "实现 / 重构", deepseek: "测试 / 文档 / 评审" };
import claudeAvatar from "./assets/avatars/claude.png";
import codexAvatar from "./assets/avatars/codex.png";
import deepseekAvatar from "./assets/avatars/deepseek.png";

declare global {
  interface Window {
    mao: MaoApi;
  }
}
const mao = window.mao;

export const APP_NAME = "Claude 的工作室";

type Who = string;
export const BUILTIN_AVATARS: Record<string, string> = { claude: claudeAvatar, codex: codexAvatar, deepseek: deepseekAvatar };
/** CSS variable carrying the agent's colour (borders, rings, accents). */
const acc = (id: string) => ({ ["--ac" as any]: who(id).color }) as React.CSSProperties;

const STATUS_TEXT: Record<RunMeta["status"], string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};

const DELEGATE_STATUS: Record<string, string> = { timeout: "超时", spawn_error: "启动失败", error: "出错", failed: "失败" };

export function Avatar({ who: id, size = 26 }: { who: Who; size?: number }) {
  const info = who(id);
  const src = id === "claude" ? claudeAvatar : (info.avatar ?? BUILTIN_AVATARS[id]);
  const style = { width: size, height: size, ...acc(id) };
  if (!src)
    return (
      <span className={"avatar img letter " + id} title={info.name} style={{ ...style, background: info.color, fontSize: Math.max(10, size * 0.45) }}>
        {info.name.slice(0, 1).toUpperCase()}
      </span>
    );
  return <img className={"avatar img " + id} src={src} alt={info.name} title={info.name} style={style} draggable={false} />;
}

function Md({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function timeLabel(ts: number) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const runTokens = (r: RunMeta) => Object.values(r.tokens ?? {}).reduce((a, b) => a + (b ?? 0), 0);

const TOOL_LABEL: Record<string, string> = {
  project_status: "查看项目看板",
  claim_files: "占用文件",
  release_files: "释放文件",
  wait_for_files: "排队等待",
  post_note: "留言",
  read_notes: "读留言",
};

/** Explain a failed tool call in plain words (the full text stays in the tooltip). */
function denyReason(preview: string): string {
  if (/has been denied because Claude Code is running in don't ask mode/i.test(preview)) return "被权限规则拒绝：复合命令或不在白名单内（Claude 会改用单条命令重试）";
  if (/denied/i.test(preview)) return "被拒绝：" + preview.slice(0, 80);
  return "出错：" + preview.slice(0, 100);
}

function cleanError(e: any) {
  return String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="crash">
        <h3>界面出错了</h3>
        <pre>{String(this.state.err.stack ?? this.state.err)}</pre>
        <button className="btn" onClick={() => this.setState({ err: null })}>
          重试
        </button>
      </div>
    );
  }
}

// ------------------------------------------------------------------ modals
function Modal(props: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label={props.title}>
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const pickExisting = async () => {
    const d = await mao.pickDir(folder || undefined);
    if (d) {
      setFolder(d);
      if (!name.trim()) setName(d.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };
  const makeNew = async () => {
    setErr(null);
    if (!name.trim()) return setErr("先填项目名称，新文件夹会用这个名字");
    const parent = await mao.pickDir(undefined);
    if (!parent) return;
    try {
      setFolder(await mao.createFolder(parent, name));
    } catch (e) {
      setErr(cleanError(e));
    }
  };
  const create = async () => {
    setErr(null);
    try {
      onCreated(await mao.createProject(name, folder));
    } catch (e) {
      setErr(cleanError(e));
    }
  };
  return (
    <Modal title="新项目" onClose={onClose}>
      <label className="field">
        <span>项目名称</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的博客" onKeyDown={(e) => e.key === "Enter" && folder && create()} />
      </label>
      <div className="field">
        <span>项目文件夹（这个项目的所有对话都在这里工作，可以是空文件夹）</span>
        <div className="folderbox" title={folder}>
          {folder || <i>未选择</i>}
        </div>
        <div className="row">
          <button className="btn" onClick={pickExisting}>
            选择已有文件夹…
          </button>
          <button className="btn" onClick={makeNew} title="选一个上级文件夹，在里面新建一个以项目名称命名的文件夹">
            新建文件夹…
          </button>
        </div>
      </div>
      {err && <div className="modal-err">⚠ {err}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={!name.trim() || !folder} onClick={create}>
          创建项目
        </button>
      </div>
    </Modal>
  );
}

function RenameModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await mao.renameProject(project.id, name);
      onClose();
    } catch (e) {
      setErr(cleanError(e));
    }
  };
  return (
    <Modal title="重命名项目" onClose={onClose}>
      <label className="field">
        <span>项目名称</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      {err && <div className="modal-err">⚠ {err}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={!name.trim()} onClick={save}>
          保存
        </button>
      </div>
    </Modal>
  );
}

function ConfirmModal(props: { title: string; children: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className="modal-text">{props.children}</div>
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          取消
        </button>
        <button
          className={"btn " + (props.danger ? "danger" : "primary")}
          autoFocus
          onClick={() => {
            props.onConfirm();
            props.onClose();
          }}
        >
          {props.confirm}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ sidebar
/** Presence of an agent: off (not available) / on (available) / busy (working in some run). */
function quotaTip(w: Who, q: Quota): string {
  const fmt = (s?: SubQuota) => {
    if (!s || (!s.weekly && !s.short)) return "\n额度：订阅（暂无数据）";
    const r = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return (
      (s.weekly ? `\n每周额度：已用 ${s.weekly.usedPercent}%（${r(s.weekly.resetsAt)} 重置）` : "") +
      (s.short ? `\n${s.shortLabel}额度：已用 ${s.short.usedPercent}%（${r(s.short.resetsAt)} 重置）` : "")
    );
  };
  if (w === "claude") return fmt(q.claude);
  if (w === "codex") return fmt(q.codex);
  if (w !== "deepseek") return "";
  const d = q.deepseek;
  return d?.balances.length ? `\n余额：${d.balances.map((b) => `${b.total} ${b.currency}`).join(" / ")}` : "\n余额：未读取";
}

function presence(w: Who, env: EnvStatus | null, act: Activity, q: Quota, auth?: AuthInfo): { state: "off" | "on" | "busy"; tip: string } {
  const a = w === "deepseek" ? undefined : auth?.[w];
  // (registry agents with a login command share the same auth mechanism)
  if (env && a && a.state !== "ok") {
    const why = a.state === "timeout" ? "登录等待超时" : a.state === "cancelled" ? "已取消登录" : (a.reason ?? "需要登录");
    return { state: "off", tip: `${who(w).name}：需要登录（${why}）` };
  }
  const r = presenceBase(w, env, act);
  return { ...r, tip: r.tip + (env ? quotaTip(w, q) : "") };
}

function AuthBanner({ auth }: { auth: AuthInfo | null }) {
  if (!auth) return null;
  const rows = Object.keys(auth).filter((a) => a !== "deepseek" && auth[a] && auth[a].state !== "ok");
  if (!rows.length) return null;
  return (
    <>
      {rows.map((a) => {
        const s = auth[a];
        const name = who(a).name;
        const waiting = s.state === "logging_in" || s.state === "needed" || s.state === "simulated";
        return (
          <div key={a} className={"authbar " + (waiting ? "wait" : "bad")}>
            <Avatar who={a} size={22} />
            <span className="ab-text">
              {waiting
                ? s.state === "simulated"
                  ? `${name} 需要登录（模拟测试，未打开浏览器）。排队的 ${name} 任务会在登录后自动继续。`
                  : `${name} 需要登录，已为你打开浏览器。登录完成后，排队的 ${name} 任务会自动继续。`
                : `${name} ${s.state === "timeout" ? "等待登录超时" : "登录已取消"}。排队的任务没有执行，Claude 会决定改派给其他成员还是稍后重试。`}
            </span>
            {waiting ? (
              <>
                <button className="btn small" onClick={() => mao.authAction(a, "reopen")}>
                  重新打开登录页
                </button>
                <button className="linkbtn" onClick={() => mao.authAction(a, "cancel")}>
                  取消
                </button>
              </>
            ) : (
              <button className="btn small" onClick={() => mao.authAction(a, "retry")}>
                重新登录
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function presenceBase(w: Who, env: EnvStatus | null, act: Activity): { state: "off" | "on" | "busy"; tip: string } {
  if (!env) return { state: "off", tip: `${who(w).name}：检测中…` };
  let ok: boolean;
  let why = "";
  if (w === "claude") {
    ok = !!env.claude;
    why = ok ? (env.bridgeBuilt ? "Bridge 已就绪" : "⚠ Bridge 未编译，无法委派") : "未找到 claude.exe";
  } else if (w !== "deepseek" && w !== "codex") {
    why = env.agents?.[w] ?? "";
    ok = !why;
  } else if (w === "codex") {
    ok = !!env.codex;
    why = ok ? "" : "未找到 codex.exe";
  } else {
    ok = !!env.dsh && env.deepseekKey;
    why = !env.dsh ? "未找到 dsh" : env.deepseekKey ? "" : "缺少 DEEPSEEK_API_KEY";
  }
  const n = act[w] ?? 0;
  if (!ok) return { state: "off", tip: `${who(w).name}：不可用（${why}）` };
  if (n > 0) return { state: "busy", tip: `${who(w).name}：工作中（${n} ${w === "claude" ? "个对话" : "个委派"}）${why ? " · " + why : ""}` };
  return { state: "on", tip: `${who(w).name}：在线，空闲${why ? " · " + why : ""}` };
}

type Selection = { kind: "run"; id: string } | { kind: "new"; projectId: string } | null;

function Sidebar(props: {
  projects: Project[];
  runs: RunMeta[];
  boards: Record<string, Board>;
  activity: Activity;
  quota: Quota;
  auth: AuthInfo | null;
  sel: Selection;
  onSelectRun: (id: string) => void;
  onNewConversation: (projectId: string) => void;
  onNewProject: () => void;
  onSettings: () => void;
  onRename: (p: Project) => void;
  onRemove: (p: Project) => void;
  env: EnvStatus | null;
}) {
  const { env } = props;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("collapsed") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem("collapsed", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const selRunId = props.sel?.kind === "run" ? props.sel.id : null;
  const selNewPid = props.sel?.kind === "new" ? props.sel.projectId : null;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="presence">
          {["claude", ...AGENT_ORDER].map((w) => {
            const p = presence(w, env, props.activity, props.quota, props.auth ?? undefined);
            return (
              <span key={w} className={"pres " + w + " " + p.state} title={p.tip} style={acc(w)}>
                <Avatar who={w} size={34} />
                {w === "claude" && env && !env.bridgeBuilt && <i className="bridge-dot" />}
              </span>
            );
          })}
        </div>
      </div>

      <div className="row">
        <button className="btn primary block" onClick={props.onNewProject}>
          ＋ 新项目
        </button>
      </div>

      <div className="section-label">项目</div>
      <div className="history">
        {props.projects.length === 0 && <div className="empty-small">还没有项目。点上面的「＋ 新项目」，给它起个名字、选一个文件夹。</div>}
        {props.projects.map((p) => {
          const convs = props.runs.filter((r) => r.projectId === p.id);
          const nRunning = convs.filter((r) => r.status === "running").length;
          const isCollapsed = !!collapsed[p.id];
          return (
            <div key={p.id} className="proj">
              <div className={"proj-row" + (selNewPid === p.id ? " active" : "")}>
                <button className="proj-main" onClick={() => toggle(p.id)} title={p.folder}>
                  <span className={"caret" + (isCollapsed ? "" : " open")}>▸</span>
                  <span className="proj-name">{p.name}</span>
                  {nRunning > 0 && <span className="proj-running" title={`${nRunning} 个对话运行中`}>{nRunning}</span>}
                </button>
                <span className="proj-actions">
                  <button title="新对话" onClick={() => props.onNewConversation(p.id)}>
                    ＋
                  </button>
                  <button title="重命名" onClick={() => props.onRename(p)}>
                    ✎
                  </button>
                  <button title="从列表移除（不删除文件）" onClick={() => props.onRemove(p)}>
                    ✕
                  </button>
                </span>
              </div>
              {!isCollapsed && (
                <div className="convs">
                  <div className="proj-folder" title={p.folder}>
                    📁 {p.folder}
                  </div>
                  <button className={"newconv" + (selNewPid === p.id ? " active" : "")} onClick={() => props.onNewConversation(p.id)}>
                    ＋ 新对话
                  </button>
                  {convs.map((r) => {
                    const bc = props.boards[p.id]?.conversations[r.id];
                    const waiting = r.status === "running" && bc?.status === "waiting";
                    const waitTitle = waiting && bc?.waitingFor ? (props.boards[p.id]?.conversations[bc.waitingFor.conversationId]?.title ?? "其他对话") : "";
                    return (
                      <button key={r.id} className={"hist " + (r.id === selRunId ? "active" : "")} onClick={() => props.onSelectRun(r.id)} title={r.title}>
                        <span className={"sdot " + (waiting ? "waiting" : r.status)} />
                        <span className="hist-main">
                          <span className="hist-title">{r.title}</span>
                          <span className="hist-meta">
                            {waiting ? (
                              <span className="waittext">⏸ 等待「{waitTitle}」</span>
                            ) : (
                              <>
                                {timeLabel(r.startedAt)} · {STATUS_TEXT[r.status]}
                                {runTokens(r) ? ` · ${fmtTokens(runTokens(r))} tokens` : ""}
                              </>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {convs.length === 0 && <div className="empty-small">还没有对话</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="side-settings" title="设置（智能体、默认模型、数据目录…）" onClick={props.onSettings}>
        <span className="gear-ico">⚙</span> 设置
      </button>
    </aside>
  );
}

// ------------------------------------------------------------------ env banner
function EnvBanner({ env, onRefresh }: { env: EnvStatus | null; onRefresh: () => void }) {
  const [building, setBuilding] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  if (!env) return null;
  const problems: ReactNode[] = [];
  if (!env.claude) problems.push(<li key="c">找不到 Claude Code（claude.exe）。请先安装并登录，或设置环境变量 CLAUDE_PATH。</li>);
  if (!env.bridgeBuilt)
    problems.push(
      <li key="b">
        bridge 还没编译。
        <button
          className="btn small"
          disabled={building}
          onClick={async () => {
            setBuilding(true);
            const r = await mao.buildBridge();
            setBuilding(false);
            setOut(r.ok ? null : r.output);
            onRefresh();
          }}
        >
          {building ? "编译中…" : "编译 bridge"}
        </button>
      </li>,
    );
  if (!env.codex) problems.push(<li key="x">找不到 Codex（委派给 Codex 会失败）。安装 Codex 桌面版，或设置 CODEX_PATH。</li>);
  if (!env.dsh) problems.push(<li key="d">找不到 DeepSeek Harness（委派给 DeepSeek 会失败）。安装它，或设置 DSH_PATH。</li>);
  else if (!env.deepseekKey) problems.push(<li key="k">没有找到用户环境变量 DEEPSEEK_API_KEY（委派给 DeepSeek 会失败）。</li>);
  if (!problems.length) return null;
  return (
    <div className="banner">
      <b>环境检查</b>
      <ul>{problems}</ul>
      {out && <pre>{out}</pre>}
      <button className="linkbtn" onClick={onRefresh}>
        重新检测
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ chat
type ChatItem =
  | { type: "user"; ev: RunEvent & { k: "user" } }
  | { type: "text"; ev: RunEvent & { k: "text" } }
  | { type: "tools"; items: { ev: RunEvent & { k: "tool" }; result?: RunEvent & { k: "tool_result" } }[] }
  | { type: "delegate"; ev: RunEvent & { k: "delegate" }; result?: RunEvent & { k: "delegate_result" }; last?: WorkerAct; acts: number }
  | { type: "verdict"; ev: RunEvent & { k: "verdict" } }
  | { type: "note"; ev: RunEvent & { k: "note" } }
  | { type: "result"; ev: RunEvent & { k: "result" } }
  | { type: "stderr"; lines: string[]; failed?: boolean }
  | { type: "exit"; ev: RunEvent & { k: "exit" }; stderr: string[] };

function buildChat(events: RunEvent[]): ChatItem[] {
  const out: ChatItem[] = [];
  const toolIdx = new Map<string, { ev: any; result?: any }>();
  const delIdx = new Map<string, ChatItem & { type: "delegate" }>();
  const stderrTail: string[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    switch (ev.k) {
      case "user":
        out.push({ type: "user", ev });
        break;
      case "text":
        out.push({ type: "text", ev });
        break;
      case "tool": {
        const item = { ev };
        toolIdx.set(ev.id, item);
        if (last?.type === "tools") last.items.push(item);
        else out.push({ type: "tools", items: [item] });
        break;
      }
      case "tool_result": {
        const it = toolIdx.get(ev.id);
        if (it) it.result = ev;
        break;
      }
      case "delegate": {
        const d = { type: "delegate" as const, ev, acts: 0 };
        delIdx.set(ev.id, d);
        out.push(d);
        break;
      }
      case "worker": {
        const d = delIdx.get(ev.id);
        if (d) {
          d.last = { kind: ev.kind, text: ev.text, t: ev.t };
          d.acts++;
        }
        break;
      }
      case "delegate_result": {
        const d = delIdx.get(ev.id);
        if (d) d.result = ev;
        break;
      }
      case "verdict":
        out.push({ type: "verdict", ev });
        break;
      case "note":
        out.push({ type: "note", ev });
        break;
      case "result":
        out.push({ type: "result", ev });
        break;
      case "stderr":
        stderrTail.push(ev.text);
        if (stderrTail.length > 12) stderrTail.shift();
        if (last?.type === "stderr") last.lines.push(ev.text);
        else out.push({ type: "stderr", lines: [ev.text] });
        break;
      case "exit":
        if (ev.stopped || (ev.code !== 0 && ev.code !== null) || !events.some((e) => e.k === "result" && e.seq < ev.seq))
          out.push({ type: "exit", ev, stderr: ev.stopped ? [] : [...stderrTail] });
        break;
    }
  }
  return out;
}

function stripVerdict(text: string) {
  return text.replace(/^.*审查结论[:：].*$/gm, "").trim();
}

/** "新版本已下载" banner: restart now, or later (installs when the app is closed). */
function UpdateBanner() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [later, setLater] = useState<string | null>(null);
  useEffect(() => {
    mao.getUpdate().then(setS);
    return mao.onUpdate(setS);
  }, []);
  if (!s || s.state !== "ready" || later === s.version) return null;
  return (
    <div className="banner update">
      <span>新版本 v{s.version} 已下载，重启即可更新（当前 v{s.current}）。</span>
      <button className="btn small primary" onClick={() => mao.installUpdate()}>
        立即重启
      </button>
      <button className="btn small" onClick={() => setLater(s.version ?? "")}>
        稍后
      </button>
    </div>
  );
}

/** Empty state: a small project picker in the middle, the composer stays at the bottom (like a new Claude Code session). */
export interface WelcomeProps {
  projects: Project[];
  project: Project | null;
  onPick: (projectId: string) => void;
  onNewProject: () => void;
}

function Welcome({ projects, project, onPick, onNewProject }: WelcomeProps) {
  return (
    <div className="chat empty">
      <div className="welcome-min">
        <img className="mascot" src={BUILTIN_AVATARS.claude} alt="" draggable={false} />
        <div className="wcard">
          {projects.map((p) => (
            <button key={p.id} className={"wrow" + (project?.id === p.id ? " on" : "")} title={p.folder} onClick={() => onPick(p.id)}>
              <span className="wicon">📁</span>
              <span className="wname">{p.name}</span>
              <span className="wfolder">{p.folder}</span>
              {project?.id === p.id && <span className="wcheck">✓</span>}
            </button>
          ))}
          <button className="wrow add" onClick={onNewProject}>
            <span className="wicon">＋</span>
            <span className="wname">新项目</span>
          </button>
        </div>
        <p className="whint">{project ? `在下面描述任务，Claude 会在「${project.name}」里开始工作` : projects.length ? "选一个项目，然后在下面描述任务" : "先新建一个项目：起个名字，选一个文件夹"}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ attachments
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const previewCache = new Map<string, Promise<string | null>>();
const previewOf = (p: string) => {
  let v = previewCache.get(p);
  if (!v) previewCache.set(p, (v = mao.attachmentPreview(p)));
  return v;
};

function Thumb({ a, onOpen }: { a: Attachment; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    previewOf(a.path).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [a.path]);
  return src ? <img className="att-thumb" src={src} alt={a.name} title={`${a.name}（${fmtSize(a.size)}）— 点击放大`} onClick={() => onOpen(src)} /> : <span className="att-thumb ph">🖼</span>;
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt="" />
    </div>
  );
}

/** Attachments of a message; removable chips in the composer when onRemove is given. */
function Attachments({ list, onRemove }: { list: Attachment[]; onRemove?: (a: Attachment) => void }) {
  const [big, setBig] = useState<string | null>(null);
  return (
    <div className={"atts" + (onRemove ? " editing" : "")}>
      {list.map((a) => (
        <div key={a.path} className={"att" + (a.image ? " img" : "")}>
          {a.image ? (
            <Thumb a={a} onOpen={setBig} />
          ) : (
            <span className="att-file" title={a.path} onClick={() => !onRemove && mao.openPath(a.path.replace(/[\\/][^\\/]*$/, ""))}>
              📄 <span className="att-name">{a.name}</span> <span className="att-size">{fmtSize(a.size)}</span>
            </span>
          )}
          {onRemove && (
            <button className="att-x" title="移除" onClick={() => onRemove(a)}>
              ×
            </button>
          )}
        </div>
      ))}
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </div>
  );
}

function ChatView(props: { events: RunEvent[]; running: boolean; meta: RunMeta | null; project: Project | null; welcome: Omit<WelcomeProps, "project">; authWait?: (id: string) => boolean }) {
  const items = useMemo(() => buildChat(props.events), [props.events]);
  const now = useNow(props.running);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [props.meta?.id]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!props.meta) return <Welcome {...props.welcome} project={props.project} />;

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      {items.map((it, i) => {
        switch (it.type) {
          case "user":
            return (
              <div key={i} className="msg user">
                <div className="bubble">
                  {it.ev.attachments?.length ? <Attachments list={it.ev.attachments} /> : null}
                  {it.ev.text}
                </div>
              </div>
            );
          case "text": {
            const t = stripVerdict(it.ev.text);
            return t ? (
              <div key={i} className="msg claude">
                <Avatar who="claude" size={30} />
                <div className="body">
                  <Md text={t} />
                </div>
              </div>
            ) : null;
          }
          case "tools":
            return (
              <div key={i} className="tools">
                {it.items.map(({ ev, result }) => (
                  <div key={ev.id} className={"toolline " + (result?.isError ? "err" : "")} title={result?.preview ?? ""}>
                    <span className={"tname" + (ev.name.startsWith("mcp__") ? " collab" : "")}>{TOOL_LABEL[ev.name.replace(/^mcp__[^_]+__/, "")] ?? ev.name.replace(/^mcp__[^_]+__/, "")}</span>
                    <span className="tsum">{ev.summary}</span>
                    {result?.isError && <span className="terr">{denyReason(result.preview)}</span>}
                  </div>
                ))}
              </div>
            );
          case "delegate": {
            const r = it.result;
            const st = !r ? "running" : r.ok ? "done" : "failed";
            const elapsed = r?.durationSec ?? (now - it.ev.t) / 1000;
            return (
              <div key={i} id={"del-" + it.ev.id} className={"delegate " + it.ev.who} style={acc(it.ev.who)}>
                <div className="dhead">
                  <Avatar who={it.ev.who} size={24} />
                  <span>
                    委派给 <b>{who(it.ev.who).name}</b>
                    {it.ev.mode ? <span className="mode">{it.ev.mode}</span> : null}
                  </span>
                  <span className={"pill " + st}>{st === "running" ? "进行中" : st === "done" ? "完成" : DELEGATE_STATUS[r!.status] ?? "失败"}</span>
                  <span className="dmeta">
                    {fmtSec(elapsed)}
                    {r ? ` · ${fmtTokens(r.tokens)} tokens · ${r.files.length} 个文件` : ""}
                  </span>
                </div>
                {st === "running" && (
                  <div className="live">
                    <span className="spinner" />
                    {props.authWait?.(it.ev.who) && !it.last ? (
                      <span className="act error">⏸ 等待 {who(it.ev.who).name} 登录，登录后自动继续</span>
                    ) : false ? (
                      <span className="act error">⏸ 等待 Codex 登录，登录后自动继续</span>
                    ) : it.last ? (
                      <span className={"act " + it.last.kind}>
                        {ACT_ICON[it.last.kind]} {it.last.text}
                      </span>
                    ) : (
                      <span className="act">启动中…</span>
                    )}
                  </div>
                )}
                {r && !r.ok && r.error && <div className="card-error">{r.error}</div>}
                <details>
                  <summary>{it.ev.task.split("\n")[0].slice(0, 160)}</summary>
                  <pre className="task">{it.ev.task}</pre>
                  {r?.answer && (
                    <>
                      <div className="sublabel">{who(it.ev.who).name} 的回复</div>
                      <Md text={r.answer} />
                    </>
                  )}
                </details>
              </div>
            );
          }
          case "note":
            return (
              <div key={i} className={"note-line " + it.ev.kind + (it.ev.mine ? " mine" : "")}>
                <span className="nl-head">
                  {it.ev.kind === "decision" ? "⚖ 优先级决定" : "✉ 留言"} · {it.ev.mine ? "本对话发出" : `来自「${it.ev.fromTitle}」`}
                </span>
                <span className="nl-text">{it.ev.text}</span>
              </div>
            );
          case "verdict":
            return (
              <div key={i} className={"verdict-line " + (it.ev.pass ? "pass" : "fail")}>
                {it.ev.pass ? "✓ 审查通过" : "✗ 需返工"}
                {it.ev.text ? ` — ${it.ev.text}` : ""}
              </div>
            );
          case "result":
            return (
              <div key={i} className={"resultbar " + (it.ev.ok ? "ok" : "bad")}>
                {it.ev.ok ? "本轮完成" : "本轮出错"} · 用时 {fmtSec(it.ev.durationSec ?? 0)} · {it.ev.turns ?? 0} 轮{it.ev.tokens ? ` · Claude ${fmtTokens(it.ev.tokens)} tokens` : ""}
              </div>
            );
          case "stderr":
            return (
              <details key={i} className="stderr">
                <summary>诊断输出（{it.lines.length}）</summary>
                <pre>{it.lines.join("\n")}</pre>
              </details>
            );
          case "exit":
            return (
              <div key={i} className="exitbox">
                <div className="resultbar bad">
                  {it.ev.stopped ? "已手动停止（整个进程树已结束）" : it.ev.code === null ? "claude 没能启动" : `claude 异常退出（代码 ${it.ev.code}）`}
                </div>
                {it.stderr.length > 0 && <pre className="exit-stderr">{it.stderr.join("\n")}</pre>}
              </div>
            );
        }
      })}
      {props.running && (
        <div className="typing">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 分工面板
function resetLabel(ms: number) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** "周 14% · 5 小时 88%" with reset times in the tooltip. */
export function QuotaLine({ q, compact }: { q?: SubQuota; compact?: boolean }) {
  if (!q || (!q.weekly && !q.short)) return <span className="quota muted">额度：订阅（暂无数据）</span>;
  const cls = (p?: number) => (p === undefined ? "" : p >= 90 ? "hot" : p >= 70 ? "warm" : "");
  const tip = [
    q.weekly ? `每周额度已用 ${q.weekly.usedPercent}%，${resetLabel(q.weekly.resetsAt)} 重置` : "",
    q.short ? `${q.shortLabel}额度已用 ${q.short.usedPercent}%，${resetLabel(q.short.resetsAt)} 重置` : "",
    q.plan ? `套餐：${q.plan}` : "",
    `更新于 ${resetLabel(q.at)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="quota" title={tip}>
      {q.weekly && (
        <span className={"qpart " + cls(q.weekly.usedPercent)}>
          周 <b>{q.weekly.usedPercent}%</b>
        </span>
      )}
      {q.short && (
        <span className={"qpart " + cls(q.short.usedPercent)}>
          {compact ? q.shortLabel.replace(" 小时", "h") : q.shortLabel} <b>{q.short.usedPercent}%</b>
        </span>
      )}
      {!compact && q.weekly && <span className="qreset">周额度 {resetLabel(q.weekly.resetsAt)} 重置</span>}
    </span>
  );
}

export function DeepseekBalance({ q }: { q?: Quota["deepseek"] }) {
  if (!q) return <span className="quota muted">余额：未读取</span>;
  if (q.error && !q.balances.length) return <span className="quota muted" title={q.error}>余额读取失败</span>;
  return (
    <span className="quota" title={`DeepSeek 账户余额（官方 /user/balance），更新于 ${resetLabel(q.at)}${q.error ? `\n上次刷新失败：${q.error}` : ""}`}>
      余额 <b>{q.balances.map((b) => `${b.total} ${b.currency}`).join(" / ") || "—"}</b>
    </span>
  );
}

function SandboxGrant({ projectId }: { projectId?: string }) {
  const [st, setSt] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");
  if (!projectId) return null;
  return (
    <div className="sandbox-grant">
      {st === "ok" ? (
        <span className="ok">✓ {msg}。让 Claude 重新委派就能跑命令了。</span>
      ) : (
        <>
          <button
            className="btn small"
            disabled={st === "busy"}
            title="给当前 Windows 用户这个项目文件夹的「完全控制」权限（icacls /grant），DeepSeek 的沙箱需要它；不影响其他文件夹"
            onClick={async () => {
              setSt("busy");
              try {
                const r = await mao.grantSandbox(projectId);
                setSt(r.ok ? "ok" : "err");
                setMsg(r.output);
              } catch (e) {
                setSt("err");
                setMsg(cleanError(e));
              }
            }}
          >
            {st === "busy" ? "授予中…" : "授予 DeepSeek 沙箱权限"}
          </button>
          {st === "err" && <span className="err"> {msg}</span>}
        </>
      )}
    </div>
  );
}

function CardView({ c, now, quota, convRunning, authWait, projectId }: { c: Card; now: number; quota: Quota; convRunning: boolean; authWait?: boolean; projectId?: string }) {
  const elapsed = c.durationSec ?? ((c.endedAt ?? now) - c.startedAt) / 1000;
  const [showFiles, setShowFiles] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const last = c.activity[c.activity.length - 1];
  const tokens = c.tokens ?? c.liveTokens;
  return (
    <div id={"card-" + c.id} className={"card " + c.who + (c.status === "running" ? " working" : "") + (c.parentId ? " fix" : "")}>
      <div className="card-head">
        <Avatar who={c.who} size={40} />
        <div className="card-title">
          <b>{c.label}</b>
          <span className="card-role">{WHO_SHORT[c.who] ?? who(c.who).role}</span>
        </div>
        <span className={"pill " + c.status}>{c.status === "running" ? "进行中" : c.status === "done" ? "完成" : "失败"}</span>
      </div>
      <div className="card-task" title={c.task}>
        {c.task.replace(/\s+/g, " ").slice(0, 160)}
      </div>
      <div className="stats">
        <div>
          <span>耗时</span>
          <b>{fmtSec(elapsed)}</b>
        </div>
        <div>
          <span>Tokens{c.tokens === undefined && c.liveTokens !== undefined ? "（进行中）" : ""}</span>
          <b>{fmtTokens(tokens)}</b>
        </div>
        <div>
          <span>改动文件</span>
          <b>{c.status === "running" ? "—" : c.files.length}</b>
        </div>
      </div>
      <div className="quota-row">{c.who === "codex" ? <QuotaLine q={quota.codex} /> : c.who === "deepseek" ? <DeepseekBalance q={quota.deepseek} /> : who(c.who).textOnly ? <span className="quota muted">API 文本型：结果由 Claude 落地</span> : null}</div>
      {c.status === "running" && (
        <div className="live">
          <span className="spinner" />
          <span className={"act " + (authWait ? "error" : (last?.kind ?? ""))}>{authWait ? "⏸ 等待 Codex 登录，登录后自动继续" : last ? `${ACT_ICON[last.kind]} ${last.text}` : "启动中…"}</span>
        </div>
      )}
      {c.error && <div className="card-error">{c.error.replace(/^[sS]*?SANDBOX_ACL: /, "")}</div>}
      {c.who === "deepseek" && /SANDBOX_ACL/.test(c.error ?? "") && <SandboxGrant projectId={projectId} />}
      <div className="card-links">
        {c.activity.length > 0 && (
          <button className="linkbtn" onClick={() => setShowLog(!showLog)}>
            {showLog ? "收起过程" : `过程（${c.activity.length}）`}
          </button>
        )}
        {c.files.length > 0 && (
          <button className="linkbtn" onClick={() => setShowFiles(!showFiles)}>
            {showFiles ? "收起文件" : `文件（${c.files.length}）`}
          </button>
        )}
        <button className="linkbtn" onClick={() => document.getElementById("del-" + c.id)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
          在对话中定位
        </button>
      </div>
      {showLog && (
        <ul className="actlog">
          {c.activity.slice(-60).map((a, i) => (
            <li key={i} className={a.kind}>
              <span className="at">{fmtSec((a.t - c.startedAt) / 1000)}</span> {ACT_ICON[a.kind]} {a.text}
            </li>
          ))}
        </ul>
      )}
      {showFiles && (
        <ul className="files">
          {c.files.map((f) => (
            <li key={f} className={f[0] === "+" ? "add" : f[0] === "-" ? "del" : "mod"}>
              {f}
            </li>
          ))}
        </ul>
      )}
      <div className={"verdict " + (c.verdict ? (c.verdict.pass ? "pass" : "fail") : c.status === "running" ? "wait" : "pending")}>
        <span className="vlabel">Claude 审查</span>
        <span>
          {c.verdict
            ? (c.verdict.pass ? "✓ 通过" : "✗ 需返工") + (c.verdict.text ? ` — ${c.verdict.text}` : "")
            : c.status === "running"
              ? "等待结果"
              : convRunning
                ? "审查中…"
                : "未单独给出结论（见总结）"}
        </span>
      </div>
    </div>
  );
}

const jump = (id: string) => {
  const card = document.getElementById("card-" + id);
  card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card?.classList.add("flash");
  setTimeout(() => card?.classList.remove("flash"), 1200);
  document.getElementById("del-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
};

/** 项目 > 对话 > Claude > 委派（修复嵌套在原委派下）; other running conversations as sibling branches. */
function DispatchTree(props: { project: Project | null; meta: RunMeta; cards: Card[]; running: boolean; board?: Board; runs: RunMeta[]; onOpenRun: (id: string) => void; now: number }) {
  const { meta, cards } = props;
  const roots = cards.filter((c) => !c.parentId);
  const kids = (id: string) => cards.filter((c) => c.parentId === id);
  const node = (c: Card, depth: number): ReactNode => (
    <li key={c.id}>
      <button className={"tnode " + c.status} onClick={() => jump(c.id)} title={c.task.slice(0, 300)}>
        <Avatar who={c.who} size={18} />
        <span className="tlabel">{c.label}</span>
        <span className={"tdot " + c.status} />
        <span className="tmeta">{fmtSec(c.durationSec ?? ((c.endedAt ?? props.now) - c.startedAt) / 1000)}</span>
        {c.verdict && <span className={"tverdict " + (c.verdict.pass ? "pass" : "fail")}>{c.verdict.pass ? "✓" : "✗"}</span>}
      </button>
      {kids(c.id).length > 0 && <ul>{kids(c.id).map((k) => node(k, depth + 1))}</ul>}
    </li>
  );
  const others = props.runs.filter((r) => r.projectId && r.projectId === meta.projectId && r.id !== meta.id && r.status === "running");
  return (
    <div className="tree">
      <ul>
        <li>
          <span className="tnode proj" title={props.project?.folder}>
            📁 <span className="tlabel">{props.project?.name ?? "（无项目）"}</span>
          </span>
          <ul>
            <li>
              <span className="tnode conv current">
                💬 <span className="tlabel">{meta.title}</span>
                <span className={"tdot " + (props.running ? "running" : meta.status === "done" ? "done" : "failed")} />
              </span>
              <ul>
                <li>
                  <span className="tnode lead">
                    <Avatar who="claude" size={18} />
                    <span className="tlabel">Claude 主管</span>
                    <span className="tmeta">{roots.length ? `${cards.length} 次委派` : "无委派"}</span>
                  </span>
                  {roots.length > 0 && <ul>{roots.map((c) => node(c, 0))}</ul>}
                </li>
              </ul>
            </li>
            {others.map((r) => {
              const bc = props.board?.conversations[r.id];
              return (
                <li key={r.id}>
                  <button className="tnode conv" onClick={() => props.onOpenRun(r.id)} title={bc?.planStep ?? ""}>
                    💬 <span className="tlabel">{r.title}</span>
                    <span className={"tdot " + (bc?.status === "waiting" ? "waiting" : "running")} />
                    <span className="tmeta">{bc?.status === "waiting" ? "等待中" : (bc?.planStep ?? "运行中").slice(0, 24)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      </ul>
    </div>
  );
}

/** Other conversations of the project, their claims, notes and priority decisions. */
function ProjectFeed({ meta, board, runs }: { meta: RunMeta; board?: Board; runs: RunMeta[] }) {
  if (!board) return null;
  const convs = Object.entries(board.conversations);
  const active = convs.filter(([id, c]) => id !== meta.id && (c.status === "running" || c.status === "waiting"));
  const mine = board.conversations[meta.id];
  const notes = board.notes.slice(-12).reverse();
  const full = (id: string) => (id === "all" ? "所有对话" : (board.conversations[id]?.title ?? runs.find((r) => r.id === id)?.title ?? id));
  const title = (id: string) => {
    const t = full(id);
    return t.length > 14 ? t.slice(0, 14) + "…" : t;
  };
  if (!active.length && !notes.length && !mine?.claims.length) return null;
  return (
    <div className="feed">
      <div className="feed-head">项目动态</div>
      {mine && mine.claims.length > 0 && (
        <div className="feed-item">
          <span className="fi-label">本对话占用</span>
          <span className="claims">{mine.claims.map((c) => c.path).join(", ")}</span>
        </div>
      )}
      {mine?.status === "waiting" && mine.waitingFor && (
        <div className="feed-item waiting">⏸ 正在等待「{title(mine.waitingFor.conversationId)}」释放 {mine.waitingFor.paths.join(", ")}</div>
      )}
      {active.map(([id, c]) => (
        <div key={id} className="feed-item">
          <span className={"sdot " + (c.status === "waiting" ? "waiting" : "running")} />
          <div className="fi-body">
            <b>{c.title}</b>
            <span className="muted small">{c.status === "waiting" ? `等待「${title(c.waitingFor?.conversationId ?? "")}」` : c.planStep}</span>
            {c.claims.length > 0 && <span className="claims">占用：{c.claims.map((x) => x.path).join(", ")}</span>}
          </div>
        </div>
      ))}
      {notes.map((n) => (
        <div key={n.id} className={"feed-note " + n.kind}>
          {n.kind === "decision" ? "⚖ Claude 判定" : "✉ 留言"}（{title(n.from)} → {title(n.to)}）：{n.text}
        </div>
      ))}
    </div>
  );
}

function Panel(props: { meta: RunMeta | null; project: Project | null; events: RunEvent[]; running: boolean; board?: Board; runs: RunMeta[]; quota: Quota; auth: AuthInfo | null; onOpenRun: (id: string) => void }) {
  const now = useNow(props.running);
  const cards = useMemo(() => deriveCards(props.events), [props.events]);
  const lead = useMemo(() => deriveLead(props.events), [props.events]);
  const [view, setView] = useState<"cards" | "tree">(() => (sessionStorage.getItem("panelView") === "cards" ? "cards" : "tree"));
  const setV = (v: "cards" | "tree") => {
    setView(v);
    try {
      sessionStorage.setItem("panelView", v);
    } catch {
      /* ignore */
    }
  };
  const m = props.meta;
  const elapsed = m ? ((m.endedAt ?? now) - m.startedAt) / 1000 : 0;
  type Part = { n: number; tok: number; sec: number; running: number; failed: number; pass: number; fail: number };
  const blank = (): Part => ({ n: 0, tok: 0, sec: 0, running: 0, failed: 0, pass: 0, fail: 0 });
  const parts: Record<string, Part> = {};
  for (const c of cards) {
    const p = (parts[c.who] ??= blank());
    p.n++;
    p.tok += c.tokens ?? c.liveTokens ?? 0;
    p.sec += c.durationSec ?? ((c.endedAt ?? now) - c.startedAt) / 1000;
    if (c.status === "running") p.running++;
    if (c.status === "failed") p.failed++;
    if (c.verdict?.pass) p.pass++;
    if (c.verdict && !c.verdict.pass) p.fail++;
  }
  const passed = Object.values(parts).reduce((a, p) => a + p.pass, 0);
  const rework = Object.values(parts).reduce((a, p) => a + p.fail, 0);
  const claudeTokens = m?.tokens?.claude ?? 0;
  const totalTokens = claudeTokens + Object.values(parts).reduce((a, p) => a + p.tok, 0);
  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="ph-title">
          <h3>分工面板</h3>
          {m && (
            <div className="crumbs" title={props.project?.folder ?? m.workdir}>
              {props.project?.name ?? "（无项目）"} › {m.title}
            </div>
          )}
        </div>
        {m && (
          <div className="viewtoggle">
            <button className={view === "cards" ? "on" : ""} onClick={() => setV("cards")} title="卡片" aria-label="卡片">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="5" rx="1.5" />
                <rect x="2" y="9" width="12" height="5" rx="1.5" />
              </svg>
            </button>
            <button className={view === "tree" ? "on" : ""} onClick={() => setV("tree")} title="树状图" aria-label="树状图">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="1.5" width="5" height="4" rx="1" />
                <rect x="9.5" y="6" width="5" height="4" rx="1" />
                <rect x="9.5" y="11" width="5" height="3.5" rx="1" />
                <path d="M4 5.5v7.25h5.5M4 8h5.5" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {!m ? (
        <div className="empty-small pad">开始对话后，这里会显示每个子任务由谁负责、实时进度和 Claude 的审查结论。</div>
      ) : (
        <div className="panel-body">
          <div className={"card overview" + (props.running ? " working" : "")}>
            <div className="ov-head">
              <b>本次任务</b>
              <span className={"pill " + (props.running ? "running" : m.status === "done" ? "done" : "failed")}>{props.running ? "进行中" : STATUS_TEXT[m.status]}</span>
            </div>
            <div className="stats">
              <div>
                <span>总耗时</span>
                <b>{fmtSec(elapsed)}</b>
              </div>
              <div>
                <span>总用量</span>
                <b title="Claude + Codex + DeepSeek 在这个对话里用的 tokens（Claude 含缓存读取，每轮结束后更新）">{totalTokens ? fmtTokens(totalTokens) : "—"}</b>
              </div>
              <div>
                <span>审查</span>
                <b>
                  {passed}✓{rework ? ` ${rework}✗` : ""}
                </b>
              </div>
            </div>
            <div className="parts">
              <div className={"part claude" + (props.running ? " busy" : "")}>
                <Avatar who="claude" size={34} />
                <div className="part-main">
                  <div className="part-top">
                    <b>Claude</b>
                    <span className="card-role">主管</span>
                    <span className={"pill " + (props.running ? "running" : m.status === "done" ? "done" : "failed")}>{props.running ? "工作中" : STATUS_TEXT[m.status]}</span>
                  </div>
                  <div className="part-stats">
                    {claudeTokens ? `${fmtTokens(claudeTokens)} tokens` : "— tokens"} · 工具 {lead.tools} 次 · 审查 {passed}✓{rework ? ` ${rework}✗` : ""}
                  </div>
                  <QuotaLine q={props.quota.claude} compact />
                </div>
              </div>
              {Object.keys(parts)
                .map((w) => {
                  const p = parts[w];
                  const st = p.running ? "running" : p.failed === p.n ? "failed" : "done";
                  return (
                    <div key={w} className={"part " + w + (p.running ? " busy" : "")} style={acc(w)}>
                      <Avatar who={w} size={34} />
                      <div className="part-main">
                        <div className="part-top">
                          <b>{who(w).name}</b>
                          <span className="card-role">{w === "codex" ? "实现" : w === "deepseek" ? "测试 / 文档" : who(w).textOnly ? "API" : "命令行"}</span>
                          <span className={"pill " + st}>{st === "running" ? "进行中" : st === "done" ? "完成" : "失败"}</span>
                        </div>
                        <div className="part-stats">
                          委派 {p.n} 次{p.failed ? `（失败 ${p.failed}）` : ""} · {p.tok ? fmtTokens(p.tok) : "—"} tokens · {fmtSec(p.sec)}
                          {p.pass || p.fail ? ` · 审查 ${p.pass}✓${p.fail ? ` ${p.fail}✗` : ""}` : ""}
                        </div>
                        {w === "codex" ? <QuotaLine q={props.quota.codex} compact /> : w === "deepseek" ? <DeepseekBalance q={props.quota.deepseek} /> : null}
                      </div>
                    </div>
                  );
                })}
            </div>
            {m.options && (
              <div className="summary-row">
                {m.options.claudeModel !== undefined && <span className="tag">Claude 模型 {CLAUDE_MODEL_TEXT[m.options.claudeModel] ?? (m.options.claudeModel || "默认")}</span>}
                {m.options.claudeEffort && <span className="tag">Claude 思考 {EFFORT_TEXT[m.options.claudeEffort] ?? m.options.claudeEffort}</span>}
                {m.options.splitSmall && <span className="tag">拆小任务</span>}
                <span className="tag">Codex 模型 {m.options.codexModel || "默认"}</span>
                {m.options.codexEffort && <span className="tag">Codex 推理 {EFFORT_TEXT[m.options.codexEffort] ?? m.options.codexEffort}</span>}
              </div>
            )}
            {lead.model && <div className="muted small">Claude 模型 {lead.model} · {lead.mcp}</div>}
          </div>
          <ProjectFeed meta={m} board={props.board} runs={props.runs} />
          {view === "tree" ? (
            <DispatchTree project={props.project} meta={m} cards={cards} running={props.running} board={props.board} runs={props.runs} onOpenRun={props.onOpenRun} now={now} />
          ) : (
            <>
              {cards.length === 0 && <div className="empty-small pad">{props.running ? "还没有委派，Claude 正在规划…" : "这个对话没有委派。"}</div>}
              {cards.map((c) => (
                <CardView key={c.id} c={c} now={now} quota={props.quota} projectId={props.meta?.projectId} convRunning={props.running} authWait={!!props.auth?.[c.who] && props.auth[c.who].state !== "ok"} />
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ options
const DEFAULT_OPTS: RunOptions = { splitSmall: false, codexModel: "", codexEffort: "" };
const CLAUDE_MODELS = ["opus", "sonnet", "fable", "haiku"];
const CLAUDE_MODEL_TEXT: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", fable: "Fable", haiku: "Haiku" };
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const optsFromSettings = (s: Settings): RunOptions => ({ splitSmall: s.splitSmall, codexModel: s.codexModel, codexEffort: s.codexEffort, claudeModel: s.claudeModel, claudeEffort: s.claudeEffort });

function loadOpts(): RunOptions {
  try {
    return { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem("runOptions") ?? "{}") };
  } catch {
    return DEFAULT_OPTS;
  }
}

function OptionsRow({ opts, setOpts, models, midway }: { opts: RunOptions; setOpts: (o: RunOptions) => void; models: CodexModel[]; midway?: boolean }) {
  const model = models.find((m) => m.slug === opts.codexModel);
  const efforts = model?.efforts ?? ["low", "medium", "high", "xhigh"];
  return (
    <div className="options" title={midway ? "改了从下一条消息开始生效" : undefined}>
      <label className="sel" title="主管 Claude 用的模型；默认值在 设置 → 默认选项">
        Claude 模型
        <select value={opts.claudeModel ?? ""} onChange={(e) => setOpts({ ...opts, claudeModel: e.target.value })}>
          <option value="">默认（Claude Code 设置）</option>
          {[...new Set([...CLAUDE_MODELS, ...(opts.claudeModel ? [opts.claudeModel] : [])])].map((m) => (
            <option key={m} value={m}>
              {CLAUDE_MODEL_TEXT[m] ?? m}
            </option>
          ))}
        </select>
      </label>
      <label className="sel" title="Claude 的思考等级（--effort）">
        Claude 思考
        <select value={opts.claudeEffort ?? ""} onChange={(e) => setOpts({ ...opts, claudeEffort: e.target.value })}>
          <option value="">默认</option>
          {CLAUDE_EFFORTS.map((x) => (
            <option key={x} value={x}>
              {EFFORT_TEXT[x] ?? x}
            </option>
          ))}
        </select>
      </label>
      <label className="check" title="让 Claude 把 Codex 的工作拆成几分钟能完成的小单元，每个单元审查通过后再委派下一个">
        <input type="checkbox" checked={opts.splitSmall} onChange={(e) => setOpts({ ...opts, splitSmall: e.target.checked })} />
        把任务拆小
      </label>
      <label className="sel">
        Codex 模型
        <select value={opts.codexModel} onChange={(e) => setOpts({ ...opts, codexModel: e.target.value, codexEffort: "" })}>
          <option value="">默认（Codex 设置）</option>
          {models.map((m) => (
            <option key={m.slug} value={m.slug} title={m.description}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="sel">
        Codex 推理
        <select value={opts.codexEffort} onChange={(e) => setOpts({ ...opts, codexEffort: e.target.value })}>
          <option value="">默认{model?.defaultEffort ? `（${EFFORT_TEXT[model.defaultEffort] ?? model.defaultEffort}）` : ""}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {EFFORT_TEXT[e] ?? e}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ------------------------------------------------------------------ app
function AppInner() {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [boards, setBoards] = useState<Record<string, Board>>({});
  const [sel, setSel] = useState<Selection>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [att, setAtt] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opts, setOptsState] = useState<RunOptions>(loadOpts);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [modal, setModal] = useState<ReactNode>(null);
  const [activity, setActivity] = useState<Activity>({ claude: 0, codex: 0, deepseek: 0 });
  const [quota, setQuota] = useState<Quota>({});
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [, setRegVer] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const loadAgents = async (list?: AgentDef[]) => {
    const l = list ?? (await mao.listAgents());
    setRegistry(l, await mao.agentAvatars(), BUILTIN_AVATARS);
    setAgents(l);
    setRegVer((v) => v + 1);
    mao.status().then(setEnv);
  };
  const selRef = useRef<string | null>(null);
  const selected = sel?.kind === "run" ? sel.id : null;
  selRef.current = selected;

  const setOpts = (o: RunOptions) => {
    setOptsState(o);
    try {
      localStorage.setItem("runOptions", JSON.stringify(o));
    } catch {
      /* ignore */
    }
  };
  const refreshEnv = () => mao.status().then(setEnv);

  useEffect(() => {
    refreshEnv();
    mao.listRuns().then(setRuns);
    mao.codexModels().then(setModels);
    mao.listProjects().then(async (ps) => {
      setProjects(ps);
      const bs: Record<string, Board> = {};
      for (const p of ps) bs[p.id] = await mao.getBoard(p.id);
      setBoards(bs);
    });
    mao.getActivity().then(setActivity);
    mao.getQuota().then(setQuota);
    mao.getAuth().then(setAuth);
    loadAgents();
    // New conversations start from the defaults in 设置 unless the user changed them here before.
    // (Choices saved before 1.1.1 have no Claude fields: take those from 设置.)
    mao.getSettings().then((s) =>
      setOptsState((o) => (!localStorage.getItem("runOptions") ? optsFromSettings(s) : { ...o, claudeModel: o.claudeModel ?? s.claudeModel, claudeEffort: o.claudeEffort ?? s.claudeEffort })),
    );
    // Dropping a file anywhere else must not navigate the window to it.
    const stopDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stopDrop);
    window.addEventListener("drop", stopDrop);
    const offs = [
      () => window.removeEventListener("dragover", stopDrop),
      () => window.removeEventListener("drop", stopDrop),
      mao.onAgentsChanged((l) => loadAgents(l)),
      mao.onAuth(setAuth),
      mao.onActivity(setActivity),
      mao.onQuota(setQuota),
      mao.onRunsChanged(setRuns),
      mao.onProjectsChanged(setProjects),
      mao.onBoardChanged((pid, b) => setBoards((bs) => ({ ...bs, [pid]: b }))),
      mao.onEvent((id, ev) => {
        if (id === selRef.current) setEvents((es) => (es.length && es[es.length - 1].seq >= ev.seq ? es : [...es, ev]));
      }),
      mao.onSelectRun((id) => selectRun(id)),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  const selectRun = async (id: string) => {
    setSel({ kind: "run", id });
    selRef.current = id;
    setError(null);
    const r = await mao.getRun(id);
    if (selRef.current === id) setEvents(r?.events ?? []);
  };
  const newConversation = (projectId: string) => {
    setSel({ kind: "new", projectId });
    selRef.current = null;
    setEvents([]);
    setError(null);
  };

  const openNewProject = () =>
    setModal(
      <NewProjectModal
        onClose={() => setModal(null)}
        onCreated={(p) => {
          setModal(null);
          newConversation(p.id);
        }}
      />,
    );

  const meta = runs.find((r) => r.id === selected) ?? null;
  const projectId = meta?.projectId ?? (sel?.kind === "new" ? sel.projectId : null);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const board = projectId ? boards[projectId] : undefined;
  const running = meta?.status === "running";
  const isNew = !meta || !meta.sessionId;
  const othersRunning = runs.filter((r) => r.projectId && r.projectId === projectId && r.status === "running" && r.id !== meta?.id);

  const addStaged = (r: StageResult) => {
    if (r.files.length) setAtt((l) => [...l, ...r.files]);
    setError(r.errors.length ? r.errors.join("；") : null);
  };
  /** Pasted or dropped File objects: by path when they have one (Explorer), else their bytes (screenshots). */
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const paths: string[] = [];
    const res: StageResult = { files: [], errors: [] };
    for (const f of files) {
      const p = mao.pathForFile(f);
      if (p) paths.push(p);
      else if (f.size > 50 * 1024 * 1024) res.errors.push(`「${f.name || "粘贴的内容"}」太大了`);
      else {
        const r = await mao.stageBlob(f.name, f.type, new Uint8Array(await f.arrayBuffer()));
        res.files.push(...r.files);
        res.errors.push(...r.errors);
      }
    }
    if (paths.length) {
      const r = await mao.stageFiles(paths);
      res.files.push(...r.files);
      res.errors.push(...r.errors);
    }
    addStaged(res);
  };
  const canAttach = !!project && !running;
  // Options shown under the input: the draft choice for a new conversation, the conversation's own otherwise.
  const shownOpts: RunOptions = isNew || !meta ? opts : { ...DEFAULT_OPTS, ...meta.options };
  const changeOpts = (o: RunOptions) => {
    if (isNew || !meta) return setOpts(o);
    mao.setRunOptions(meta.id, o).catch((e) => setError(cleanError(e)));
  };
  // The latest DeepSeek result of this conversation says its sandbox could not be prepared in the project folder.
  const lastDs = [...events].reverse().find((e) => e.k === "delegate_result" && e.who === "deepseek");
  const needGrant = !!lastDs && lastDs.k === "delegate_result" && /SANDBOX_ACL/.test(lastDs.error ?? "");

  const send = async () => {
    const text = draft.trim();
    if ((!text && !att.length) || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (!isNew && !running) {
        await mao.sendMessage(meta!.id, text, att);
      } else if (isNew) {
        if (!project) throw new Error("请先在左侧选择或新建一个项目");
        const m = await mao.startRun(text, project.id, opts, att);
        await selectRun(m.id);
      }
      setDraft("");
      setAtt([]);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = (p: Project) =>
    setModal(
      <ConfirmModal
        title="从列表移除项目"
        confirm="移除"
        danger
        onClose={() => setModal(null)}
        onConfirm={async () => {
          await mao.removeProject(p.id);
          if (projectId === p.id) {
            setSel(null);
            setEvents([]);
          }
        }}
      >
        <p>
          要把项目「<b>{p.name}</b>」从列表里移除吗？
        </p>
        <p className="safe">✓ 不会删除磁盘上的任何文件：项目文件夹 {p.folder} 原样保留，对话记录也仍保存在 logs\runs\ 里。</p>
      </ConfirmModal>,
    );

  const placeholder = !project
    ? "先在上面选一个项目，或新建一个"
    : isNew
      ? "描述你的任务，例如：用 TypeScript 写一个命令行待办事项工具，支持 add/list/done，并配上单元测试"
      : running
        ? "Claude 正在工作…"
        : "继续对 Claude 说（会接着这个对话的上下文）";

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        runs={runs}
        boards={boards}
        activity={activity}
        quota={quota}
        auth={auth}
        sel={sel}
        onSelectRun={selectRun}
        onNewConversation={newConversation}
        onNewProject={openNewProject}
        onRename={(p) => setModal(<RenameModal project={p} onClose={() => setModal(null)} />)}
        onSettings={() => setShowSettings(true)}
        onRemove={removeProject}
        env={env}
      />
      <main className="center">
        <header className="topbar">
          <div className="top-title">
            {project && <span className="crumb">{project.name} ›</span>} {meta ? meta.title : project ? "新对话" : APP_NAME}
          </div>
          <div className="top-sub" title={meta?.workdir ?? project?.folder ?? ""}>
            {(meta?.workdir ?? project?.folder) ? `📁 ${meta?.workdir ?? project?.folder}` : ""}
          </div>
          {meta && (
            <>
              <button className="linkbtn" onClick={() => mao.openPath(meta.workdir)}>
                打开目录
              </button>
              <button className="linkbtn" onClick={() => mao.openRunLogs(meta.id)}>
                运行记录
              </button>
            </>
          )}
        </header>
        <EnvBanner env={env} onRefresh={refreshEnv} />
        <AuthBanner auth={auth} />
        <UpdateBanner />
        <ChatView events={events} running={running} meta={meta} project={project} welcome={{ projects, onPick: newConversation, onNewProject: openNewProject }} authWait={(id) => !!auth?.[id] && auth[id].state !== "ok"} />
        <div
          className={"composer" + (dragOver ? " drag" : "")}
          onDragOver={(e) => {
            if (!canAttach || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (canAttach) addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {error && <div className="composer-error">⚠ {error}</div>}
          {othersRunning.length > 0 && !running && (
            <div className="composer-warn">
              ⚠ 这个项目里还有 {othersRunning.length} 个对话正在运行（{othersRunning.map((r) => `「${r.title}」`).join("、")}），它们和这里共用同一个文件夹。
              Claude 会先查看项目看板、占用要改的文件；如果和别的对话冲突，由 Claude 判断优先级（排队、先做别的或协商），决定会显示在右侧「项目动态」里。
            </div>
          )}
          {needGrant && project && (
            <div className="composer-warn">
              ⚠ DeepSeek 的沙箱在这个项目文件夹里跑不了命令：需要你对 {project.folder} 有「完全控制」权限（其他磁盘上的文件夹常见）。授予后，让 Claude 重新委派即可。
              <SandboxGrant projectId={project.id} />
            </div>
          )}
          {att.length > 0 && <Attachments list={att} onRemove={(a) => setAtt((l) => l.filter((x) => x.path !== a.path))} />}
          <textarea
            value={draft}
            disabled={running || !project}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (!files.length || !canAttach) return;
              e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-actions">
            <button className="btn attach" disabled={!canAttach} title="添加图片或文件（也可以直接 Ctrl+V 粘贴或拖进来；图片 ≤20 MB，文件 ≤50 MB）" onClick={() => mao.pickAttachments().then(addStaged)}>
              📎
            </button>
            {project && <OptionsRow opts={shownOpts} setOpts={changeOpts} models={models} midway={!isNew} />}
            <span className="hint" title="Ctrl+Enter 发送；可以 Ctrl+V 粘贴或拖入图片和文件">Ctrl+Enter 发送</span>
            {running ? (
              <button className="btn danger" onClick={() => meta && mao.stopRun(meta.id)}>
                ■ 停止
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={(!draft.trim() && !att.length) || busy}>
                {busy ? "启动中…" : isNew ? "开始" : "继续"}
              </button>
            )}
          </div>
        </div>
      </main>
      <Panel meta={meta} project={project} events={events} running={running} board={board} runs={runs} quota={quota} auth={auth} onOpenRun={selectRun} />
      {modal}
      {showSettings && (
        <SettingsPage
          agents={agents}
          quota={quota}
          onClose={() => {
            setShowSettings(false);
            mao.getSettings().then((s) => {
              if (!localStorage.getItem("runOptions")) setOptsState(optsFromSettings(s));
            });
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

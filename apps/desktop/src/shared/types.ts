// Types shared by main, preload and renderer.
import type { Board } from "../../../../packages/bridge/src/board";
export type { Board, ConvState, Note, Claim } from "../../../../packages/bridge/src/board";

/** Agent id: "codex", "deepseek" or any id from the agent registry. */
export type Worker = string;
export type { AgentDef } from "../../../../packages/bridge/src/registry";
import type { AgentDef } from "../../../../packages/bridge/src/registry";

export interface Settings {
  claudeModel: string;
  claudeEffort: string;
  codexModel: string;
  codexEffort: string;
  splitSmall: boolean;
  /** Let DeepSeek run commands in its sandbox, supervised (default on). */
  dshCommands: boolean;
  delegateTimeoutSec: number;
  loginWaitSec: number;
  /** The window's X hides the app to the system tray (default on). */
  minimizeToTray: boolean;
  /** The one-time 「已最小化到托盘」 notification was shown. */
  trayHintShown?: boolean;
}

export interface AppInfo {
  version: string;
  packaged: boolean;
  userDir: string;
  dataDir: string;
  runsDir: string;
  resDir: string;
  electron: string;
}

export interface AgentTestResult {
  ok: boolean;
  text: string;
  error?: string;
  durationSec: number;
}

/** Normalized events. The main process parses claude's stream-json into these. */
export type RunEventBody =
  /** steer: sent while Claude was working (live = straight into the running turn, queued = after the turn, redirect = turn interrupted for it) */
  | { k: "user"; text: string; attachments?: Attachment[]; steer?: "live" | "queued" | "redirect"; sid?: string }
  /** Claude has received the steering message sid. */
  | { k: "steer_ack"; sid: string }
  /** A delegation was moved to the background so Claude could read a steering message (bridge id bg). */
  | { k: "delegate_detached"; id: string; bg: string }
  | { k: "init"; model: string; mcp: string; sessionId: string }
  | { k: "text"; text: string }
  | { k: "tool"; id: string; name: string; summary: string }
  | { k: "tool_result"; id: string; isError: boolean; preview: string }
  | { k: "delegate"; id: string; who: Worker; task: string; mode?: string }
  | {
      k: "delegate_result";
      id: string;
      who: Worker;
      status: string; // completed | failed | timeout | spawn_error | error | cancelled
      ok: boolean;
      durationSec?: number;
      tokens?: number;
      files: string[];
      error?: string;
      answer: string;
      /** model the agent used ("默认" = its own default) */
      model?: string;
    }
  | { k: "verdict"; pass: boolean; text: string }
  /** A note / priority decision from another conversation of the same project. */
  | { k: "note"; from: string; fromTitle: string; to: string; kind: "note" | "decision"; text: string; mine: boolean }
  /** Live activity of a worker, tailed from the bridge's per-call log. */
  | { k: "worker"; id: string; who: Worker; kind: "cmd" | "tool" | "say" | "file" | "error"; text: string }
  /** Running token total of a worker (DeepSeek reports per step; Codex only at the end). */
  | { k: "worker_tokens"; id: string; tokens: number }
  | { k: "stderr"; text: string }
  | { k: "result"; ok: boolean; costUsd?: number; durationSec?: number; turns?: number; text: string; outputTokens?: number; tokens?: number }
  | { k: "exit"; code: number | null; stopped: boolean; /** stopped for 打断并改向 (the conversation continues) */ redirect?: boolean };

export type RunEvent = RunEventBody & { seq: number; t: number /* epoch ms */ };

export type RunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

export interface RunOptions {
  /** Tell Claude to split Codex work into small, separately reviewed units. */
  splitSmall: boolean;
  /** Codex model slug; empty = Codex's own default. */
  codexModel: string;
  /** Codex reasoning effort; empty = model default. */
  codexEffort: string;
  /** Claude (lead) model alias or id; empty = Settings default, then Claude Code's own. */
  claudeModel?: string;
  /** Claude reasoning effort; empty = Settings default. */
  claudeEffort?: string;
  /** Files / folders attached in place (「+」→「添加文件路径」): every agent may access them. */
  paths?: PathGrant[];
}

export interface PathGrant {
  path: string;
  kind: "dir" | "file";
  /** false = read-only (default) */
  write: boolean;
}

export interface PathCheck {
  path: string;
  kind: "dir" | "file";
  /** allowed, but very broad: ask the user first */
  warn?: string;
  /** refused */
  error?: string;
}

/** A file the user pasted / dropped / picked; copied into the app's attachments folder. */
export interface Attachment {
  name: string;
  /** absolute path of the copy in the app data folder */
  path: string;
  size: number;
  mime: string;
  image: boolean;
}

/** Result of staging files: the accepted ones plus a message per rejected one. */
export interface StageResult {
  files: Attachment[];
  errors: string[];
}

export interface CodexModel {
  slug: string;
  name: string;
  description: string;
  defaultEffort: string;
  efforts: string[];
}

export interface Project {
  id: string;
  name: string;
  /** All conversations of the project run in this folder. */
  folder: string;
  createdAt: number;
  /** Hidden from the list (files and logs are kept). */
  removed?: boolean;
  /** Created automatically to hold conversations from before projects existed. */
  legacy?: boolean;
}

export interface RunMeta {
  id: string;
  title: string;
  /** Folder this conversation runs in (its project's folder; older runs keep their own). */
  workdir: string;
  projectId?: string;
  options?: RunOptions;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  /** Claude's API-equivalent cost as reported by claude -p. Not money spent on a subscription; kept for reference only. */
  costUsd?: number;
  /** tokens used in this conversation, per agent */
  tokens?: Record<string, number>;
  sessionId?: string;
}

export interface QuotaWindow {
  usedPercent: number;
  /** epoch ms */
  resetsAt: number;
  windowMins?: number;
  status?: string;
}

export interface SubQuota {
  short?: QuotaWindow;
  weekly?: QuotaWindow;
  shortLabel: string;
  plan?: string;
  /** when this was read (epoch ms) */
  at: number;
}

export interface Quota {
  claude?: SubQuota;
  codex?: SubQuota;
  deepseek?: { available?: boolean; balances: { currency: string; total: string }[]; error?: string; at: number };
}

export interface AuthStatus {
  state: "ok" | "needed" | "logging_in" | "timeout" | "cancelled" | "simulated";
  reason?: string;
  at: number;
  /** the CLI printed a login URL that can be reopened */
  hasUrl?: boolean;
}

export interface AuthInfo {
  codex: AuthStatus;
  claude: AuthStatus;
  [agentId: string]: AuthStatus;
}

/** How many runs / delegations each agent is busy with right now. */
export type Activity = Record<string, number>;

export interface EnvStatus {
  /** availability of registry agents (non built-in): id -> reason when unavailable, "" when ok */
  agents?: Record<string, string>;
  claude: string | null;
  codex: string | null;
  dsh: string | null;
  deepseekKey: boolean;
  bridgeBuilt: boolean;
  root: string;
}

export interface MaoApi {
  status(): Promise<EnvStatus>;
  defaultWorkdir(): Promise<string>;
  pickDir(current?: string): Promise<string | null>;
  listRuns(): Promise<RunMeta[]>;
  getRun(id: string): Promise<{ meta: RunMeta; events: RunEvent[] } | null>;
  listProjects(): Promise<Project[]>;
  createProject(name: string, folder: string): Promise<Project>;
  renameProject(id: string, name: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  /** Create <parent>\<name> (reuses it if it already exists); returns the path. */
  createFolder(parent: string, name: string): Promise<string>;
  onProjectsChanged(cb: (projects: Project[]) => void): () => void;
  getBoard(projectId: string): Promise<Board>;
  getActivity(): Promise<Activity>;
  getQuota(): Promise<Quota>;
  getAuth(): Promise<AuthInfo>;
  onAuth(cb: (a: AuthInfo) => void): () => void;
  authAction(agent: string, action: "reopen" | "cancel" | "retry"): Promise<void>;
  listAgents(): Promise<AgentDef[]>;
  agentAvatars(): Promise<Record<string, string>>;
  getUpdate(): Promise<UpdateStatus>;
  checkUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdate(cb: (s: UpdateStatus) => void): () => void;
  /** Tray menu 「新对话」. */
  onTrayNew(cb: () => void): () => void;
  saveAgent(def: AgentDef, apiKey?: string | null): Promise<AgentDef>;
  /** Ready-made agents for「从模板添加」; def is null when the tool isn't installed (note says why). */
  agentPresets(): Promise<{ key: string; label: string; note: string; def: AgentDef | null }[]>;
  removeAgent(id: string): Promise<void>;
  setAgentAvatar(id: string, pngDataUrl: string): Promise<void>;
  testAgent(def: AgentDef, apiKey?: string | null): Promise<AgentTestResult>;
  /** 设置 → 各智能体默认模型 */
  setAgentDefaults(id: string, model: string | null, effort: string | null): Promise<AgentDef>;
  agentModels(id: string): Promise<{ models: string[]; error?: string }>;
  onAgentsChanged(cb: (agents: AgentDef[]) => void): () => void;
  pickImage(): Promise<string | null>;
  pickExecutable(): Promise<string | null>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Partial<Settings>): Promise<Settings>;
  appInfo(): Promise<AppInfo>;
  refreshBalance(): Promise<void>;
  onQuota(cb: (q: Quota) => void): () => void;
  onActivity(cb: (a: Activity) => void): () => void;
  onBoardChanged(cb: (projectId: string, board: Board) => void): () => void;
  startRun(task: string, projectId: string, options: RunOptions, attachments?: Attachment[]): Promise<RunMeta>;
  sendMessage(runId: string, text: string, attachments?: Attachment[]): Promise<void>;
  /** Message while Claude is working: steer = into the running turn, redirect = stop the turn and resume with it. */
  steerRun(runId: string, text: string, attachments: Attachment[] | undefined, mode: "steer" | "redirect"): Promise<void>;
  /** Change a conversation's model / effort options; used from its next message on. */
  setRunOptions(runId: string, options: RunOptions): Promise<void>;
  /** Copy files (by path) into the attachments staging folder. */
  stageFiles(paths: string[]): Promise<StageResult>;
  /** Save a pasted image / file that has no path (e.g. a screenshot) into staging. */
  stageBlob(name: string, mime: string, data: Uint8Array): Promise<StageResult>;
  /** File picker, then stage. */
  pickAttachments(): Promise<StageResult>;
  /** 「添加文件路径」: pick folders / files (paths only, nothing is copied). */
  pickPaths(kind: "dir" | "file"): Promise<PathCheck[]>;
  checkPath(p: string): Promise<PathCheck>;
  /** data: URL of an image attachment (only files inside the attachments folder). */
  attachmentPreview(path: string): Promise<string | null>;
  /** Path of a dropped / pasted File object (Electron webUtils); "" when it has none. */
  pathForFile(f: File): string;
  /** Does the current user have Full Control on a project folder (needed by DeepSeek's sandbox)? */
  sandboxAccess(projectId: string): Promise<{ folder: string; ok: boolean }>;
  /** Grant the current user Full Control on the project folder (icacls), so DeepSeek's sandbox can run there. */
  grantSandbox(projectId: string): Promise<{ ok: boolean; output: string }>;
  stopRun(runId: string): Promise<void>;
  openPath(p: string): Promise<void>;
  openRunLogs(runId: string): Promise<void>;
  codexModels(): Promise<CodexModel[]>;
  buildBridge(): Promise<{ ok: boolean; output: string }>;
  onEvent(cb: (runId: string, ev: RunEvent) => void): () => void;
  onRunsChanged(cb: (runs: RunMeta[]) => void): () => void;
  onSelectRun(cb: (runId: string) => void): () => void;
}

/** Auto-update state (installed build only). */
export interface UpdateStatus {
  state: "idle" | "checking" | "latest" | "downloading" | "ready" | "error";
  current: string;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}
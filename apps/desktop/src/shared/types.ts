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
  delegateTimeoutSec: number;
  loginWaitSec: number;
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
  | { k: "user"; text: string }
  | { k: "init"; model: string; mcp: string; sessionId: string }
  | { k: "text"; text: string }
  | { k: "tool"; id: string; name: string; summary: string }
  | { k: "tool_result"; id: string; isError: boolean; preview: string }
  | { k: "delegate"; id: string; who: Worker; task: string; mode?: string }
  | {
      k: "delegate_result";
      id: string;
      who: Worker;
      status: string; // completed | failed | timeout | spawn_error | error
      ok: boolean;
      durationSec?: number;
      tokens?: number;
      files: string[];
      error?: string;
      answer: string;
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
  | { k: "exit"; code: number | null; stopped: boolean };

export type RunEvent = RunEventBody & { seq: number; t: number /* epoch ms */ };

export type RunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

export interface RunOptions {
  /** Tell Claude to split Codex work into small, separately reviewed units. */
  splitSmall: boolean;
  /** Codex model slug; empty = Codex's own default. */
  codexModel: string;
  /** Codex reasoning effort; empty = model default. */
  codexEffort: string;
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
  saveAgent(def: AgentDef, apiKey?: string | null): Promise<AgentDef>;
  /** Ready-made agents for「从模板添加」; def is null when the tool isn't installed (note says why). */
  agentPresets(): Promise<{ key: string; label: string; note: string; def: AgentDef | null }[]>;
  removeAgent(id: string): Promise<void>;
  setAgentAvatar(id: string, pngDataUrl: string): Promise<void>;
  testAgent(def: AgentDef, apiKey?: string | null): Promise<AgentTestResult>;
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
  startRun(task: string, projectId: string, options: RunOptions): Promise<RunMeta>;
  sendMessage(runId: string, text: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  openPath(p: string): Promise<void>;
  openRunLogs(runId: string): Promise<void>;
  codexModels(): Promise<CodexModel[]>;
  buildBridge(): Promise<{ ok: boolean; output: string }>;
  onEvent(cb: (runId: string, ev: RunEvent) => void): () => void;
  onRunsChanged(cb: (runs: RunMeta[]) => void): () => void;
  onSelectRun(cb: (runId: string) => void): () => void;
}

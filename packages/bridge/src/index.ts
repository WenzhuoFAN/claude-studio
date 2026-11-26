#!/usr/bin/env node
// Stdio MCP server: exposes delegate_to_codex / delegate_to_deepseek to Claude Code,
// plus project-coordination tools when launched by the desktop app (MAO_BOARD_PATH set).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_TIMEOUT_SEC, checkCwd, delegateToCodex, delegateToDeepseek, formatResult } from "./agents.js";
import { cliHealthy, readAgents, runCliAgent, runOpenAiAgent, type AgentDef } from "./registry.js";
import { ensureAgentLogin } from "./auth.js";
import { claimFiles, collabEnabled, delegationConflicts, postNote, projectStatus, readNotes, releaseFiles, takeUnread, waitForFiles } from "./collab.js";
import { cancellers, delegationScope, preCancelled, type AgentResult } from "./runner.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const server = new McpServer({ name: "mao-bridge", version: "0.3.0" });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const toolResult = (r: AgentResult) =>
  // Text only: Claude Code shows structuredContent instead of text when both exist,
  // and the formatted text already carries every field.
  text(formatResult(r) + delegationConflicts(r.filesChanged) + takeUnread(), !r.ok);
const toolError = (e: unknown) => text(`bridge error: ${e instanceof Error ? e.message : String(e)}`, true);

const guard = async (f: () => Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> | { content: { type: "text"; text: string }[]; isError: boolean }) => {
  try {
    return await f();
  } catch (e) {
    return toolError(e);
  }
};

// ---------------------------------------------------------------- steering-aware delegations
// The app bumps steer.json (in this run's log folder) when the user sends a message mid-task.
// Claude only sees that message after the current tool call returns, so a long delegation hands
// control back early and keeps running in the background (wait_delegation / cancel_delegation).
type ToolOut = { content: { type: "text"; text: string }[]; isError: boolean };
interface Tracked {
  id: string;
  who: string;
  promise: Promise<ToolOut>;
  done: boolean;
  result?: ToolOut;
}
const tracked = new Map<string, Tracked>();
let nextDelegation = 1;
const STEER_FILE = process.env.MAO_LOG_DIR ? path.join(process.env.MAO_LOG_DIR, "steer.json") : "";
const steerSeq = () => {
  if (!STEER_FILE) return 0;
  try {
    return Number(JSON.parse(readFileSync(STEER_FILE, "utf8")).seq) || 0;
  } catch {
    return 0;
  }
};
const withId = (id: string, r: ToolOut): ToolOut => ({ ...r, content: [{ type: "text", text: `delegation: ${id}\n${r.content.map((c) => c.text).join("\n")}` }] });

function track(who: string, run: () => Promise<ToolOut>): Promise<ToolOut> {
  const id = `d${nextDelegation++}`;
  const t: Tracked = { id, who, done: false, promise: undefined as unknown as Promise<ToolOut> };
  t.promise = delegationScope.run(id, () => guard(run)).then((r) => {
    t.done = true;
    t.result = withId(id, r);
    return t.result;
  });
  tracked.set(id, t);
  return waitOrSteer(t);
}

async function waitOrSteer(t: Tracked): Promise<ToolOut> {
  if (!STEER_FILE) return t.promise;
  const seq0 = steerSeq();
  let timer: NodeJS.Timeout | undefined;
  const steered = new Promise<"steer">((res) => {
    timer = setInterval(() => steerSeq() > seq0 && res("steer"), 1000);
  });
  try {
    const r = await Promise.race([t.promise, steered]);
    if (r !== "steer") return r;
    return text(
      `DETACHED delegation: ${t.id}\n` +
        `⏸ 用户刚发来一条任务中引导消息（紧跟在这条工具结果之后，你马上会看到）。为了让你立刻看到它，这次委派（${t.who}）已转到后台继续运行，还没有结束。\n` +
        `读完引导后决定：\n` +
        `- 引导不影响这项工作 → 调用 wait_delegation({ id: "${t.id}" }) 继续等它完成并拿到结果；\n` +
        `- 引导让它过时或方向不对 → 调用 cancel_delegation({ id: "${t.id}", reason: "…" })，再按新要求重新委派。\n` +
        `结束本轮回复前，后台委派必须都等完或取消。`,
    );
  } finally {
    clearInterval(timer);
  }
}

server.registerTool(
  "wait_delegation",
  {
    title: "Wait for delegation",
    description:
      "Keep waiting for a delegation that was moved to the background because the user sent a steering message (its id is in the DETACHED notice). Returns its normal result.",
    inputSchema: { id: z.string().describe('Delegation id, e.g. "d3"') },
  },
  ({ id }) =>
    guard(async () => {
      const t = tracked.get(id);
      if (!t) return toolError(`没有编号为 ${id} 的委派`);
      return t.done ? t.result! : waitOrSteer(t);
    }),
);

server.registerTool(
  "cancel_delegation",
  {
    title: "Cancel delegation",
    description:
      "Stop a delegation running in the background (e.g. the user's steering message made it obsolete). Files it already changed stay changed: check them before re-delegating.",
    inputSchema: {
      id: z.string().describe('Delegation id, e.g. "d3"'),
      reason: z.string().describe("Short reason, shown to the user"),
    },
  },
  ({ id, reason }) =>
    guard(async () => {
      const t = tracked.get(id);
      if (!t) return toolError(`没有编号为 ${id} 的委派`);
      if (t.done) return text(`委派 ${id} 已经结束，无法取消。它的结果：\n${t.result!.content[0].text}`);
      const why = `用户引导：${reason}`;
      const c = cancellers.get(id);
      if (c) c(why);
      else preCancelled.set(id, why); // not started yet (e.g. waiting for a login)
      const r = await Promise.race([t.promise, new Promise<null>((res) => setTimeout(() => res(null), 20_000))]);
      return r ?? text(`已请求取消委派 ${id}（它还没启动，例如在等登录）；它不会再开始工作。`);
    }),
);

// The conversation ended (Claude exited): don't leave background workers running.
process.stdin.on("close", () => {
  for (const c of cancellers.values()) c("对话已结束");
  setTimeout(() => process.exit(0), 1500).unref();
});

server.registerTool(
  "delegate_to_codex",
  {
    title: "Delegate to Codex",
    description:
      "Run a self-contained task with OpenAI Codex (codex exec) in a directory. Best for well-defined implementation and refactoring. " +
      "The task text must contain ALL context Codex needs (it cannot see this conversation). " +
      "Returns Codex's final answer, files changed, duration and token usage. Always review the changed files afterwards.",
    inputSchema: {
      task: z.string().min(1).describe("Complete, self-contained instructions for Codex"),
      cwd: z.string().describe("Absolute path of the working directory Codex operates in"),
      mode: z.enum(["read-only", "workspace-write"]).describe("read-only for analysis/review, workspace-write to allow edits inside cwd"),
      allowNetwork: z.boolean().optional().describe("workspace-write only: allow network inside Codex's sandbox (e.g. for npm install). Default false"),
      model: z.string().optional().describe("Codex model slug. Omit to use the user's configured default"),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional().describe("Codex reasoning effort. Omit for the default"),
      timeoutSec: z.number().int().positive().max(3600).optional().describe("Kill after this many seconds (default 900)"),
      images: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Absolute paths of images (e.g. the user's attached screenshots) for Codex to see. Must be inside cwd or the conversation's attachments folder"),
    },
  },
  (args) => track("Codex", async () => toolResult(await delegateToCodex(args))),
);

server.registerTool(
  "delegate_to_deepseek",
  {
    title: "Delegate to DeepSeek",
    description:
      "Run a self-contained task with DeepSeek Harness (dsh headless) in a directory; it may edit files only inside cwd. " +
      "Cheaper: use for boilerplate, tests, docs and second-opinion reviews. " +
      "The task text must contain ALL context it needs. Returns final answer, files changed, duration and token usage. Always review the result.",
    inputSchema: {
      task: z.string().min(1).describe("Complete, self-contained instructions for DeepSeek"),
      cwd: z.string().describe("Absolute path of the working directory"),
      timeoutSec: z.number().int().positive().max(3600).optional().describe("Kill after this many seconds (default 900)"),
      model: z.string().optional().describe("DeepSeek model (deepseek-flash / deepseek-v4-pro). Omit to use the user's default"),
    },
  },
  (args) => track("DeepSeek", async () => toolResult(await delegateToDeepseek(args))),
);

// ---------------------------------------------------------------- registry-driven agents
const agentSummary = (a: AgentDef) =>
  `- ${a.id}（${a.name}）${a.enabled ? "" : "【已停用】"}：${a.role || "（未填写擅长）"}；` +
  `${a.type === "openai" ? "API 文本型：只返回文字/代码，不能直接改文件或运行命令，由你来落地" : `${a.canEdit ? "能改文件" : "不能改文件"}，${a.canRun ? "能运行命令" : "不能运行命令"}`}`;

server.registerTool(
  "list_agents",
  {
    title: "List agents",
    description: "List every agent the user has registered (built-in Codex / DeepSeek plus any added later): id, name, strengths and abilities. Use the id with delegate_to_agent.",
    inputSchema: {},
  },
  () => guard(() => text(readAgents().map(agentSummary).join("\n") || "（没有注册的智能体）")),
);

server.registerTool(
  "delegate_to_agent",
  {
    title: "Delegate to agent",
    description:
      "Delegate a self-contained task to any registered agent by id (see list_agents). Codex and DeepSeek also keep their own tools. " +
      "Text-only (API) agents cannot edit files: they return text or code that YOU must apply and verify. Always review the result.",
    inputSchema: {
      agentId: z.string().describe("Agent id from list_agents"),
      task: z.string().min(1).describe("Complete, self-contained instructions"),
      cwd: z.string().describe("Absolute path of the working directory"),
      mode: z.enum(["read-only", "workspace-write"]).optional().describe("Codex only"),
      model: z.string().optional().describe("Optional model override (if the agent supports {model})"),
      timeoutSec: z.number().int().positive().max(3600).optional(),
    },
  },
  ({ agentId, task, cwd, mode, model, timeoutSec }) =>
    track(agentId, async () => {
      const def = readAgents().find((a) => a.id === agentId);
      if (agentId === "codex" || def?.builtin === "codex") return toolResult(await delegateToCodex({ task, cwd, mode: mode ?? "workspace-write", model, timeoutSec }));
      if (agentId === "deepseek" || def?.builtin === "deepseek") return toolResult(await delegateToDeepseek({ task, cwd, timeoutSec, model }));
      if (!def) return toolError(`没有 id 为 ${agentId} 的智能体。可用：${readAgents().map((a) => a.id).join(", ")}`);
      if (!def.enabled) return toolError(`智能体 ${def.name} 已被用户停用`);
      const dir = checkCwd(cwd);
      const t = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      if (def.type === "cli") {
        const wait = await ensureAgentLogin(def.id, def.name, () => cliHealthy(def), Number(process.env.MAO_LOGIN_WAIT_SEC ?? 600));
        if (wait) return toolError(wait);
        return toolResult(await runCliAgent(def, task, dir, t, model));
      }
      if (def.type === "openai") return toolResult(await runOpenAiAgent(def, task, dir, t, model));
      return toolError(`不支持的智能体类型：${def.type}`);
    }),
);

if (collabEnabled()) {
  server.registerTool(
    "project_status",
    {
      title: "Project status",
      description:
        "Show the other conversations working in this same project folder right now: their goal, progress, and which files they have claimed; plus recent notes and priority decisions. Call it at the start of every run.",
      inputSchema: {},
    },
    () => guard(() => text(projectStatus() + takeUnread())),
  );
  server.registerTool(
    "claim_files",
    {
      title: "Claim files",
      description:
        "Claim files (paths relative to the project folder, or absolute; globs like src/** allowed) before you or a delegate edit them. " +
        "Returns which claims were granted and which conflict with another conversation. On conflict YOU decide priority.",
      inputSchema: {
        paths: z.array(z.string()).min(1),
        reason: z.string().describe("What you will do with them, shown to the other conversations"),
      },
    },
    ({ paths, reason }) => guard(() => text(claimFiles(paths, reason) + takeUnread())),
  );
  server.registerTool(
    "release_files",
    {
      title: "Release files",
      description: "Release claimed files when you are done with them (omit paths to release everything). Always release at the end of a run.",
      inputSchema: { paths: z.array(z.string()).optional() },
    },
    ({ paths }) => guard(() => text(releaseFiles(paths) + takeUnread())),
  );
  server.registerTool(
    "wait_for_files",
    {
      title: "Wait for files",
      description:
        "Queue behind another conversation: blocks until none of these paths is claimed by another conversation (then claims them for you) or the timeout passes. The app shows this conversation as waiting.",
      inputSchema: {
        paths: z.array(z.string()).min(1),
        reason: z.string().describe("Why you are waiting / what you will do afterwards"),
        timeoutSec: z.number().int().positive().max(3000).optional().describe("Default 600"),
      },
    },
    ({ paths, reason, timeoutSec }) => guard(async () => text((await waitForFiles(paths, timeoutSec ?? 600, reason)) + takeUnread())),
  );
  server.registerTool(
    "post_note",
    {
      title: "Post note",
      description:
        'Leave a message for another conversation (its id from project_status) or "all". Use kind "decision" to record a priority decision and its reason; the user sees it in the app.',
      inputSchema: {
        to: z.string().describe('Conversation id, or "all"'),
        text: z.string().min(1),
        kind: z.enum(["note", "decision"]).optional(),
      },
    },
    ({ to, text: t, kind }) => guard(() => text(postNote(to, t, kind ?? "note") + takeUnread())),
  );
  server.registerTool(
    "read_notes",
    { title: "Read notes", description: "Read unread messages from other conversations in this project.", inputSchema: {} },
    () => guard(() => text(readNotes())),
  );
}

await server.connect(new StdioServerTransport());

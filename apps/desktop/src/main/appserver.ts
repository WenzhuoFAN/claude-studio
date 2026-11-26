// Local endpoint the bridge calls to run OpenAI-compatible agents (the key stays in this process).
// Listens on 127.0.0.1 only, random port, requires a random per-session bearer token.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentDef } from "../../../../packages/bridge/src/registry";
import type { AgentStore } from "./agents";

export interface OpenAiResult {
  ok: boolean;
  text: string;
  error?: string;
  timeout?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationSec: number;
  logFile?: string;
}

const SYSTEM = (def: AgentDef) =>
  `你是「${def.name}」，在一个由 Claude 主管的多智能体团队里接受委派。你的擅长：${def.role || "通用"}。\n` +
  "你看不到项目文件，也不能运行命令或修改文件：只根据任务里给出的信息作答。" +
  "如果需要写代码，请给出完整文件内容，每个文件用 ```语言 标注，并在代码块前写明文件路径。最后用一两句话说明你做了什么。";

/**
 * One chat-completions call, streamed (slow local models would otherwise hit fetch's 300 s
 * "no response headers" limit). Never logs the key.
 */
export async function callOpenAi(def: AgentDef, key: string | null, task: string, timeoutSec: number, model?: string, onDelta?: (chars: number) => void): Promise<OpenAiResult> {
  const started = Date.now();
  const base = def.openai!.baseUrl.replace(/\/+$/, "");
  const dur = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: model || def.openai!.model,
        messages: [
          { role: "system", content: SYSTEM(def) },
          { role: "user", content: task },
        ],
        stream: true,
        stream_options: { include_usage: true },
        ...(def.defaultEffort ? { reasoning_effort: def.defaultEffort } : {}),
      }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      return { ok: false, text: "", error: `HTTP ${res.status}: ${String(body?.error?.message ?? body?.error ?? res.statusText).slice(0, 300)}`, durationSec: dur() };
    }
    const ctype = res.headers.get("content-type") ?? "";
    let text = "";
    let usage: any = {};
    if (!ctype.includes("event-stream")) {
      // server ignored stream:true
      const body: any = await res.json();
      text = String(body?.choices?.[0]?.message?.content ?? "");
      usage = body?.usage ?? {};
    } else {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const piece = j?.choices?.[0]?.delta?.content;
            if (typeof piece === "string") {
              text += piece;
              onDelta?.(text.length);
            }
            if (j?.usage) usage = j.usage;
          } catch {
            /* keep-alive or partial line */
          }
        }
      }
    }
    // Some reasoning models wrap thoughts in <think>…</think>; keep only the answer.
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return {
      ok: !!text,
      text,
      error: text ? undefined : "接口返回了空回答",
      usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      durationSec: dur(),
    };
  } catch (e: any) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, text: "", error: timeout ? `超时（${timeoutSec}s）` : String(e?.cause?.message ?? e?.message ?? e).slice(0, 300), timeout, durationSec: dur() };
  }
}
export function startAppServer(agents: AgentStore): Promise<{ url: string; token: string }> {
  const token = randomBytes(24).toString("hex");
  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/agent/run") return send(404, { ok: false, error: "not found" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2_000_000) return send(413, { ok: false, error: "too large" });
    }
    let p: any;
    try {
      p = JSON.parse(raw);
    } catch {
      return send(400, { ok: false, error: "bad json" });
    }
    const def = agents.get(String(p.agentId));
    if (!def || def.type !== "openai" || !def.openai) return send(400, { ok: false, error: "不是 API 类智能体" });
    if (!def.enabled) return send(400, { ok: false, error: `${def.name} 已停用` });
    // Answer headers right away and keep the connection alive: the bridge's fetch would otherwise
    // give up after 300 s without response headers / body data.
    res.writeHead(200, { "content-type": "application/json" });
    const keepAlive = setInterval(() => res.write(" "), 20000);
    let logFile: string | undefined;
    if (p.logDir) {
      try {
        mkdirSync(p.logDir, { recursive: true });
        logFile = path.join(p.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${def.id}.jsonl`);
        appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), kind: "call", agent: def.id, task: p.task, model: p.model ?? def.openai.model }) + "\n");
      } catch {
        logFile = undefined;
      }
    }
    let lastProgress = 0;
    const r = await callOpenAi(def, agents.secret(def.id), String(p.task ?? ""), Number(p.timeoutSec ?? 900), p.model, (n) => {
      // live progress for the UI (tailed like the other workers' logs)
      if (logFile && Date.now() - lastProgress > 3000) {
        lastProgress = Date.now();
        try {
          appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), kind: "stdout", line: `正在生成… 已写 ${n} 字` }) + "\n");
        } catch {
          /* ignore */
        }
      }
    });
    clearInterval(keepAlive);
    // Per-call log next to the other workers' logs (task + answer, never the key).
    if (logFile) {
      try {
        appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), kind: "result", result: { ...r, logFile } }) + "\n");
      } catch {
        /* ignore */
      }
    }
    res.end(JSON.stringify({ ...r, logFile, model: p.model || def.openai.model }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, token })));
}

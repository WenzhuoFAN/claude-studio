import { useEffect, useState } from "react";
import type { AgentDef, AgentTestResult, AppInfo, CodexModel, MaoApi, Project, Quota, Settings, UpdateStatus } from "../../shared/types";
import { EFFORT_TEXT, who } from "./derive";
import { Avatar, DeepseekBalance, QuotaLine } from "./App";
import geminiAvatar from "./assets/avatars/gemini.png";
import dafeiyuAvatar from "./assets/avatars/dafeiyu.png";

const mao = (window as unknown as { mao: MaoApi }).mao;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Center-crop an image (data URL) to a 256×256 PNG; the UI shows it as a circle. */
function cropToSquare(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      // portraits: bias the crop towards the top (faces are usually there)
      const sx = (img.width - s) / 2;
      const sy = img.height > img.width ? Math.min((img.height - s) * 0.15, img.height - s) : (img.height - s) / 2;
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const g = c.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      g.drawImage(img, sx, sy, s, s, 0, 0, 256, 256);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("无法读取这张图片"));
    img.src = src;
  });
}

const PRESET_AVATARS: Record<string, string> = { gemini: geminiAvatar, dafeiyu: dafeiyuAvatar };

/** Bundled image URL → PNG data URL (what setAgentAvatar expects). */
async function toPngDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取头像失败"));
    r.readAsDataURL(blob);
  });
}

type Preset = Awaited<ReturnType<MaoApi["agentPresets"]>>[number];

/** 「从模板添加」: one click adds a ready-made agent (settings + avatar). Adding again updates it. */
function Presets({ agents }: { agents: AgentDef[] }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    mao.agentPresets().then(setPresets).catch(() => {});
  }, []);
  const add = async (p: Preset) => {
    if (!p.def) return setMsg(p.note);
    try {
      const existing = agents.find((a) => a.id === p.def!.id || a.name === p.def!.name);
      const saved = await mao.saveAgent({ ...p.def, id: existing?.id ?? p.def.id });
      const img = PRESET_AVATARS[p.key];
      if (img) await mao.setAgentAvatar(saved.id, await toPngDataUrl(img));
      setMsg(`已${existing ? "更新" : "添加"}「${saved.name}」。${p.note}`);
    } catch (e) {
      setMsg(cleanError(e));
    }
  };
  if (!presets.length) return null;
  return (
    <div className="presets">
      <span className="muted small">从模板添加：</span>
      {presets.map((p) => (
        <button key={p.key} className="btn small" title={p.note} onClick={() => add(p)}>
          ＋ {p.label}
        </button>
      ))}
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}

/** 设置 → 关于: update state and a 「检查更新」 button. */
/** 设置 → DeepSeek 执行命令: the switch, what the supervisor does, and per-project sandbox access. */
function DshCommandsSection({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const [rows, setRows] = useState<{ p: Project; ok: boolean | null; msg?: string }[]>([]);
  const load = async () => {
    const ps = (await mao.listProjects()).filter((p) => !p.removed);
    setRows(ps.map((p) => ({ p, ok: null })));
    for (const p of ps) {
      const r = await mao.sandboxAccess(p.id).catch(() => ({ folder: p.folder, ok: false }));
      setRows((l) => l.map((x) => (x.p.id === p.id ? { ...x, ok: r.ok } : x)));
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <section>
      <h3>DeepSeek 执行命令</h3>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> 允许 DeepSeek 执行命令（受 Claude 监管）
      </label>
      <div className="muted small policy">
        <p>DeepSeek 的命令都在它自己的 Windows 沙箱里运行：只能写项目文件夹（和本对话的附件文件夹），写别处会被系统拒绝。应用还会逐条检查它跑的命令：</p>
        <ul>
          <li>✓ 允许：构建、测试、读取文件、git status/diff/log、npm/npx/node 等工作目录里的常规命令。</li>
          <li>⛔ 拦截（立刻终止 DeepSeek，这次委派算失败）：改注册表 / 服务 / 计划任务 / 权限 / 环境变量，关机重启，格式化磁盘，下载后直接执行，读取凭据文件（.ssh、各家登录信息、浏览器资料），git push / 发布，递归删除工作目录以外或整个工作目录。</li>
          <li>❓ 需复查：联网下载、安装全局工具、启动外部程序、涉及工作目录以外的路径、改写 git 历史。沙箱照常限制它们，命令记录会交给 Claude 审查。</li>
        </ul>
        <p>每条命令和结论都会显示在 DeepSeek 的卡片上，并随委派结果交给 Claude；Claude 审查时会看这份清单，发现可疑命令会单独提醒你，被拦截的命令不会换个方式再跑。</p>
      </div>
      {on && rows.length > 0 && (
        <>
          <div className="small" style={{ marginTop: 8 }}>
            项目文件夹的沙箱权限（DeepSeek 的沙箱需要你对项目文件夹有「完全控制」权限；用户文件夹下的项目一般已经有，其他磁盘上的常常没有）：
          </div>
          <div className="sandbox-list">
            {rows.map(({ p, ok, msg }) => (
              <div key={p.id} className="sandbox-row">
                <b>{p.name}</b>
                <span className="muted small path" title={p.folder}>
                  {p.folder}
                </span>
                {ok === null ? (
                  <span className="muted small">检查中…</span>
                ) : ok ? (
                  <span className="ok-text small">✓ 可以运行</span>
                ) : (
                  <button
                    className="btn small"
                    title="icacls 给当前 Windows 用户这个文件夹的完全控制权限；只影响这个项目文件夹"
                    onClick={async () => {
                      const r = await mao.grantSandbox(p.id).catch((e) => ({ ok: false, output: cleanError(e) }));
                      setRows((l) => l.map((x) => (x.p.id === p.id ? { ...x, ok: r.ok, msg: r.ok ? undefined : r.output } : x)));
                    }}
                  >
                    授予权限
                  </button>
                )}
                {msg && <span className="bad-text small">{msg}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function UpdateRow() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    mao.getUpdate().then(setS);
    return mao.onUpdate(setS);
  }, []);
  if (!s) return null;
  const text: Record<UpdateStatus["state"], string> = {
    idle: "",
    checking: "正在检查…",
    latest: "已是最新版本",
    downloading: `正在下载 v${s.version ?? ""}（${s.percent ?? 0}%）`,
    ready: `v${s.version} 已下载，重启即可更新`,
    error: `检查失败：${s.error ?? ""}`,
  };
  return (
    <div className="update-row">
      <button className="btn small" disabled={s.state === "checking" || s.state === "downloading"} onClick={() => mao.checkUpdate().then(setS)}>
        检查更新
      </button>
      {s.state === "ready" && (
        <button className="btn small primary" onClick={() => mao.installUpdate()}>
          立即重启并更新
        </button>
      )}
      <span className={"small " + (s.state === "error" ? "bad-text" : "muted")}>{text[s.state]}</span>
    </div>
  );
}

const blankAgent = (): AgentDef => ({
  id: "",
  name: "",
  type: "openai",
  color: "#c08cff",
  role: "",
  canEdit: false,
  canRun: false,
  enabled: true,
  cli: { exe: "", args: "", input: "stdin", output: "text", answerField: "", healthCmd: "", loginCmd: "" },
  openai: { baseUrl: "", model: "" },
});

// ------------------------------------------------------------------ add / edit agent
export function AgentEditor({ initial, onClose }: { initial: AgentDef | null; onClose: () => void }) {
  const [d, setD] = useState<AgentDef>(() => {
    const base = blankAgent();
    if (!initial) return base;
    return { ...base, ...initial, cli: { ...base.cli!, ...(initial.cli ?? {}) }, openai: { ...base.openai!, ...(initial.openai ?? {}) } };
  });
  const [avatar, setAvatar] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<AgentTestResult | "running" | null>(null);
  const [saving, setSaving] = useState(false);
  const builtin = !!initial?.builtin;
  const set = (p: Partial<AgentDef>) => setD((x) => ({ ...x, ...p }));
  const setCli = (p: Partial<NonNullable<AgentDef["cli"]>>) => setD((x) => ({ ...x, cli: { ...x.cli!, ...p } }));
  const setApi = (p: Partial<NonNullable<AgentDef["openai"]>>) => setD((x) => ({ ...x, openai: { ...x.openai!, ...p } }));
  const keyArg = () => (clearKey ? null : apiKey ? apiKey : undefined);
  const preview = avatar ?? (initial ? who(initial.id).avatar : undefined);

  const pickAvatar = async () => {
    const src = await mao.pickImage();
    if (!src) return;
    try {
      setAvatar(await cropToSquare(src));
    } catch (e) {
      setErr(cleanError(e));
    }
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await mao.testAgent(d, keyArg() ?? undefined));
    } catch (e) {
      setTest({ ok: false, text: "", error: cleanError(e), durationSec: 0 });
    }
  };
  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      const saved = await mao.saveAgent(d, builtin ? undefined : keyArg());
      if (avatar) await mao.setAgentAvatar(saved.id, avatar);
      onClose();
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="智能体">
        <h3>{initial ? `编辑智能体「${initial.name}」` : "添加智能体"}</h3>
        <div className="ae-grid">
          <div className="ae-avatar">
            <div className="ae-circle" style={{ borderColor: d.color }}>
              {preview ? <img src={preview} alt="" /> : <span style={{ background: d.color }}>{(d.name || "?").slice(0, 1).toUpperCase()}</span>}
            </div>
            <button className="btn small" onClick={pickAvatar}>
              选择头像…
            </button>
            <label className="field inline">
              <span>颜色</span>
              <input type="color" value={d.color} onChange={(e) => set({ color: e.target.value })} />
            </label>
          </div>
          <div className="ae-main">
            <label className="field">
              <span>名称</span>
              <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：本地大肥鱼" />
            </label>
            <label className="field">
              <span>擅长 / 角色说明（Claude 会根据这段话决定派什么活给它）</span>
              <textarea rows={3} value={d.role} onChange={(e) => set({ role: e.target.value })} placeholder="例如：免费的本地模型，适合写文档、注释、简单函数和第二意见评审；速度较慢" />
            </label>
            <label className="check">
              <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 启用（停用后 Claude 不会派活给它）
            </label>
          </div>
        </div>

        {builtin ? (
          <div className="muted small">内置智能体（{initial!.name}）的接入方式是固定的，这里只能改名称、头像、颜色、说明和启用状态。</div>
        ) : (
          <>
            <div className="seg">
              <span>接入方式</span>
              <button className={d.type === "openai" ? "on" : ""} onClick={() => set({ type: "openai" })}>
                OpenAI 兼容接口
              </button>
              <button className={d.type === "cli" ? "on" : ""} onClick={() => set({ type: "cli" })}>
                命令行程序
              </button>
            </div>
            {d.type === "openai" ? (
              <div className="ae-fields">
                <label className="field">
                  <span>接口地址 Base URL（到 /v1 为止）</span>
                  <input value={d.openai!.baseUrl} onChange={(e) => setApi({ baseUrl: e.target.value })} placeholder="http://127.0.0.1:18141/v1" />
                </label>
                <label className="field">
                  <span>模型名</span>
                  <input value={d.openai!.model} onChange={(e) => setApi({ model: e.target.value })} placeholder="deepseek-v4.1-flash" />
                </label>
                <label className="field">
                  <span>API Key（可留空；用系统加密保存，不会明文存盘或写日志）</span>
                  <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial?.openai?.hasKey ? "已保存（留空则不变）" : "本地模型一般不需要"} />
                </label>
                {initial?.openai?.hasKey && (
                  <label className="check">
                    <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> 删除已保存的 Key
                  </label>
                )}
                <div className="muted small">API 类智能体只能返回文字/代码：它看不到项目文件，也不能改文件或运行命令，由 Claude 把结果落地并验证。</div>
              </div>
            ) : (
              <div className="ae-fields">
                <label className="field">
                  <span>可执行文件</span>
                  <div className="row">
                    <input value={d.cli!.exe} onChange={(e) => setCli({ exe: e.target.value })} placeholder="C:\path\to\agent.exe" style={{ flex: 1 }} />
                    <button
                      className="btn small"
                      onClick={async () => {
                        const p = await mao.pickExecutable();
                        if (p) setCli({ exe: p });
                      }}
                    >
                      浏览…
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>参数模板（可用 {"{task}"} {"{cwd}"} {"{model}"} {"{effort}"}；含空格的参数用双引号）</span>
                  <input value={d.cli!.args} onChange={(e) => setCli({ args: e.target.value })} placeholder='例如：run --json -m {model} --dir "{cwd}" -' />
                </label>
                <label className="field">
                  <span>默认模型（填进 {"{model}"}；留空时连同前面的 -m 一起省略，用它自己的默认）</span>
                  <input value={d.defaultModel ?? ""} onChange={(e) => set({ defaultModel: e.target.value })} placeholder="例如：gemini-3-flash-preview" />
                </label>
                <div className="row wrap">
                  <label className="field inline">
                    <span>任务传入</span>
                    <select value={d.cli!.input} onChange={(e) => setCli({ input: e.target.value as "stdin" | "arg" })}>
                      <option value="stdin">标准输入（推荐）</option>
                      <option value="arg">命令行参数</option>
                    </select>
                  </label>
                  <label className="field inline">
                    <span>输出格式</span>
                    <select value={d.cli!.output} onChange={(e) => setCli({ output: e.target.value as "text" | "jsonl" })}>
                      <option value="text">纯文本（全部输出就是回答）</option>
                      <option value="jsonl">JSONL 事件流</option>
                    </select>
                  </label>
                  {d.cli!.output === "jsonl" && (
                    <label className="field inline">
                      <span>回答字段</span>
                      <input value={d.cli!.answerField ?? ""} onChange={(e) => setCli({ answerField: e.target.value })} placeholder="例如 item.text" />
                    </label>
                  )}
                </div>
                <div className="row wrap">
                  <label className="check">
                    <input type="checkbox" checked={d.canEdit} onChange={(e) => set({ canEdit: e.target.checked })} /> 能改文件
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={d.canRun} onChange={(e) => set({ canRun: e.target.checked })} /> 能运行命令
                  </label>
                </div>
                <label className="field">
                  <span>健康 / 登录检查命令（可选，退出码 0 = 正常）</span>
                  <input value={d.cli!.healthCmd ?? ""} onChange={(e) => setCli({ healthCmd: e.target.value })} placeholder="例如：C:\path\agent.exe auth status" />
                </label>
                <label className="field">
                  <span>登录命令（可选，检查不通过时自动运行，和 Codex 的自动登录一样）</span>
                  <input value={d.cli!.loginCmd ?? ""} onChange={(e) => setCli({ loginCmd: e.target.value })} placeholder="例如：C:\path\agent.exe login" />
                </label>
              </div>
            )}
          </>
        )}

        {test && (
          <div className={"test-result " + (test === "running" ? "" : test.ok ? "ok" : "bad")}>
            {test === "running" ? (
              "测试中…（发送一句很短的话，等它回复）"
            ) : (
              <>
                <b>{test.ok ? "✓ 连接正常" : "✗ 测试失败"}</b> · {test.durationSec}s
                {test.error && <div>{test.error}</div>}
                {test.text && <pre>{test.text.slice(0, 600)}</pre>}
              </>
            )}
          </div>
        )}
        {err && <div className="modal-err">⚠ {err}</div>}
        <div className="modal-actions">
          {!builtin && (
            <button className="btn" onClick={runTest} disabled={test === "running"} style={{ marginRight: "auto" }}>
              测试连接
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !d.name.trim()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ------------------------------------------------------------------ 各智能体默认模型
const CLAUDE_MODEL_LIST = ["opus", "sonnet", "fable", "haiku"];
const DSH_EFFORTS = ["off", "low", "medium", "high"];
const API_EFFORTS = ["low", "medium", "high"];
const effortText = (x: string) => (x === "off" ? "关闭思考" : (EFFORT_TEXT[x] ?? x));

/** A model choice: 默认 / known models / 自定义 (free text). */
function ModelPicker(props: { value: string; options: { value: string; label?: string }[]; onChange: (v: string) => void; allowDefault?: boolean; disabled?: boolean; title?: string }) {
  const { value, options, onChange, allowDefault = true } = props;
  const known = options.some((o) => o.value === value) || (!value && allowDefault);
  const [custom, setCustom] = useState(!known);
  const [txt, setTxt] = useState(value);
  useEffect(() => {
    setTxt(value);
    // the model list arrives after the first render: re-decide once it (or the value) changes
    setCustom(!!value && !options.some((o) => o.value === value));
  }, [value, options.map((o) => o.value).join("|")]);
  const commit = () => {
    const t = txt.trim();
    if (t !== value) onChange(t);
  };
  return (
    <div className="mpick" title={props.title}>
      <select
        value={custom ? "__custom" : value}
        disabled={props.disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom") setCustom(true);
          else {
            setCustom(false);
            onChange(v);
          }
        }}
      >
        {allowDefault && <option value="">默认（由该智能体决定）</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
        <option value="__custom">自定义…</option>
      </select>
      {custom && !props.disabled && (
        <input
          value={txt}
          placeholder="输入模型名，回车保存"
          onChange={(e) => setTxt(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      )}
    </div>
  );
}

function EffortPicker(props: { value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean; title?: string }) {
  return (
    <select className="epick" value={props.disabled ? "" : props.value} disabled={props.disabled} title={props.title} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.disabled ? "不支持" : "默认"}</option>
      {props.options.map((x) => (
        <option key={x} value={x}>
          {effortText(x)}
        </option>
      ))}
    </select>
  );
}

function AgentModelsSection(props: { s: Settings; saveSettings: (p: Partial<Settings>) => Promise<void>; agents: AgentDef[]; codexModels: CodexModel[] }) {
  const { s, agents, codexModels } = props;
  const [lists, setLists] = useState<Record<string, { models: string[]; error?: string }>>({});
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const others = agents.filter((a) => a.builtin !== "codex");
  useEffect(() => {
    for (const a of others) mao.agentModels(a.id).then((r) => setLists((x) => ({ ...x, [a.id]: r })));
  }, [others.map((a) => a.id + (a.openai?.baseUrl ?? "")).join("|")]);

  const done = (id: string, p: Promise<unknown>) =>
    p.then(
      () => setMsg({ id, ok: true, text: "已保存，下次委派生效" }),
      (e) => setMsg({ id, ok: false, text: cleanError(e) }),
    );
  const codexModel = codexModels.find((m) => m.slug === s.codexModel);
  const note = (id: string) => (msg?.id === id ? <span className={"small " + (msg.ok ? "ok-text" : "bad-text")}>{msg.text}</span> : null);

  return (
    <section>
      <h3>各智能体默认模型</h3>
      <p className="muted small">每个成员默认用哪个模型、思考多深。Claude 和 Codex 在对话输入框下方还能按对话单独切换；其他成员都用这里的设置（Claude 委派时不会自己改模型，除非你在对话里要求）。</p>
      <div className="amodels">
        <div className="amodel">
          <Avatar who="claude" size={30} />
          <b>Claude</b>
          <ModelPicker value={s.claudeModel} options={CLAUDE_MODEL_LIST.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} onChange={(v) => done("claude", props.saveSettings({ claudeModel: v }))} />
          <EffortPicker value={s.claudeEffort} options={CLAUDE_EFFORTS} onChange={(v) => done("claude", props.saveSettings({ claudeEffort: v }))} title="Claude 思考等级" />
          {note("claude")}
        </div>
        <div className="amodel">
          <Avatar who="codex" size={30} />
          <b>Codex</b>
          <ModelPicker
            value={s.codexModel}
            options={codexModels.map((m) => ({ value: m.slug, label: m.name }))}
            onChange={(v) => done("codex", props.saveSettings({ codexModel: v, codexEffort: "" }))}
          />
          <EffortPicker value={s.codexEffort} options={codexModel?.efforts ?? ["low", "medium", "high", "xhigh"]} onChange={(v) => done("codex", props.saveSettings({ codexEffort: v }))} title="Codex 推理强度" />
          {note("codex")}
        </div>
        {others.map((a) => {
          const l = lists[a.id];
          const isApi = a.type === "openai";
          const isDs = a.builtin === "deepseek";
          const args = a.cli?.args ?? "";
          const modelOk = isApi || isDs || args.includes("{model}");
          const effortOk = isApi || isDs || args.includes("{effort}");
          const model = isApi ? (a.openai?.model ?? "") : (a.defaultModel ?? "");
          const effort = a.defaultEffort ?? "";
          const opts = [...new Set([...(l?.models ?? []), ...(isApi && model ? [model] : [])])].map((m) => ({ value: m }));
          const gemini = /gemini/i.test(`${a.id} ${a.name} ${args}`);
          return (
            <div key={a.id} className={"amodel" + (a.enabled ? "" : " off")}>
              <Avatar who={a.id} size={30} />
              <b>{a.name}</b>
              <ModelPicker
                value={model}
                options={opts}
                allowDefault={!isApi}
                disabled={!modelOk}
                title={modelOk ? undefined : "这个智能体的参数模板里没有 {model}，无法切换模型（在「编辑」里把模型名换成 {model}）"}
                onChange={(v) => done(a.id, mao.setAgentDefaults(a.id, v, null))}
              />
              <EffortPicker
                value={effort}
                options={isDs ? DSH_EFFORTS : isApi ? API_EFFORTS : ["low", "medium", "high"]}
                disabled={!effortOk}
                title={effortOk ? (isApi ? "作为 reasoning_effort 发给接口（接口不支持时可能报错）" : "思考等级") : "这个智能体不支持设置思考等级（参数模板里没有 {effort}）"}
                onChange={(v) => done(a.id, mao.setAgentDefaults(a.id, null, v))}
              />
              {note(a.id) ??
                (gemini ? (
                  <span className="muted small">Pro 没有免费额度，默认用 Flash</span>
                ) : l?.error ? (
                  <span className="muted small" title={l.error}>
                    读取模型列表失败，可自定义
                  </span>
                ) : null)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ settings page
export function SettingsPage({ agents, quota, onClose }: { agents: AgentDef[]; quota: Quota; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [editing, setEditing] = useState<AgentDef | null | "new">(null);
  const [tests, setTests] = useState<Record<string, AgentTestResult | "running">>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    mao.getSettings().then(setS);
    mao.appInfo().then(setInfo);
    mao.codexModels().then(setModels);
  }, []);

  const upd = (p: Partial<Settings>) => {
    setS((x) => (x ? { ...x, ...p } : x));
    setSaved(false);
  };
  const saveAll = async () => {
    if (!s) return;
    setS(await mao.saveSettings(s));
    setSaved(true);
  };
  // Saved right away (the model pickers); keeps unsaved edits of the other fields.
  const saveNow = async (p: Partial<Settings>) => {
    const next = await mao.saveSettings(p);
    setS((x) => (x ? { ...x, ...p } : next));
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>设置</h2>
        <button className="btn" onClick={onClose}>
          ← 返回
        </button>
      </div>
      <div className="settings-body">
        <section>
          <div className="sec-head">
            <h3>智能体</h3>
            <button className="btn primary small" onClick={() => setEditing("new")}>
              ＋ 添加智能体
            </button>
          </div>
          <p className="muted small">Claude 是主管，下面是它可以派活的成员。新增的成员会自动出现在 Claude 的团队名单里（按「擅长」说明分派），不需要改任何代码。</p>
          <Presets agents={agents} />

          <div className="agent-list">
            {agents.map((a) => {
              const t = tests[a.id];
              return (
                <div key={a.id} className={"agent-row" + (a.enabled ? "" : " off")} style={{ ["--ac" as any]: a.color }}>
                  <Avatar who={a.id} size={42} />
                  <div className="ar-main">
                    <div className="ar-top">
                      <b>{a.name}</b>
                      <span className="tag">{a.builtin ? "内置" : a.type === "openai" ? "OpenAI 兼容接口" : "命令行"}</span>
                      {!a.enabled && <span className="tag">已停用</span>}
                      {a.type === "openai" && <span className="tag">{a.openai?.model}</span>}
                    </div>
                    <div className="muted small ar-role">{a.role || "（没有填写擅长）"}</div>
                    {t && <div className={"small " + (t === "running" ? "muted" : t.ok ? "ok-text" : "bad-text")}>{t === "running" ? "测试中…" : t.ok ? `✓ 连接正常（${t.durationSec}s）：${t.text.slice(0, 60)}` : `✗ ${t.error ?? "失败"}`}</div>}
                  </div>
                  <div className="ar-actions">
                    {!a.builtin && (
                      <button
                        className="btn small"
                        onClick={async () => {
                          setTests((x) => ({ ...x, [a.id]: "running" }));
                          const r = await mao.testAgent(a).catch((e) => ({ ok: false, text: "", error: cleanError(e), durationSec: 0 }));
                          setTests((x) => ({ ...x, [a.id]: r }));
                        }}
                      >
                        测试
                      </button>
                    )}
                    <button className="btn small" onClick={() => setEditing(a)}>
                      编辑
                    </button>
                    {!a.builtin && (
                      <button
                        className="btn small danger"
                        onClick={async () => {
                          if (!confirm(`删除智能体「${a.name}」？（只删除这条配置和它保存的 Key，不影响任何项目文件）`)) return;
                          try {
                            await mao.removeAgent(a.id);
                          } catch (e) {
                            setErr(cleanError(e));
                          }
                        }}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {err && <div className="modal-err">⚠ {err}</div>}
        </section>

        {s && <AgentModelsSection s={s} saveSettings={saveNow} agents={agents} codexModels={models} />}

        <section>
          <h3>默认设置</h3>
          {s && (
            <div className="form-grid">
              <label className="field">
                <span>单次委派超时（秒）</span>
                <input type="number" min={60} max={3600} value={s.delegateTimeoutSec} onChange={(e) => upd({ delegateTimeoutSec: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>等待登录的时间（秒，默认 600 = 10 分钟）</span>
                <input type="number" min={30} max={3600} value={s.loginWaitSec} onChange={(e) => upd({ loginWaitSec: Number(e.target.value) })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={s.splitSmall} onChange={(e) => upd({ splitSmall: e.target.checked })} /> 新对话默认「把任务拆小」
              </label>
            </div>
          )}
          <div className="row">
            <button className="btn primary small" onClick={saveAll}>
              保存设置
            </button>
            {saved && <span className="ok-text small">已保存，新对话生效</span>}
          </div>
        </section>

        {s && (
          <section>
            <h3>窗口</h3>
            <label className="check">
              <input type="checkbox" checked={s.minimizeToTray !== false} onChange={async (e) => setS(await mao.saveSettings({ minimizeToTray: e.target.checked }))} /> 关闭窗口时最小化到托盘
            </label>
            <div className="muted small">点窗口右上角的 × 只是隐藏到屏幕右下角的托盘，正在运行的任务继续跑，完成或需要你处理时会弹出 Windows 通知。单击托盘图标打开窗口；真正退出：右键托盘图标 →「退出」，或按 Ctrl+Q。关掉这一项后，× 会直接退出应用。</div>
          </section>
        )}

        {s && <DshCommandsSection on={s.dshCommands !== false} onChange={async (v) => setS(await mao.saveSettings({ dshCommands: v }))} />}

        <section>
          <h3>额度与余额</h3>
          <div className="quota-table">
            <div>
              <Avatar who="claude" size={22} /> Claude <QuotaLine q={quota.claude} />
            </div>
            <div>
              <Avatar who="codex" size={22} /> Codex <QuotaLine q={quota.codex} />
            </div>
            <div>
              <Avatar who="deepseek" size={22} /> DeepSeek <DeepseekBalance q={quota.deepseek} />
              <button className="btn small" onClick={() => mao.refreshBalance()}>
                刷新余额
              </button>
            </div>
          </div>
        </section>

        <section>
          <h3>数据与日志</h3>
          {info && (
            <div className="paths">
              {[
                ["用户数据（项目、看板、智能体、设置）", info.dataDir],
                ["对话记录（每次运行的完整日志）", info.runsDir],
                [info.packaged ? "程序文件" : "源码目录（开发版）", info.resDir],
              ].map(([label, p]) => (
                <div key={label} className="path-row">
                  <span className="muted small">{label}</span>
                  <code title={p}>{p}</code>
                  <button className="btn small" onClick={() => mao.openPath(p)}>
                    打开
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3>关于</h3>
          {info && (
            <p className="muted small">
              Claude 的工作室 v{info.version}（{info.packaged ? "安装版" : "开发版"}） · Electron {info.electron}
            </p>
          )}
          <UpdateRow />
          <p className="muted small">安装版每次启动和之后每 4 小时会到 GitHub 检查新版本，后台下载好后提示重启。只更新程序本身；项目、对话、智能体和设置留在各自的电脑上。</p>
        </section>
      </div>
      {editing && <AgentEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

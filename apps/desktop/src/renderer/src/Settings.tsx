import { useEffect, useState } from "react";
import type { AgentDef, AgentTestResult, AppInfo, CodexModel, MaoApi, Quota, Settings } from "../../shared/types";
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
                  <span>参数模板（可用 {"{task}"} {"{cwd}"} {"{model}"}；含空格的参数用双引号）</span>
                  <input value={d.cli!.args} onChange={(e) => setCli({ args: e.target.value })} placeholder='例如：run --json --dir "{cwd}" -' />
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
  const model = models.find((m) => m.slug === s?.codexModel);

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

        <section>
          <h3>默认设置</h3>
          {s && (
            <div className="form-grid">
              <label className="field">
                <span>Claude 模型（留空 = Claude Code 的默认）</span>
                <input list="claude-models" value={s.claudeModel} onChange={(e) => upd({ claudeModel: e.target.value })} placeholder="默认" />
                <datalist id="claude-models">
                  <option value="opus" />
                  <option value="sonnet" />
                  <option value="fable" />
                  <option value="haiku" />
                </datalist>
              </label>
              <label className="field">
                <span>Claude 推理强度</span>
                <select value={s.claudeEffort} onChange={(e) => upd({ claudeEffort: e.target.value })}>
                  <option value="">默认</option>
                  {CLAUDE_EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {EFFORT_TEXT[x] ?? x}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Codex 模型（新对话的默认值）</span>
                <select value={s.codexModel} onChange={(e) => upd({ codexModel: e.target.value, codexEffort: "" })}>
                  <option value="">默认（Codex 设置）</option>
                  {models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Codex 推理强度</span>
                <select value={s.codexEffort} onChange={(e) => upd({ codexEffort: e.target.value })}>
                  <option value="">默认</option>
                  {(model?.efforts ?? ["low", "medium", "high", "xhigh"]).map((x) => (
                    <option key={x} value={x}>
                      {EFFORT_TEXT[x] ?? x}
                    </option>
                  ))}
                </select>
              </label>
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
        </section>
      </div>
      {editing && <AgentEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

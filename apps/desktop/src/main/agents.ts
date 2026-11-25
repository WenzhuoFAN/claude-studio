// Agent registry for the app: <userData>/data/agents.json (read by the bridge too),
// avatars in <userData>/data/avatars/<id>.png, API keys encrypted with Electron safeStorage (DPAPI on Windows)
// in <userData>/data/secrets.json. Keys are never written in plain text, sent to the renderer, or logged.
import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AgentDef } from "../../../../packages/bridge/src/registry";
import { DATA } from "./paths";

export const AGENTS_FILE = path.join(DATA, "agents.json");
const SECRETS_FILE = path.join(DATA, "secrets.json");
export const AVATAR_DIR = path.join(DATA, "avatars");

export const BUILTINS: AgentDef[] = [
  {
    id: "codex",
    name: "Codex",
    builtin: "codex",
    type: "builtin",
    color: "#19c37d",
    role: "边界清晰的实现、重构、需要严谨推理的核心逻辑",
    canEdit: true,
    canRun: true,
    enabled: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    builtin: "deepseek",
    type: "builtin",
    color: "#5b7cff",
    role: "更便宜：样板代码、单元测试、文档、第二意见代码评审（本机上不能运行命令）",
    canEdit: true,
    canRun: false,
    enabled: true,
  },
];

const writeJson = (f: string, v: unknown) => {
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, f);
};

export class AgentStore extends EventEmitter {
  private list: AgentDef[] = [];

  constructor() {
    super();
    mkdirSync(AVATAR_DIR, { recursive: true });
    try {
      if (existsSync(AGENTS_FILE)) this.list = JSON.parse(readFileSync(AGENTS_FILE, "utf8"));
    } catch {
      this.list = [];
    }
    // Built-ins always exist (editable, not deletable); keep the user's edits.
    for (const b of BUILTINS) if (!this.list.some((a) => a.id === b.id)) this.list.push({ ...b });
    for (const a of this.list) if (a.builtin) a.type = "builtin";
    // Built-ins first (Codex, DeepSeek), then the user's agents in the order they were added.
    const rank = (a: AgentDef) => (a.builtin ? BUILTINS.findIndex((b) => b.id === a.id) : 100);
    this.list = this.list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
    this.save(false);
  }

  private save(emit = true) {
    for (const a of this.list) if (a.type === "openai" && a.openai) a.openai.hasKey = !!this.secret(a.id);
    writeJson(AGENTS_FILE, this.list);
    if (emit) this.emit("changed", this.all());
  }

  all(): AgentDef[] {
    return this.list.map((a) => ({ ...a }));
  }

  get(id: string) {
    return this.list.find((a) => a.id === id);
  }

  upsert(def: AgentDef, apiKey?: string | null): AgentDef {
    const name = def.name?.trim();
    if (!name) throw new Error("名称不能为空");
    let id = def.id?.trim();
    if (!id) {
      id = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent") + "-" + Math.random().toString(36).slice(2, 6);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error("id 只能用小写字母、数字和 -");
    if (id === "claude") throw new Error("claude 是主管的保留 id");
    const old = this.get(id);
    if (old?.builtin) {
      // Built-ins: only presentation / description / enable can change.
      Object.assign(old, { name, color: def.color, role: def.role, enabled: def.enabled, avatar: def.avatar ?? old.avatar });
    } else {
      if (def.type !== "cli" && def.type !== "openai") throw new Error("请选择接入方式（命令行 / OpenAI 兼容接口）");
      if (def.type === "cli" && !def.cli?.exe?.trim()) throw new Error("请填写可执行文件路径");
      if (def.type === "openai" && !def.openai?.baseUrl?.trim()) throw new Error("请填写接口地址（Base URL）");
      if (def.type === "openai" && !def.openai?.model?.trim()) throw new Error("请填写模型名");
      const next: AgentDef = {
        id,
        name,
        type: def.type,
        color: def.color || "#9aa4b2",
        role: def.role ?? "",
        canEdit: def.type === "openai" ? false : !!def.canEdit,
        canRun: def.type === "openai" ? false : !!def.canRun,
        enabled: def.enabled !== false,
        avatar: def.avatar ?? old?.avatar,
        cli: def.type === "cli" ? def.cli : undefined,
        openai: def.type === "openai" ? { baseUrl: def.openai!.baseUrl.trim().replace(/\/+$/, ""), model: def.openai!.model.trim() } : undefined,
      };
      if (old) Object.assign(old, next);
      else this.list.push(next);
    }
    if (apiKey !== undefined) this.setSecret(id, apiKey);
    this.save();
    return { ...this.get(id)! };
  }

  remove(id: string) {
    const a = this.get(id);
    if (!a) return;
    if (a.builtin) throw new Error("内置智能体不能删除，可以停用");
    this.list = this.list.filter((x) => x.id !== id);
    this.setSecret(id, null);
    try {
      unlinkSync(path.join(AVATAR_DIR, `${id}.png`));
    } catch {
      /* no avatar */
    }
    this.save();
  }

  /** Save a cropped avatar (PNG data URL from the renderer). */
  setAvatar(id: string, dataUrl: string) {
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!m) throw new Error("头像格式不对");
    writeFileSync(path.join(AVATAR_DIR, `${id}.png`), Buffer.from(m[1], "base64"));
    const a = this.get(id);
    if (a) {
      a.avatar = `${id}.png`;
      this.save();
    }
  }

  avatarDataUrl(id: string): string | null {
    const a = this.get(id);
    if (!a?.avatar) return null;
    try {
      return "data:image/png;base64," + readFileSync(path.join(AVATAR_DIR, a.avatar)).toString("base64");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------- secrets (encrypted)
  private secrets(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
    } catch {
      return {};
    }
  }

  private setSecret(id: string, key: string | null) {
    const s = this.secrets();
    if (!key) delete s[id];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密不可用，无法安全保存密钥");
      s[id] = safeStorage.encryptString(key).toString("base64");
    }
    writeJson(SECRETS_FILE, s);
  }

  /** Decrypted key, only for use inside the main process. */
  secret(id: string): string | null {
    const v = this.secrets()[id];
    if (!v) return null;
    try {
      return safeStorage.decryptString(Buffer.from(v, "base64"));
    } catch {
      return null;
    }
  }
}

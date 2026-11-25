// Projects: a named folder that holds conversations (runs). Stored in <repo>/data/projects.json.
// Removing a project only hides it from the list; files on disk and run logs are never touched.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Project } from "../shared/types";
import { DATA } from "./paths";
const FILE = path.join(DATA, "projects.json");

function newId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class ProjectStore extends EventEmitter {
  private all: Project[] = [];

  constructor() {
    super();
    mkdirSync(DATA, { recursive: true });
    if (existsSync(FILE)) {
      try {
        this.all = JSON.parse(readFileSync(FILE, "utf8"));
      } catch {
        // keep a copy of the unreadable file instead of overwriting it silently
        renameSync(FILE, FILE + ".broken-" + Date.now());
        this.all = [];
      }
    }
  }

  private save() {
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.all, null, 2));
    renameSync(tmp, FILE);
    this.emit("changed", this.list());
  }

  list(): Project[] {
    return this.all.filter((p) => !p.removed);
  }

  get(id: string): Project | undefined {
    return this.all.find((p) => p.id === id);
  }

  findByFolder(folder: string): Project | undefined {
    const f = path.resolve(folder).toLowerCase();
    return this.list().find((p) => path.resolve(p.folder).toLowerCase() === f);
  }

  create(name: string, folder: string): Project {
    name = name.trim();
    if (!name) throw new Error("项目名称不能为空");
    if (!folder || !path.isAbsolute(folder)) throw new Error("请选择项目文件夹（绝对路径）");
    folder = path.resolve(folder);
    if (!existsSync(folder)) throw new Error(`文件夹不存在：${folder}`);
    const dup = this.findByFolder(folder);
    if (dup) throw new Error(`这个文件夹已经属于项目「${dup.name}」`);
    const p: Project = { id: newId(), name, folder, createdAt: Date.now() };
    this.all.push(p);
    this.save();
    return p;
  }

  rename(id: string, name: string) {
    const p = this.get(id);
    if (!p) throw new Error("没有这个项目");
    if (!name.trim()) throw new Error("项目名称不能为空");
    p.name = name.trim();
    this.save();
  }

  /** Hide from the list. Never deletes anything on disk; conversations stay in logs/runs. */
  remove(id: string) {
    const p = this.get(id);
    if (!p) return;
    p.removed = true;
    this.save();
  }

  /** Make sure a project exists for legacy runs; returns its id. */
  ensureLegacy(name: string, folder: string): string {
    const existing = this.all.find((p) => p.legacy);
    if (existing) return existing.id;
    mkdirSync(folder, { recursive: true });
    const p: Project = { id: newId(), name, folder: path.resolve(folder), createdAt: Date.now(), legacy: true };
    this.all.push(p);
    this.save();
    return p.id;
  }
}

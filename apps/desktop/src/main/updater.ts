// Auto-update from GitHub Releases (electron-updater). Only the installed build updates itself;
// projects, conversations, agents and settings stay on each computer.
// The installer is unsigned, so no publisher check is done (win.verifyUpdateCodeSignature = false).
import { app } from "electron";
import { EventEmitter } from "node:events";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/types";

const EVERY_HOURS = 4;

export class Updater extends EventEmitter {
  status: UpdateStatus = { state: "idle", current: app.getVersion() };
  private started = false;

  constructor() {
    super();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // "稍后" = installs the next time the app is closed
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "latest", checkedAt: Date.now() }));
    autoUpdater.on("update-available", (i) => this.set({ state: "downloading", version: i.version, percent: 0 }));
    autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => this.set({ state: "ready", version: i.version }));
    autoUpdater.on("error", (e) => this.set({ state: "error", error: String(e?.message ?? e).split("\n")[0].slice(0, 300) }));
  }

  private set(p: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...p, current: app.getVersion() };
    this.emit("changed", this.status);
  }

  /** Start periodic checks (installed build only; a development build has nothing to update). */
  start() {
    if (this.started || !app.isPackaged) return;
    this.started = true;
    setTimeout(() => this.check(), 8000);
    setInterval(() => this.check(), EVERY_HOURS * 3600 * 1000);
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: "error", error: "开发版不检查更新（只有安装版会自动更新）" });
      return this.status;
    }
    if (this.status.state === "downloading" || this.status.state === "ready") return this.status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e: any) {
      this.set({ state: "error", error: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
    }
    return this.status;
  }

  /** Restart now and install the downloaded version. */
  install() {
    if (this.status.state === "ready") autoUpdater.quitAndInstall(true, true);
  }
}

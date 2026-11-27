// System tray: closing the window hides it to the notification area (设置 → 关闭窗口时最小化到托盘),
// running tasks keep going, and Windows notifications report when a task ends or needs the user.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { APP_NAME } from "./paths";
import { loadSettings, saveSettings } from "./settings";
import type { RunMeta, UpdateStatus } from "../shared/types";

export interface TrayCtx {
  win: () => BrowserWindow | null;
  runs: () => RunMeta[];
  update: () => UpdateStatus;
  installUpdate: () => void;
}

let ctx: TrayCtx;
let tray: Tray | null = null;
let menu: Menu | null = null;
let tip = "";
let quitting = false;
let base: NativeImage;
let busy: NativeImage;
const iconFile = (ext: "ico" | "png") => path.join(app.getAppPath(), "build", `icon.${ext}`);
const running = () => ctx.runs().filter((r) => r.status === "running");

export const isQuitting = () => quitting;
/** Before a real quit (tray 退出, Ctrl+Q, installing an update, Windows shutting down). */
export function markQuitting() {
  quitting = true;
}

export function showWindow() {
  const w = ctx?.win();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** The app icon with a small green dot (tasks running). */
function withDot(img: NativeImage): NativeImage {
  const S = 32;
  const src = img.resize({ width: S, height: S, quality: "best" });
  const buf = Buffer.from(src.toBitmap()); // BGRA
  const cx = S - 8,
    cy = S - 8,
    r = 7;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      const i = (y * S + x) * 4;
      const ring = d > r - 1.8;
      // ring: dark outline so the dot reads on light and dark taskbars; inside: green (#3fb950)
      buf[i] = ring ? 0x15 : 0x50;
      buf[i + 1] = ring ? 0x11 : 0xb9;
      buf[i + 2] = ring ? 0x0f : 0x3f;
      buf[i + 3] = 0xff;
    }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

export function setupTray(c: TrayCtx) {
  ctx = c;
  const png = nativeImage.createFromPath(iconFile("png"));
  base = process.platform === "win32" ? nativeImage.createFromPath(iconFile("ico")) : png.resize({ width: 32, height: 32 });
  if (base.isEmpty()) base = png;
  busy = withDot(png);
  tray = new Tray(base);
  tray.on("click", () => {
    const w = ctx.win();
    if (w?.isVisible() && w.isFocused()) w.hide();
    else showWindow();
  });
  refreshTray();
  app.on("before-quit", markQuitting);
}

export function refreshTray() {
  if (!tray) return;
  const n = running().length;
  tray.setImage(n ? busy : base);
  tip = APP_NAME + (n ? ` · ${n} 个任务进行中` : "");
  tray.setToolTip(tip);
  const up = ctx.update();
  tray.setContextMenu(
    (menu = Menu.buildFromTemplate([
      { label: "显示主窗口", click: showWindow },
      {
        label: "新对话",
        click: () => {
          showWindow();
          ctx.win()?.webContents.send("trayNew");
        },
      },
      ...(up.state === "ready" ? [{ type: "separator" as const }, { label: `重启并更新到 v${up.version}`, click: () => requestQuit(true) }] : []),
      { type: "separator" },
      { label: "退出", click: () => requestQuit(false) },
    ])),
  );
}

/** Quit for real; asks first while tasks are running (they would be stopped). */
export async function requestQuit(update: boolean) {
  const n = running().length;
  if (n) {
    const w = ctx.win();
    const opts = {
      type: "warning" as const,
      title: APP_NAME,
      message: `还有 ${n} 个任务正在运行，${update ? "重启更新" : "退出"}会停止它们。`,
      detail: "停止的对话之后可以继续（会接着原来的上下文）。",
      buttons: [update ? "停止并重启" : "停止并退出", "取消"],
      defaultId: 1,
      cancelId: 1,
    };
    const r = w && w.isVisible() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) return;
  }
  markQuitting();
  if (update) ctx.installUpdate();
  else app.quit(); // a downloaded update is installed on quit (autoInstallOnAppQuit)
}

/** The window's X: hide to the tray (unless turned off). Returns true when the close was turned into a hide. */
export function onWindowClose(e: Electron.Event): boolean {
  if (quitting || !tray || loadSettings().minimizeToTray === false) return false;
  e.preventDefault();
  ctx.win()?.hide();
  const s = loadSettings();
  if (!s.trayHintShown) {
    saveSettings({ trayHintShown: true });
    notify("已最小化到托盘", "任务会继续运行。单击托盘图标打开窗口，右键托盘图标可以退出。");
  }
  return true;
}

/** Windows notification; clicking it opens the window (and the conversation, if given). */
export function notify(title: string, body: string, runId?: string) {
  console.log("[notify]", title, "/", body);
  if (!Notification.isSupported()) return;
  const n =new Notification({ title, body, icon: iconFile("png"), silent: false });
  n.on("click", () => {
    showWindow();
    if (runId) ctx.win()?.webContents.send("selectRun", runId);
  });
  n.show();
}

/** Notify only when the user is not looking at the window. */
export function notifyAway(title: string, body: string, runId?: string) {
  const w = ctx?.win();
  if (w && w.isVisible() && w.isFocused() && !w.isMinimized()) return;
  notify(title, body, runId);
}

/** Development test hooks (MAO_UI_SCRIPT): the tray click, a tray menu item, the tray state. */
export function trayTest(cmd: string): string {
  if (cmd === "click") tray?.emit("click");
  else if (cmd.startsWith("icon:")) writeFileSync(cmd.slice(5), busy.resize({ width: 128, height: 128, quality: "good" }).toPNG());
  else if (cmd.startsWith("menu:")) {
    const it = menu?.items.find((i) => i.label.startsWith(cmd.slice(5)));
    if (!it) return "no item " + cmd.slice(5);
    it.click();
  }
  const w = ctx.win();
  return JSON.stringify({ tip, items: menu?.items.map((i) => i.label).filter(Boolean), visible: !!w?.isVisible(), running: running().length });
}

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { MaoApi } from "../shared/types";

const on = (channel: string, cb: (...a: any[]) => void) => {
  const h = (_e: unknown, ...a: any[]) => cb(...a);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const api: MaoApi = {
  status: () => ipcRenderer.invoke("status"),
  defaultWorkdir: () => ipcRenderer.invoke("defaultWorkdir"),
  pickDir: (current) => ipcRenderer.invoke("pickDir", current),
  listRuns: () => ipcRenderer.invoke("listRuns"),
  getRun: (id) => ipcRenderer.invoke("getRun", id),
  listProjects: () => ipcRenderer.invoke("listProjects"),
  createProject: (name, folder) => ipcRenderer.invoke("createProject", name, folder),
  renameProject: (id, name) => ipcRenderer.invoke("renameProject", id, name),
  removeProject: (id) => ipcRenderer.invoke("removeProject", id),
  createFolder: (parent, name) => ipcRenderer.invoke("createFolder", parent, name),
  onProjectsChanged: (cb) => on("projectsChanged", cb),
  getBoard: (projectId) => ipcRenderer.invoke("getBoard", projectId),
  onBoardChanged: (cb) => on("boardChanged", cb),
  getActivity: () => ipcRenderer.invoke("getActivity"),
  getQuota: () => ipcRenderer.invoke("getQuota"),
  getAuth: () => ipcRenderer.invoke("getAuth"),
  onAuth: (cb) => on("auth", cb),
  authAction: (agent, action) => ipcRenderer.invoke("authAction", agent, action),
  listAgents: () => ipcRenderer.invoke("listAgents"),
  agentAvatars: () => ipcRenderer.invoke("agentAvatars"),
  saveAgent: (def, apiKey) => ipcRenderer.invoke("saveAgent", def, apiKey),
  agentPresets: () => ipcRenderer.invoke("agentPresets"),
  removeAgent: (id) => ipcRenderer.invoke("removeAgent", id),
  setAgentAvatar: (id, png) => ipcRenderer.invoke("setAgentAvatar", id, png),
  testAgent: (def, apiKey) => ipcRenderer.invoke("testAgent", def, apiKey),
  setAgentDefaults: (id, model, effort) => ipcRenderer.invoke("setAgentDefaults", id, model, effort),
  agentModels: (id) => ipcRenderer.invoke("agentModels", id),
  onAgentsChanged: (cb) => on("agentsChanged", cb),
  getUpdate: () => ipcRenderer.invoke("getUpdate"),
  checkUpdate: () => ipcRenderer.invoke("checkUpdate"),
  installUpdate: () => ipcRenderer.invoke("installUpdate"),
  onUpdate: (cb) => on("update", cb),
  pickImage: () => ipcRenderer.invoke("pickImage"),
  pickExecutable: () => ipcRenderer.invoke("pickExecutable"),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  saveSettings: (s) => ipcRenderer.invoke("saveSettings", s),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  refreshBalance: () => ipcRenderer.invoke("refreshBalance"),
  onQuota: (cb) => on("quota", cb),
  onActivity: (cb) => on("activity", cb),
  startRun: (task, projectId, options, attachments) => ipcRenderer.invoke("startRun", task, projectId, options, attachments),
  sendMessage: (id, text, attachments) => ipcRenderer.invoke("sendMessage", id, text, attachments),
  steerRun: (id, text, attachments, mode) => ipcRenderer.invoke("steerRun", id, text, attachments, mode),
  setRunOptions: (id, options) => ipcRenderer.invoke("setRunOptions", id, options),
  stageFiles: (paths) => ipcRenderer.invoke("stageFiles", paths),
  stageBlob: (name, mime, data) => ipcRenderer.invoke("stageBlob", name, mime, data),
  pickAttachments: () => ipcRenderer.invoke("pickAttachments"),
  attachmentPreview: (p) => ipcRenderer.invoke("attachmentPreview", p),
  sandboxAccess: (projectId) => ipcRenderer.invoke("sandboxAccess", projectId),
  grantSandbox: (projectId) => ipcRenderer.invoke("grantSandbox", projectId),
  pathForFile: (f) => {
    try {
      return webUtils.getPathForFile(f);
    } catch {
      return "";
    }
  },
  stopRun: (id) => ipcRenderer.invoke("stopRun", id),
  openPath: (p) => ipcRenderer.invoke("openPath", p),
  openRunLogs: (id) => ipcRenderer.invoke("openRunLogs", id),
  codexModels: () => ipcRenderer.invoke("codexModels"),
  buildBridge: () => ipcRenderer.invoke("buildBridge"),
  onEvent: (cb) => on("runEvent", cb),
  onRunsChanged: (cb) => on("runsChanged", cb),
  onSelectRun: (cb) => on("selectRun", cb),
};

contextBridge.exposeInMainWorld("mao", api);

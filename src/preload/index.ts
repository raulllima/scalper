import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, BuyMode, DesktopApi } from "../shared/types.js";

const api: DesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings: AppSettings, password?: string, smtpPassword?: string) => ipcRenderer.invoke("settings:save", settings, password, smtpPassword),
    hasPassword: () => ipcRenderer.invoke("settings:hasPassword")
  },
  store: { testConnection: () => ipcRenderer.invoke("store:testConnection") },
  buys: {
    search: (query: string) => ipcRenderer.invoke("buys:search", query),
    start: (input: { productName: string; productUrl?: string; mode: BuyMode }) => ipcRenderer.invoke("buys:start", input),
    cancel: (jobId: string) => ipcRenderer.invoke("buys:cancel", jobId),
    list: () => ipcRenderer.invoke("buys:list")
  },
  watchlist: {
    list: () => ipcRenderer.invoke("watchlist:list"),
    add: (input) => ipcRenderer.invoke("watchlist:add", input),
    pause: (id) => ipcRenderer.invoke("watchlist:pause", id),
    resume: (id) => ipcRenderer.invoke("watchlist:resume", id),
    remove: (id) => ipcRenderer.invoke("watchlist:remove", id)
  },
  logs: { list: () => ipcRenderer.invoke("logs:list") },
  events: {
    onLog: (listener) => { const handler = (_: unknown, log: Parameters<typeof listener>[0]) => listener(log); ipcRenderer.on("logs:entry", handler); return () => ipcRenderer.removeListener("logs:entry", handler); },
    onJob: (listener) => { const handler = (_: unknown, job: Parameters<typeof listener>[0]) => listener(job); ipcRenderer.on("buys:job", handler); return () => ipcRenderer.removeListener("buys:job", handler); },
    onConnection: (listener) => { const handler = (_: unknown, status: Parameters<typeof listener>[0]) => listener(status); ipcRenderer.on("store:connection", handler); return () => ipcRenderer.removeListener("store:connection", handler); },
    onWatch: (listener) => { const handler = (_: unknown, item: Parameters<typeof listener>[0]) => listener(item); ipcRenderer.on("watchlist:item", handler); return () => ipcRenderer.removeListener("watchlist:item", handler); }
  }
};

contextBridge.exposeInMainWorld("desktop", api);

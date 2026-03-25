const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("punscope", {
  // Live UDP entries
  onLogEntry: (cb) => ipcRenderer.on("log-entry", (_e, entry) => cb(entry)),

  // Session save / load
  saveSession: (data) => ipcRenderer.invoke("save-session", data),
  loadSession: () => ipcRenderer.invoke("load-session"),
  loadLogFiles: () => ipcRenderer.invoke("load-log-files"),
});

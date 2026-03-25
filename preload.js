const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("punscope", {
  onLogEntry: (callback) => ipcRenderer.on("log-entry", (_event, entry) => callback(entry)),
});

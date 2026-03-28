const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const dgram = require("dgram");
const path = require("path");
const fs = require("fs");

const UDP_PORT = 9901;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d0f14",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
    title: "Chorus",
  });

  win.setMenuBarVisibility(false);
  win.loadFile("index.html");

  // ── UDP Server ───────────────────────────────────────────────────────────────
  const server = dgram.createSocket("udp4");
  let serverClosed = false;

  function closeServer() {
    if (serverClosed) return;
    serverClosed = true;
    try { server.close(); } catch (_) { }
  }

  server.on("message", (msg) => {
    try {
      const entry = JSON.parse(msg.toString("utf8"));
      if (!win.isDestroyed()) win.webContents.send("log-entry", entry);
    } catch { /* malformed packet — ignore */ }
  });

  server.on("error", (err) => {
    console.error("[Chorus] UDP error:", err.message);
    closeServer();
  });

  server.bind(UDP_PORT, () => {
    console.log(`[Chorus] Listening on UDP port ${UDP_PORT}`);
  });

  win.on("closed", () => closeServer());

  // ── Save session ─────────────────────────────────────────────────────────────
  ipcMain.handle("save-session", async (_event, sessionData) => {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: "Save Chorus Session",
      defaultPath: `chorus-session-${Date.now()}.json`,
      filters: [{ name: "Chorus Session", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), "utf8");
    return { ok: true, filePath };
  });

  // ── Load session (.json) ─────────────────────────────────────────────────────
  ipcMain.handle("load-session", async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: "Load Chorus Session",
      filters: [{ name: "Chorus Session", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return null;
    const raw = fs.readFileSync(filePaths[0], "utf8");
    return JSON.parse(raw);
  });

  // ── Load browser .log files ──────────────────────────────────────────────────
  ipcMain.handle("load-log-files", async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: "Load Browser Log Files",
      filters: [{ name: "Log Files", extensions: ["log", "txt"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (canceled || !filePaths.length) return null;

    return filePaths.map((fp) => ({
      clientId: path.basename(fp, path.extname(fp)),
      content: fs.readFileSync(fp, "utf8"),
    }));
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

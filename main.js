const { app, BrowserWindow, ipcMain } = require("electron");
const dgram = require("dgram");
const path = require("path");

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
    title: "PunScope",
  });

  win.loadFile("index.html");

  // ── UDP Server ─────────────────────────────────────────────────────────────
  const server = dgram.createSocket("udp4");

  server.on("message", (msg) => {
    try {
      const entry = JSON.parse(msg.toString("utf8"));
      // Forward to renderer via IPC
      if (!win.isDestroyed()) {
        win.webContents.send("log-entry", entry);
      }
    } catch {
      // Malformed packet — ignore
    }
  });

  server.on("error", (err) => {
    console.error("[PunScope] UDP error:", err.message);
    server.close();
  });

  server.bind(UDP_PORT, () => {
    console.log(`[PunScope] Listening on UDP port ${UDP_PORT}`);
  });

  // Clean up socket when window closes
  win.on("closed", () => server.close());
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

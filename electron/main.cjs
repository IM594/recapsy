const { app, BrowserWindow } = require("electron");

const { isDev } = require("./config.cjs");
const { startBackend, stopBackend } = require("./backend.cjs");
const { createMainWindow } = require("./window.cjs");
const { log, error } = require("./logger.cjs");

// ---- Log noise filtering (dev only) ----
// Chromium log levels:
// 0=INFO, 1=WARNING, 2=ERROR, 3=FATAL_ERROR, 4=DISABLED
app.commandLine.appendSwitch("log-level", "3");

// Enable HW acceleration for smoother UI.
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

if (isDev) {
  // Intercept stderr to reduce framework noise while developing.
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk, encoding, callback) {
    const msg = String(chunk);

    const isFrameworkNoise =
      /^(\[.*?\])?\s*(\d{4}-\d{2}-\d{2}.*Electron\[|.*ERROR:CONSOLE.*source: devtools:)/.test(
        msg
      );

    if (!isFrameworkNoise) {
      return originalWrite(chunk, encoding, callback);
    }
    if (callback) callback();
    return true;
  };
}

app.whenReady().then(async () => {
  try {
    await startBackend();
    log("Backend server is ready.");

    createMainWindow();
  } catch (err) {
    error("App startup failed:", err);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopBackend();
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  stopBackend();
});

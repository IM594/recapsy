const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

// Electron main process entry (CommonJS).
// This repo uses `electron/main.cjs` as the single source of truth.
const isDev = !app.isPackaged;

function log(...args) {
  console.log("[Electron]", ...args);
}

function warn(...args) {
  console.warn("[Electron]", ...args);
}

function error(...args) {
  console.error("[Electron]", ...args);
}

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

// Backend server process
let backendProcess = null;
const backendPort = 3456;

function startBackend() {
  return new Promise((resolve, reject) => {
    const backendPath = isDev
      ? path.join(__dirname, "../backend/src/api/server.ts")
      : path.join(process.resourcesPath, "backend/dist/api/server.js");

    const backendDir = isDev
      ? path.join(__dirname, "../backend")
      : path.join(process.resourcesPath, "backend");

    const envPath = path.join(backendDir, ".env");

    if (!fs.existsSync(envPath)) {
      warn("Backend .env not found; the backend may not work correctly.");
    } else {
      log("Backend .env found:", envPath);
    }

    log("Starting backend server...");
    log("Backend cwd:", backendDir);

    const command = isDev ? "npx" : "node";
    const args = isDev ? ["tsx", backendPath] : [backendPath];

    backendProcess = spawn(command, args, {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
      },
      stdio: "pipe",
      shell: true,
    });

    backendProcess.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Backend] ${output}`);
        // Resolve when backend prints its listen URL.
        if (output.includes(`http://localhost:${backendPort}`)) {
          resolve();
        }
      }
    });

    backendProcess.stderr.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Backend Error] ${output}`);
      }
    });

    backendProcess.on("error", (err) => {
      error("Backend failed to start:", err);
      reject(err);
    });

    backendProcess.on("exit", (code) => {
      log(`Backend process exited (code: ${code})`);
      backendProcess = null;
    });

    // Fallback: resolve after a short delay (backend might already be running).
    setTimeout(() => {
      if (backendProcess) {
        log("Backend startup check timed out; continuing anyway.");
        resolve();
      }
    }, 5000);
  });
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    // DevTools (optional)
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }
}

app.whenReady().then(async () => {
  try {
    await startBackend();
    log("Backend server is ready.");

    createWindow();
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
    createWindow();
  }
});

app.on("before-quit", () => {
  stopBackend();
});

const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const { isDev, backendPort } = require("./config");
const { log, warn, error } = require("./logger");

let backendProcess = null;
let stopServer = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

async function waitForBackendHealth({ port, timeoutMs }) {
  const start = Date.now();
  const url = `http://localhost:${port}/health`;

  while (Date.now() - start < timeoutMs) {
    try {
      const json = await httpGetJson(url);
      if (json && json.status === "ok") return true;
    } catch {
      // ignore until timeout
    }
    await delay(250);
  }

  return false;
}

function getBackendPaths() {
  const backendDir = isDev
    ? path.join(__dirname, "../backend")
    : path.join(process.resourcesPath, "backend");

  const entryPath = isDev
    ? path.join(__dirname, "../backend/src/api/server.ts")
    : path.join(process.resourcesPath, "backend/dist/api/server.js");

  return { backendDir, entryPath };
}

async function startBackendDev() {
  const { backendDir, entryPath } = getBackendPaths();
  const envPath = path.join(backendDir, ".env");

  if (!fs.existsSync(envPath)) {
    warn("Backend .env not found; the backend may not work correctly.");
  } else {
    log("Backend .env found:", envPath);
  }

  log("Starting backend server (dev)...");
  log("Backend cwd:", backendDir);

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["tsx", entryPath];

  backendProcess = spawn(command, args, {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(backendPort),
    },
    stdio: "pipe",
  });

  backendProcess.stdout.on("data", (data) => {
    const output = String(data).trim();
    if (output) console.log(`[Backend] ${output}`);
  });

  backendProcess.stderr.on("data", (data) => {
    const output = String(data).trim();
    if (output) console.error(`[Backend Error] ${output}`);
  });

  backendProcess.on("error", (err) => {
    error("Backend process error:", err);
  });

  backendProcess.on("exit", (code) => {
    log(`Backend process exited (code: ${code})`);
    backendProcess = null;
  });

  const healthy = await waitForBackendHealth({ port: backendPort, timeoutMs: 12_000 });
  if (!healthy) {
    warn("Backend health check timed out; continuing anyway.");
  }
}

async function startBackendProd() {
  log("Starting backend server (prod, in-process)...");
  const backendDir = path.join(process.resourcesPath, "backend");
  const envPath = path.join(backendDir, ".env");

  if (fs.existsSync(envPath)) {
    // eslint-disable-next-line global-require
    require("dotenv").config({ path: envPath });
    log("Backend .env loaded:", envPath);
  } else {
    warn("Backend .env not found; the backend may not work correctly.");
  }

  const serverModulePath = path.join(
    process.resourcesPath,
    "backend/dist/api/server.js"
  );

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const serverModule = require(serverModulePath);

  if (typeof serverModule.startServer !== "function") {
    throw new Error("backend/dist/api/server.js does not export startServer()");
  }

  if (typeof serverModule.stopServer === "function") {
    stopServer = serverModule.stopServer;
  }

  await serverModule.startServer(backendPort);
}

async function startBackend() {
  if (isDev) return startBackendDev();
  return startBackendProd();
}

async function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }

  if (stopServer) {
    try {
      await stopServer();
    } catch (e) {
      warn("Failed to stop backend server:", e);
    } finally {
      stopServer = null;
    }
  }
}

module.exports = { startBackend, stopBackend, backendPort };

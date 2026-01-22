const { app } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;

const backendPort = (() => {
  const raw = process.env.RECAPLY_BACKEND_PORT;
  if (!raw) return 3456;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 3456;
})();

const devServerUrl = process.env.RECAPLY_DEV_SERVER_URL || "http://localhost:5173";

const mainWindowDefaults = {
  width: 1200,
  height: 800,
  minWidth: 800,
  minHeight: 600,
  titleBarStyle: "hiddenInset",
  backgroundColor: "#ffffff",
  show: false,
};

function getPreloadPath() {
  return path.join(__dirname, "preload.cjs");
}

function getFrontendEntry() {
  if (isDev) return { kind: "url", value: devServerUrl };
  return {
    kind: "file",
    value: path.join(__dirname, "../frontend/dist/index.html"),
  };
}

module.exports = {
  isDev,
  backendPort,
  devServerUrl,
  mainWindowDefaults,
  getPreloadPath,
  getFrontendEntry,
};


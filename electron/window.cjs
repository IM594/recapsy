const { BrowserWindow } = require("electron");

const { getFrontendEntry, getPreloadPath, mainWindowDefaults } = require("./config");
const { log } = require("./logger");

function createMainWindow() {
  const win = new BrowserWindow({
    ...mainWindowDefaults,
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  const entry = getFrontendEntry();
  if (entry.kind === "url") {
    log("Loading renderer URL:", entry.value);
    win.loadURL(entry.value);
    return win;
  }

  log("Loading renderer file:", entry.value);
  win.loadFile(entry.value);
  return win;
}

module.exports = { createMainWindow };


const { contextBridge } = require("electron");

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

const homeDir = asNonEmptyString(process.env.HOME) || "";

contextBridge.exposeInMainWorld("recaply", {
  env: {
    homeDir,
  },
});


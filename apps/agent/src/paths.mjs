import os from "node:os";
import path from "node:path";

export function resolveDataDir() {
  const configured = process.env.RECAPSENSE_DATA_DIR;
  if (configured && configured.trim() !== "") {
    return configured;
  }

  // 开发默认：把所有状态都放在仓库内，便于调试与清理。
  return path.join(process.cwd(), ".recapsense");
}

export function resolveDefaultMacOSDataDir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecapSense"
  );
}

export function tokenFilePath(dataDir) {
  return path.join(dataDir, "secret", "token");
}

export function dbFilePath(dataDir) {
  return path.join(dataDir, "db", "recapsense.db");
}

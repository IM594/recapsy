import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 1) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    // EPERM：存在但无权限；保守视为仍在运行。
    return true;
  }
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePidFromLockPayload(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  const json = parseJsonSafe(trimmed);
  if (json && typeof json === "object") {
    const pid = Number(json.pid);
    if (Number.isFinite(pid)) return pid;
  }

  const pid = Number.parseInt(trimmed, 10);
  if (Number.isFinite(pid)) return pid;
  return null;
}

export async function acquireDataDirLock({
  dataDir,
  label,
  serviceName,
  installProcessHandlers = true,
} = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  if (!label) throw new Error("label is required");

  const lockFile = path.join(dataDir, "run", `${label}.lock`);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const payload = JSON.stringify(
    { pid: process.pid, service: serviceName, startedAt: Date.now() },
    null,
    2
  );

  try {
    await fs.writeFile(lockFile, `${payload}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) {
      throw error;
    }

    const existingRaw = await fs.readFile(lockFile, "utf8").catch(() => "");
    const existingPid = parsePidFromLockPayload(existingRaw);

    if (existingPid != null && isPidAlive(existingPid)) {
      throw new Error(
        `[agent] 检测到已有 Agent 正在使用同一数据目录（pid=${existingPid} lock=${lockFile}），为避免多实例，本进程退出`
      );
    }

    // 锁文件存在但 pid 不存活：视为遗留，清理后重试一次。
    await removeFileIfExists(lockFile);
    await fs.writeFile(lockFile, `${payload}\n`, { encoding: "utf8", flag: "wx" });
  }

  if (installProcessHandlers) {
    const cleanupSync = () => {
      try {
        fsSync.unlinkSync(lockFile);
      } catch {
        // ignore
      }
    };

    process.once("exit", cleanupSync);
    process.once("SIGINT", () => {
      cleanupSync();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      cleanupSync();
      process.exit(0);
    });
  }

  return { lockFile };
}

export const __test = {
  isPidAlive,
  parsePidFromLockPayload,
};

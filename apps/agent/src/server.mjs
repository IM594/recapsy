import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";
import { loadOrCreateApiToken } from "./secrets.mjs";
import { openDatabase } from "./db.mjs";
import { createDatabaseSnapshot } from "./backup.mjs";
import { createStore } from "./store.mjs";
import { readJson, requireAuth, sendJson } from "./http.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4832;
const SERVICE_NAME = "recapsense-agent";

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

async function scanDirectorySize(rootDir, { fileConcurrency = 16 } = {}) {
  const concurrency = Number.isFinite(fileConcurrency)
    ? Math.max(1, Math.min(64, Math.floor(fileConcurrency)))
    : 16;

  let totalBytes = 0;
  let fileCount = 0;

  const dirStack = [rootDir];
  while (dirStack.length > 0) {
    const dir = dirStack.pop();

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const files = [];
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.isDirectory()) {
        dirStack.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }

    if (files.length === 0) continue;

    let index = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, files.length) },
      async () => {
        while (index < files.length) {
          const current = files[index];
          index += 1;

          try {
            const stat = await fs.stat(current);
            totalBytes += Number(stat.size ?? 0);
            fileCount += 1;
          } catch (error) {
            // 文件可能在扫描过程中被清理/移动；尽力而为即可。
            if (error && typeof error === "object" && error.code === "ENOENT") continue;
            throw error;
          }
        }
      }
    );

    await Promise.all(workers);
  }

  return { totalBytes, fileCount };
}

function formatLocalTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms}`;
}

function installTimestampedConsole() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const prefix = () => `[${formatLocalTimestamp()}]`;
  console.log = (...args) => original.log(prefix(), ...args);
  console.warn = (...args) => original.warn(prefix(), ...args);
  console.error = (...args) => original.error(prefix(), ...args);
}

function installParentWatchdog(label) {
  const raw = process.env.RECAPSENSE_PARENT_PID;
  if (!raw) return;
  const parentPid = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parentPid) || parentPid <= 1) return;

  const check = () => {
    // 组合判断，尽量减少 PID 被复用导致误判的概率：
    // - 如果 ppid 变成 1，几乎可以确定父进程已死（被 init/launchd 接管）。
    // - 否则再用 kill(pid, 0) 做一次存在性检测。
    if (process.ppid === 1) {
      console.warn(`[${label}] parent pid missing (ppid=1), exiting`);
      process.exit(0);
    }

    try {
      process.kill(parentPid, 0);
    } catch (error) {
      // ESRCH：进程不存在；EPERM：存在但无权限（视为仍然存在）。
      if (error && typeof error === "object" && error.code === "ESRCH") {
        console.warn(`[${label}] parent pid missing (${parentPid}), exiting`);
        process.exit(0);
      }
    }
  };

  check();
  const timer = setInterval(check, 1000);
  timer.unref();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveSocketPath(dataDir) {
  const raw = process.env.RECAPSENSE_AGENT_SOCKET;
  if (!raw || raw.trim() === "") return null;

  const trimmed = raw.trim();
  if (trimmed === "1" || trimmed.toLowerCase() === "true") {
    return path.join(dataDir, "run", "agent.sock");
  }

  if (path.isAbsolute(trimmed)) return trimmed;
  return path.join(dataDir, trimmed);
}

async function removeFileIfExists(filePath) {
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

async function acquireDataDirLock({ dataDir, label }) {
  const lockFile = path.join(dataDir, "run", `${label}.lock`);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const payload = JSON.stringify(
    { pid: process.pid, service: SERVICE_NAME, startedAt: Date.now() },
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

  return { lockFile };
}

async function writeAgentRunInfo({ dataDir, host, port, disableTcp, socketPath, tcpOk, socketOk }) {
  const filePath = path.join(dataDir, "run", "agent.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tcpUrl = tcpOk && !disableTcp ? `http://${host}:${port}` : null;

  const payload = {
    service: SERVICE_NAME,
    pid: process.pid,
    dataDir,
    startedAt: new Date().toISOString(),
    listeners: {
      tcp: tcpOk && !disableTcp ? { host, port, url: tcpUrl } : null,
      socket: socketOk && socketPath ? { path: socketPath } : null,
    },
  };

  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLimit(value, fallback = 20) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, parsed));
}

function logSessionSeparator() {
  const line = "=".repeat(78);
  console.log(`[agent] ${line}`);
  console.log(`[agent] 启动分割（pid=${process.pid}）`);
  console.log(`[agent] argv：${process.argv.join(" ")}`);
  console.log(`[agent] ${line}`);
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function probeAgentHealthOverTcp({ host, port, timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/health", method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          const body = Buffer.concat(chunks).toString("utf8");
          const json = parseJsonSafe(body);
          const service = json && typeof json === "object" ? json.service : null;
          resolve(service);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });

    req.on("error", () => resolve(null));
    req.end();
  });
}

function probeAgentHealthOverSocket({ socketPath, timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: "/health", method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          const body = Buffer.concat(chunks).toString("utf8");
          const json = parseJsonSafe(body);
          const service = json && typeof json === "object" ? json.service : null;
          resolve(service);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });

    req.on("error", () => resolve(null));
    req.end();
  });
}

async function detectExistingAgent({
  host,
  port,
  socketPath,
  disableTcp,
} = {}) {
  if (!disableTcp) {
    const service = await probeAgentHealthOverTcp({ host, port });
    if (service === SERVICE_NAME) return { via: "tcp" };
  }

  if (socketPath) {
    const service = await probeAgentHealthOverSocket({ socketPath });
    if (service === SERVICE_NAME) return { via: "socket" };
  }

  return null;
}

async function main() {
  installTimestampedConsole();
  installParentWatchdog("agent");
  logSessionSeparator();

  const dataDir = resolveDataDir();

  const host = process.env.RECAPSENSE_AGENT_HOST ?? DEFAULT_HOST;
  const disableTcp = process.env.RECAPSENSE_AGENT_DISABLE_TCP === "1";
  const port = Number.parseInt(
    process.env.RECAPSENSE_AGENT_PORT ?? String(DEFAULT_PORT),
    10
  );
  const socketPath = resolveSocketPath(dataDir);

  // 单实例锁（按 dataDir）：避免多个 Agent 同时写同一个 SQLite（风险极高）。
  try {
    await acquireDataDirLock({ dataDir, label: "agent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // dataDir 已被占用：视为“正常退出”，不标记 fatal。
    if (message.includes("同一数据目录")) {
      console.warn(message);
      return;
    }
    throw error;
  }

  const existing = await detectExistingAgent({
    host,
    port,
    socketPath,
    disableTcp,
  });
  if (existing) {
    console.warn(
      `[agent] 检测到已有 Agent 正在运行（via=${existing.via}），为避免多实例，本进程退出`
    );
    return;
  }

  const token = await loadOrCreateApiToken(dataDir);
  let store = null;
  let dbConn = null;

  function resolveSafePath(maybeRelativePath) {
    const raw = String(maybeRelativePath ?? "").trim();
    if (!raw) return null;
    if (path.isAbsolute(raw)) return null;

    const absolute = path.resolve(dataDir, raw);
    const root = path.resolve(dataDir);
    if (!absolute.startsWith(root + path.sep)) {
      return null;
    }
    return absolute;
  }

  const mediaDir = path.join(dataDir, "media");
  const mediaWarnCooldownMs = 24 * 60 * 60_000;
  const mediaStatsCacheTtlMs = 6 * 60 * 60_000;
  let mediaStatsCache = null;
  let mediaStatsInFlight = null;
  let lastMediaWarnedAt = 0;

  async function getMediaStats({ refresh = false } = {}) {
    if (!store) {
      throw new Error("Agent is starting");
    }

    const now = Date.now();
    const cachedOk =
      !refresh &&
      mediaStatsCache &&
      Number.isFinite(mediaStatsCache.scannedAt) &&
      now - mediaStatsCache.scannedAt < mediaStatsCacheTtlMs;
    if (cachedOk) return mediaStatsCache;

    if (mediaStatsInFlight) return mediaStatsInFlight;

    mediaStatsInFlight = (async () => {
      const settings = store.getSettings();
      const thresholdBytes = Number(settings.agent.mediaWarnThresholdBytes ?? 0);

      const { totalBytes, fileCount } = await scanDirectorySize(mediaDir, {
        fileConcurrency: 16,
      });

      const stats = {
        totalBytes,
        fileCount,
        thresholdBytes,
        overThreshold: Number.isFinite(thresholdBytes) && thresholdBytes > 0
          ? totalBytes >= thresholdBytes
          : false,
        scannedAt: now,
      };

      mediaStatsCache = stats;
      return stats;
    })().finally(() => {
      mediaStatsInFlight = null;
    });

    return mediaStatsInFlight;
  }

  async function sendFileStream(
    res,
    filePath,
    { filename, contentType = "application/octet-stream", cleanup } = {}
  ) {
    const stat = await fs.stat(filePath);

    const headers = {
      "Content-Type": contentType,
      "Content-Length": String(stat.size ?? 0),
      "Cache-Control": "no-store",
    };

    if (filename && String(filename).trim() !== "") {
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }

    res.writeHead(200, headers);

    let cleaned = false;
    const finalize = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        cleanup?.();
      } catch {
        // ignore cleanup error
      }
    };

    res.once("finish", finalize);
    res.once("close", finalize);

    const stream = fsSync.createReadStream(filePath);
    stream.once("close", finalize);
    stream.on("error", (error) => {
      console.warn("[agent] stream file error:", error);
      try {
        res.end();
      } catch {
        // ignore
      }
      finalize();
    });
    stream.pipe(res);
  }

  async function maybeWarnMediaSize() {
    if (!store) return;

    const settings = store.getSettings();
    const thresholdBytes = Number(settings.agent.mediaWarnThresholdBytes ?? 0);
    if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return;

    const stats = await getMediaStats({ refresh: false });
    if (!stats.overThreshold) return;

    const now = Date.now();
    if (lastMediaWarnedAt > 0 && now - lastMediaWarnedAt < mediaWarnCooldownMs) return;
    lastMediaWarnedAt = now;

    console.warn(
      `[agent] media 占用已超过阈值：media=${formatBytes(stats.totalBytes)} threshold=${formatBytes(thresholdBytes)}。建议尽快备份数据目录（dataDir=${dataDir}），或调整“热证据保留天数/缩略图开关/阈值”。`
    );
  }

  async function cleanupEvidence({
    retentionDays,
    maxFramesPerRun = 5000,
  } = {}) {
    const effectiveRetentionDays =
      retentionDays ?? store.getSettings().agent.evidenceRetentionDays;
    const retentionMs = Number(effectiveRetentionDays) * 24 * 60 * 60_000;
    const cutoffTs = Date.now() - retentionMs;

    // 说明：frames 的原始文本永久保留（可反悔）。
    // 定时清理只处理“已压实进 chunks 的 frames”的媒体文件（截图/缩略图），并清空路径字段，避免悬挂引用。
    const expired = store.expireChunkedFrameMedia({
      cutoffTs,
      maxFramesPerRun,
    });

    let deletedFiles = 0;
    let skippedPaths = 0;
    let fileErrors = 0;

    for (const filePath of expired.filePaths) {
      const absolute = resolveSafePath(filePath);
      if (!absolute) {
        skippedPaths += 1;
        continue;
      }
      try {
        await fs.unlink(absolute);
        deletedFiles += 1;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        fileErrors += 1;
        console.warn("[agent] cleanup file error:", absolute, error);
      }
    }

    return {
      retentionDays: Number(effectiveRetentionDays),
      cutoffTs,
      // 兼容字段：历史上 cleanup 会删除 frames；现在不再删除，仅清理 media。
      deletedFrames: 0,
      clearedFrames: expired.clearedFrames,
      deletedFiles,
      skippedPaths,
      fileErrors,
    };
  }

  async function deleteEvidenceFiles(filePaths) {
    let deletedFiles = 0;
    let skippedPaths = 0;
    let fileErrors = 0;

    for (const filePath of filePaths ?? []) {
      const absolute = resolveSafePath(filePath);
      if (!absolute) {
        skippedPaths += 1;
        continue;
      }
      try {
        await fs.unlink(absolute);
        deletedFiles += 1;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        fileErrors += 1;
        console.warn("[agent] danger zone file delete error:", absolute, error);
      }
    }

    return { deletedFiles, skippedPaths, fileErrors };
  }

  async function deleteMediaDirectory() {
    // scope=all 时，我们直接删除整个 media 目录（热证据）。
    // 这是“尽力而为”的删除：失败不应阻塞 DB 清空。
    const mediaDir = path.join(dataDir, "media");
    try {
      await fs.rm(mediaDir, { recursive: true, force: true });
      return { ok: true, mediaDir };
    } catch (error) {
      console.warn("[agent] delete media dir failed (ignored):", mediaDir, error);
      return { ok: false, mediaDir };
    }
  }

  // 证据清理任务：从 settings 读取间隔，允许 UI 动态修改后生效（无需重启 Agent）。
  const scheduleEvidenceCleanup = () => {
    const intervalMinutes = store.getSettings().agent.evidenceCleanupIntervalMinutes;
    const delayMs = Math.max(1, Number(intervalMinutes)) * 60_000;

    const timer = setTimeout(() => {
      cleanupEvidence()
        .then((result) => {
          if (result.clearedFrames > 0 || result.deletedFiles > 0) {
            console.log(
              `[agent] cleanup evidence: clearedFrames=${result.clearedFrames} deletedFiles=${result.deletedFiles} (retentionDays=${result.retentionDays})`
            );
          }
          if (result.fileErrors > 0) {
            console.warn(
              `[agent] cleanup evidence had fileErrors=${result.fileErrors}`
            );
          }
          // 提醒：media 只清理“到期部分”，但用户可能希望“越久越好”并手动备份；
          // 因此我们提供一个超阈值提醒（不自动清理）。
          return maybeWarnMediaSize();
        })
        .catch((error) => {
          console.warn("[agent] cleanup evidence error:", error);
        })
        .finally(() => {
          scheduleEvidenceCleanup();
        });
    }, delayMs);
    timer.unref();
  };

  console.log(`[agent] dataDir: ${dataDir}`);
  console.log(`[agent] tokenFile: ${dataDir}/secret/token`);
  console.log(`[agent] tokenHint: ****${token.slice(-6)}`);

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      if (url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          pid: process.pid,
        });
      }

      if (!url.pathname.startsWith("/v1/")) {
        return sendJson(res, 404, { error: "Not found" });
      }

      requireAuth(req, token);

      if (!store) {
        return sendJson(res, 503, { error: "Agent is starting" });
      }

      if (req.method === "GET" && url.pathname === "/v1/settings") {
        const settings = store.getSettings();
        return sendJson(res, 200, { settings });
      }

      if (req.method === "PATCH" && url.pathname === "/v1/settings") {
        const body = await readJson(req);
        const settings = store.patchSettings(body ?? {});
        return sendJson(res, 200, { settings });
      }

      if (req.method === "GET" && url.pathname === "/v1/search") {
        const query = url.searchParams.get("q") ?? "";
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        const app = url.searchParams.get("app") ?? "";
        const scope = url.searchParams.get("scope") ?? "all";
        const results = store.searchChunks({ query, limit, app, scope });
        return sendJson(res, 200, { results });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/chunks/")) {
        const chunkId = url.pathname.slice("/v1/chunks/".length);
        const chunk = store.getChunk(chunkId);
        if (!chunk) {
          return sendJson(res, 404, { error: "Chunk not found" });
        }
        return sendJson(res, 200, { chunk });
      }

      if (req.method === "GET" && url.pathname === "/v1/summaries/daily") {
        const date = url.searchParams.get("date") ?? formatLocalDate(new Date());
        const summary = store.ensureDailySummary(date);
        return sendJson(res, 200, { summary });
      }

      if (req.method === "GET" && url.pathname === "/v1/timeline/daily") {
        const date = url.searchParams.get("date") ?? formatLocalDate(new Date());
        const timeline = store.getDailyTimeline({
          date,
          // B（用户选择）：5 分钟粒度
          sessionMergeGapMs: 5 * 60_000,
        });
        return sendJson(res, 200, { timeline });
      }

      if (req.method === "POST" && url.pathname === "/v1/ingest/frame") {
        const body = await readJson(req);
        const result = store.ingestFrame(body ?? {});
        if (result && result.skipped) {
          return sendJson(res, 202, { frame: result });
        }
        return sendJson(res, 200, { frame: result });
      }

      if (req.method === "POST" && url.pathname === "/v1/ingest/chunk") {
        const body = await readJson(req);
        const result = store.upsertChunk(body ?? {});
        return sendJson(res, 200, { chunk: result });
      }

      if (req.method === "POST" && url.pathname === "/v1/maintenance/cleanup") {
        const body = await readJson(req);
        const retentionDays = parsePositiveInt(
          body?.retentionDays,
          store.getSettings().agent.evidenceRetentionDays
        );
        const maxFramesPerRun = parsePositiveInt(body?.maxFramesPerRun, 5000);
        const result = await cleanupEvidence({ retentionDays, maxFramesPerRun });
        return sendJson(res, 200, { result });
      }

      if (req.method === "GET" && url.pathname === "/v1/maintenance/media-stats") {
        const refresh = url.searchParams.get("refresh") === "1";
        const stats = await getMediaStats({ refresh });
        return sendJson(res, 200, { stats });
      }

      if (req.method === "GET" && url.pathname === "/v1/backup/db") {
        const snapshotPath = await createDatabaseSnapshot({ db: dbConn, dataDir });
        const filename = `recapsense-backup-${formatLocalDate(new Date())}.db`;
        return sendFileStream(res, snapshotPath, {
          filename,
          contentType: "application/x-sqlite3",
          cleanup: () => {
            fs.unlink(snapshotPath).catch(() => {});
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/maintenance/reclean-chunks") {
        const body = await readJson(req);
        const limit = parsePositiveInt(body?.limit, 500);
        const dryRun = Boolean(body?.dryRun);
        const result = store.recleanChunks({ limit, dryRun });
        return sendJson(res, 200, { result });
      }

      if (req.method === "POST" && url.pathname === "/v1/maintenance/shutdown") {
        // 关闭 Agent：用于开发期“端口占用/外部进程”场景。
        // 必须鉴权，避免任意本机进程随意 kill 掉 Agent。
        sendJson(res, 202, { ok: true });
        const timer = setTimeout(() => process.exit(0), 80);
        timer.unref();
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/danger/delete") {
        const body = await readJson(req);
        const scope = String(body?.scope ?? "").trim() || "lastHour";

        const result = store.deleteDangerZone({
          scope,
          startTs: body?.startTs,
          endTs: body?.endTs,
          maxChunkIdsPerBatch: parsePositiveInt(body?.maxChunkIdsPerBatch, 200),
          maxFramesPerBatch: parsePositiveInt(body?.maxFramesPerBatch, 5000),
        });

        // 证据文件删除：对于 scope=all，直接删 media 目录更快；否则按 frames 收集到的路径删除。
        if (scope === "all") {
          const media = await deleteMediaDirectory();
          return sendJson(res, 200, { result, media });
        }

        const files = await deleteEvidenceFiles(result.filePaths);
        return sendJson(res, 200, { result, files });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, statusCode, { error: message });
    }
  };

  async function listenTcp() {
    if (disableTcp) return false;

    const server = http.createServer(handler);
    return new Promise((resolve) => {
      const onError = (error) => {
        console.error("[agent] tcp listen error:", error);
        resolve(false);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[agent] tcp server error:", error);
        });

        console.log(`[agent] listening: http://${host}:${port}`);

        resolve(true);
      });
    });
  }

  async function listenSocket() {
    if (!socketPath) return false;

    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await removeFileIfExists(socketPath);

    const server = http.createServer(handler);
    return new Promise((resolve) => {
      const onError = (error) => {
        console.error("[agent] socket listen error:", error);
        resolve(false);
      };

      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[agent] socket server error:", error);
        });

        console.log(`[agent] listening (unix socket): ${socketPath}`);
        resolve(true);
      });
    });
  }

  // 重要：先启动 TCP，再启动 UDS。
  // 否则在端口被占用（EADDRINUSE）时，第二个实例可能会先 unlink 掉正在使用的 agent.sock，
  // 造成“主 agent 的 unix socket 被破坏”。
  const tcpOk = await listenTcp();
  if (!disableTcp && !tcpOk) {
    throw new Error(`TCP listener failed (host=${host} port=${port})`);
  }

  const socketOk = await listenSocket();
  if (!disableTcp && !tcpOk && !socketOk) {
    throw new Error("No listeners started (tcp + unix socket both failed)");
  }

  if (disableTcp && !socketOk) {
    throw new Error("No listeners started (tcp disabled but unix socket failed)");
  }

  // listeners 已就绪：再打开 DB 与启动后台任务（避免“端口冲突时仍抢占 DB”）。
  const { db, withTransaction } = await openDatabase(dataDir);
  dbConn = db;
  store = createStore(db, { withTransaction });

  // 尽力而为的后台压实任务（frames → chunks），失败不影响主流程。
  const compactionIntervalMs = 30_000;
  const compactionTimer = setInterval(() => {
    try {
      const { createdChunks } = store.compactFramesToChunks();
      if (createdChunks > 0) {
        console.log(`[agent] compacted frames -> ${createdChunks} chunks`);
      }
    } catch (error) {
      console.warn("[agent] compaction error:", error);
    }
  }, compactionIntervalMs);
  compactionTimer.unref();

  // 尽力而为的日总结生成（纯文本 heuristic），失败不影响主流程。
  const dailySummaryIntervalMs = 10 * 60_000;
  const dailySummaryTimer = setInterval(() => {
    try {
      const today = formatLocalDate(new Date());
      const yesterday = formatLocalDate(new Date(Date.now() - 24 * 60 * 60_000));
      store.ensureDailySummary(today);
      store.ensureDailySummary(yesterday);
    } catch (error) {
      console.warn("[agent] daily summary error:", error);
    }
  }, dailySummaryIntervalMs);
  dailySummaryTimer.unref();

  scheduleEvidenceCleanup();
  await writeAgentRunInfo({ dataDir, host, port, disableTcp, socketPath, tcpOk, socketOk });
}

main().catch((error) => {
  console.error("[agent] fatal:", error);
  process.exit(1);
});

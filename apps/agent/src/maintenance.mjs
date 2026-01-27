import fs from "node:fs/promises";
import path from "node:path";

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

export function createEvidenceMaintenance({ dataDir, getStore, logger = console } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  if (typeof getStore !== "function") throw new Error("getStore is required");

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
    const store = getStore();
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

  async function maybeWarnMediaSize() {
    const store = getStore();
    if (!store) return;

    const settings = store.getSettings();
    const thresholdBytes = Number(settings.agent.mediaWarnThresholdBytes ?? 0);
    if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return;

    const stats = await getMediaStats({ refresh: false });
    if (!stats.overThreshold) return;

    const now = Date.now();
    if (lastMediaWarnedAt > 0 && now - lastMediaWarnedAt < mediaWarnCooldownMs) return;
    lastMediaWarnedAt = now;

    logger.warn(
      `[agent] media 占用已超过阈值：media=${formatBytes(stats.totalBytes)} threshold=${formatBytes(thresholdBytes)}。建议尽快备份数据目录（dataDir=${dataDir}），或调整“热证据保留天数/缩略图开关/阈值”。`
    );
  }

  async function cleanupEvidence({
    retentionDays,
    maxFramesPerRun = 5000,
  } = {}) {
    const store = getStore();
    const effectiveRetentionDays =
      retentionDays ?? store.getSettings().agent.evidenceRetentionDays;
    const retentionMs = Number(effectiveRetentionDays) * 24 * 60 * 60_000;
    const cutoffTs = Date.now() - retentionMs;

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
        logger.warn("[agent] cleanup file error:", absolute, error);
      }
    }

    return {
      retentionDays: Number(effectiveRetentionDays),
      cutoffTs,
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
        logger.warn("[agent] danger zone file delete error:", absolute, error);
      }
    }

    return { deletedFiles, skippedPaths, fileErrors };
  }

  async function deleteMediaDirectory() {
    const dir = path.join(dataDir, "media");
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: true, mediaDir: dir };
    } catch (error) {
      logger.warn("[agent] delete media dir failed (ignored):", dir, error);
      return { ok: false, mediaDir: dir };
    }
  }

  return {
    resolveSafePath,
    getMediaStats,
    maybeWarnMediaSize,
    cleanupEvidence,
    deleteEvidenceFiles,
    deleteMediaDirectory,
  };
}


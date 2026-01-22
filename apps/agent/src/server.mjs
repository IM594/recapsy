import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";
import { loadOrCreateApiToken } from "./secrets.mjs";
import { openDatabase } from "./db.mjs";
import { createStore } from "./store.mjs";
import { readJson, requireAuth, sendJson } from "./http.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4832;

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

async function main() {
  const dataDir = resolveDataDir();
  const token = await loadOrCreateApiToken(dataDir);
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const host = process.env.RECAPSENSE_AGENT_HOST ?? DEFAULT_HOST;
  const disableTcp = process.env.RECAPSENSE_AGENT_DISABLE_TCP === "1";
  const port = Number.parseInt(
    process.env.RECAPSENSE_AGENT_PORT ?? String(DEFAULT_PORT),
    10
  );
  const socketPath = resolveSocketPath(dataDir);

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

  async function cleanupEvidence({
    retentionDays,
    maxFramesPerRun = 5000,
  } = {}) {
    const effectiveRetentionDays =
      retentionDays ?? store.getSettings().agent.evidenceRetentionDays;
    const retentionMs = Number(effectiveRetentionDays) * 24 * 60 * 60_000;
    const cutoffTs = Date.now() - retentionMs;

    const deleted = store.deleteExpiredEvidenceFrames({
      cutoffTs,
      maxFramesPerRun,
    });

    let deletedFiles = 0;
    let skippedPaths = 0;
    let fileErrors = 0;

    for (const filePath of deleted.filePaths) {
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
      deletedFrames: deleted.deletedFrames,
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
          if (result.deletedFrames > 0 || result.deletedFiles > 0) {
            console.log(
              `[agent] cleanup evidence: frames=${result.deletedFrames} files=${result.deletedFiles} (retentionDays=${result.retentionDays})`
            );
          }
          if (result.fileErrors > 0) {
            console.warn(
              `[agent] cleanup evidence had fileErrors=${result.fileErrors}`
            );
          }
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

  scheduleEvidenceCleanup();

  console.log(`[agent] dataDir: ${dataDir}`);
  console.log(`[agent] tokenFile: ${dataDir}/secret/token`);
  console.log(`[agent] tokenHint: ****${token.slice(-6)}`);

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      if (url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (!url.pathname.startsWith("/v1/")) {
        return sendJson(res, 404, { error: "Not found" });
      }

      requireAuth(req, token);

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
        const results = store.searchChunks({ query, limit });
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

      if (req.method === "POST" && url.pathname === "/v1/ingest/frame") {
        const body = await readJson(req);
        const result = store.ingestFrame(body ?? {});
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

  const [tcpOk, socketOk] = await Promise.all([listenTcp(), listenSocket()]);
  if (!tcpOk && !socketOk) {
    throw new Error("No listeners started (tcp + unix socket both failed)");
  }
}

main().catch((error) => {
  console.error("[agent] fatal:", error);
  process.exitCode = 1;
});

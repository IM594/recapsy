import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { createDatabaseSnapshot } from "./backup.mjs";
import { readJson, requireAuth, sendJson } from "./http.mjs";
import { createEvidenceMaintenance } from "./maintenance.mjs";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
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

export function createAgentRequestHandler({
  host,
  serviceName,
  dataDir,
  token,
  getStore,
  getDb,
  onShutdown,
  maintenance,
  createReadStream = fsSync.createReadStream,
  unlinkFile = fs.unlink,
} = {}) {
  if (!host) throw new Error("host is required");
  if (!serviceName) throw new Error("serviceName is required");
  if (!dataDir) throw new Error("dataDir is required");
  if (!token) throw new Error("token is required");
  if (typeof getStore !== "function") throw new Error("getStore is required");
  if (typeof getDb !== "function") throw new Error("getDb is required");

  const evidence = maintenance ?? createEvidenceMaintenance({ dataDir, getStore });

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

    const stream = createReadStream(filePath);
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

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      if (url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: serviceName,
          pid: process.pid,
        });
      }

      if (!url.pathname.startsWith("/v1/")) {
        return sendJson(res, 404, { error: "Not found" });
      }

      requireAuth(req, token);

      const store = getStore();
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
        const result = await evidence.cleanupEvidence({ retentionDays, maxFramesPerRun });
        return sendJson(res, 200, { result });
      }

      if (req.method === "GET" && url.pathname === "/v1/maintenance/media-stats") {
        const refresh = url.searchParams.get("refresh") === "1";
        const stats = await evidence.getMediaStats({ refresh });
        return sendJson(res, 200, { stats });
      }

      if (req.method === "GET" && url.pathname === "/v1/backup/db") {
        const db = getDb();
        const snapshotPath = await createDatabaseSnapshot({ db, dataDir });
        const filename = `recapsense-backup-${formatLocalDate(new Date())}.db`;
        return sendFileStream(res, snapshotPath, {
          filename,
          contentType: "application/x-sqlite3",
          cleanup: () => {
            unlinkFile(snapshotPath).catch(() => {});
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
        sendJson(res, 202, { ok: true });
        try {
          onShutdown?.();
        } catch {
          // ignore
        }
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

        if (scope === "all") {
          const media = await evidence.deleteMediaDirectory();
          return sendJson(res, 200, { result, media });
        }

        const files = await evidence.deleteEvidenceFiles(result.filePaths);
        return sendJson(res, 200, { result, files });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, statusCode, { error: message });
    }
  };
}

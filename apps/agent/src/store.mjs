import { ulid } from "./ids.mjs";

function safeJsonParse(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaults() {
  return {
    collector: {
      intervalSeconds: 5,
      dedupeThreshold: 2,
      thumbnailEnabled: true,
      thumbnailMaxWidth: 420,
      ocrLevel: "fast",
      ocrLanguages: ["zh-Hans", "en-US"],
    },
    agent: {
      evidenceRetentionDays: 30,
      evidenceCleanupIntervalMinutes: 60,
    },
  };
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectChunksFtsMode(db) {
  // 通过 sqlite_master 里的建表 SQL 判断 chunks_fts 是 fts5 / fts4 / 不存在。
  // 说明：在部分环境里 SQLite 可能没有编译进 fts5/fts4；此时我们会降级为 LIKE 搜索。
  try {
    const row = db
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type='table' AND name='chunks_fts'`
      )
      .get();
    const sql = String(row?.sql ?? "");
    if (!sql) return null;

    if (/using\s+fts5/i.test(sql)) return "fts5";
    if (/using\s+fts4/i.test(sql) || /using\s+fts3/i.test(sql)) return "fts4";
    return "unknown";
  } catch {
    return null;
  }
}

export function createStore(db, { withTransaction }) {
  const listSettingsStmt = db.prepare(
    `SELECT key, value_json
     FROM settings`
  );

  const upsertSettingStmt = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json=excluded.value_json,
       updated_at=excluded.updated_at`
  );

  const insertFrameStmt = db.prepare(
    `INSERT INTO frames (
        ts, app, window_title, ocr_text, phash,
        screenshot_path, thumbnail_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const listUnchunkedFramesStmt = db.prepare(
    `SELECT id, ts, app, window_title, ocr_text
     FROM frames
     WHERE chunk_id IS NULL AND deleted_at IS NULL
     ORDER BY ts ASC
     LIMIT ?`
  );

  const listExpiredChunkedFramesStmt = db.prepare(
    `SELECT id, ts, screenshot_path, thumbnail_path
     FROM frames
     WHERE deleted_at IS NULL
       AND chunk_id IS NOT NULL
       AND ts < ?
     ORDER BY ts ASC
     LIMIT ?`
  );

  const deleteFrameStmt = db.prepare(`DELETE FROM frames WHERE id = ?`);

  const setFrameChunkStmt = db.prepare(
    `UPDATE frames SET chunk_id = ? WHERE id = ?`
  );

  const insertChunkStmt = db.prepare(
    `INSERT INTO chunks (
        id, start_ts, end_ts, app, window_title, text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const upsertChunkStmt = db.prepare(
    `INSERT INTO chunks (
        id, start_ts, end_ts, app, window_title, text, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
        start_ts=excluded.start_ts,
        end_ts=excluded.end_ts,
        app=excluded.app,
        window_title=excluded.window_title,
        text=excluded.text,
        updated_at=excluded.updated_at,
        deleted_at=NULL`
  );

  const ftsMode =
    process.env.RECAPSENSE_DISABLE_FTS === "1" ? null : detectChunksFtsMode(db);
  const ftsEnabled = ftsMode === "fts5" || ftsMode === "fts4";

  const deleteChunkFtsStmt = ftsEnabled
    ? db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`)
    : null;

  const insertChunkFtsStmt = ftsEnabled
    ? db.prepare(
        `INSERT INTO chunks_fts (chunk_id, text, app, window_title) VALUES (?, ?, ?, ?)`
      )
    : null;

  const getChunkStmt = db.prepare(
    `SELECT id, start_ts, end_ts, app, window_title, text
     FROM chunks
     WHERE id = ? AND deleted_at IS NULL`
  );

  const searchChunksFtsStmt = (() => {
    if (!ftsEnabled) return null;

    if (ftsMode === "fts5") {
      return db.prepare(
        `SELECT
            c.id,
            c.start_ts,
            c.end_ts,
            c.app,
            c.window_title,
            bm25(chunks_fts) AS score,
            substr(c.text, 1, 240) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.chunk_id
         WHERE chunks_fts MATCH ? AND c.deleted_at IS NULL
         ORDER BY score
         LIMIT ?`
      );
    }

    // fts4/fts3：没有 bm25，先按时间倒序（更符合“回忆”的直觉）。
    return db.prepare(
      `SELECT
          c.id,
          c.start_ts,
          c.end_ts,
          c.app,
          c.window_title,
          NULL AS score,
          substr(c.text, 1, 240) AS snippet
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       WHERE chunks_fts MATCH ? AND c.deleted_at IS NULL
       ORDER BY c.end_ts DESC
       LIMIT ?`
    );
  })();

  const searchChunksLikeStmt = db.prepare(
    `SELECT
        id,
        start_ts,
        end_ts,
        app,
        window_title,
        NULL AS score,
        substr(text, 1, 240) AS snippet
     FROM chunks
     WHERE deleted_at IS NULL
       AND (text LIKE ? OR app LIKE ? OR window_title LIKE ?)
     ORDER BY end_ts DESC
     LIMIT ?`
  );

  const listRecentChunksStmt = db.prepare(
    `SELECT id, start_ts, end_ts, app, window_title, text
     FROM chunks
     WHERE deleted_at IS NULL
     ORDER BY end_ts DESC
     LIMIT ?`
  );

  const listChunksInRangeStmt = db.prepare(
    `SELECT id, start_ts, end_ts, app, window_title, text
     FROM chunks
     WHERE deleted_at IS NULL
       AND start_ts >= ?
       AND start_ts < ?
     ORDER BY start_ts ASC`
  );

  const getDailySummaryStmt = db.prepare(
    `SELECT date, start_ts, end_ts, summary
     FROM summaries_daily
     WHERE date = ? AND deleted_at IS NULL`
  );

  const upsertDailySummaryStmt = db.prepare(
    `INSERT INTO summaries_daily (
        date, start_ts, end_ts, summary, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(date) DO UPDATE SET
        start_ts=excluded.start_ts,
        end_ts=excluded.end_ts,
        summary=excluded.summary,
        updated_at=excluded.updated_at,
        deleted_at=NULL`
  );

  function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function localDayRange(dateStr) {
    const parts = String(dateStr).split("-");
    if (parts.length !== 3) {
      throw new Error(`Invalid date: ${dateStr}`);
    }

    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);

    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    ) {
      throw new Error(`Invalid date: ${dateStr}`);
    }
    const start = new Date(year, month - 1, day, 0, 0, 0, 0);
    const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
    return { startTs: start.getTime(), endTs: end.getTime() };
  }

  function ingestFrame(frame) {
    const now = Date.now();
    const ts = Number(frame.ts ?? now);

    const ocrText = normalizeText(frame.ocrText ?? "");
    if (!ocrText) {
      throw new Error("ocrText is required");
    }

    const info = insertFrameStmt.run(
      ts,
      frame.app ?? null,
      frame.windowTitle ?? null,
      ocrText,
      frame.phash ?? null,
      frame.screenshotPath ?? null,
      frame.thumbnailPath ?? null,
      now
    );

    return {
      id: info.lastInsertRowid,
    };
  }

  function upsertChunk(chunk) {
    const now = Date.now();
    const id = chunk.id ?? ulid(chunk.startTs ?? now);
    const startTs = Number(chunk.startTs ?? now);
    const endTs = Number(chunk.endTs ?? startTs);
    const text = normalizeText(chunk.text ?? "");

    if (!text) {
      throw new Error("chunk.text is required");
    }

    withTransaction(db, () => {
      upsertChunkStmt.run(
        id,
        startTs,
        endTs,
        chunk.app ?? null,
        chunk.windowTitle ?? null,
        text,
        now,
        now
      );

      if (ftsEnabled && deleteChunkFtsStmt && insertChunkFtsStmt) {
        deleteChunkFtsStmt.run(id);
        insertChunkFtsStmt.run(
          id,
          text,
          chunk.app ?? "",
          chunk.windowTitle ?? ""
        );
      }
    });

    return { id };
  }

  function getChunk(id) {
    return getChunkStmt.get(id) ?? null;
  }

  function searchChunks({ query, limit = 20 }) {
    const trimmed = String(query ?? "").trim();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20;

    if (!trimmed) {
      return listRecentChunksStmt.all(safeLimit).map((row) => ({
        ...row,
        snippet: normalizeText(row.text).slice(0, 240),
        score: null,
      }));
    }

    if (ftsEnabled && searchChunksFtsStmt) {
      return searchChunksFtsStmt.all(trimmed, safeLimit);
    }

    // 降级：没有 FTS 时，使用 LIKE 做最小可用搜索（长远会慢，但能先跑通闭环）。
    const pattern = `%${trimmed}%`;
    return searchChunksLikeStmt.all(pattern, pattern, pattern, safeLimit);
  }

  function getDailySummary(dateStr) {
    return getDailySummaryStmt.get(dateStr) ?? null;
  }

  function generateDailySummary({ date }) {
    const dateStr = date ?? formatLocalDate(new Date());
    const { startTs, endTs } = localDayRange(dateStr);
    const chunks = listChunksInRangeStmt.all(startTs, endTs);

    if (chunks.length === 0) {
      return null;
    }

    const byApp = new Map();
    for (const chunk of chunks) {
      const key = chunk.app ?? "UnknownApp";
      byApp.set(key, (byApp.get(key) ?? 0) + 1);
    }

    const topApps = [...byApp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app, count]) => `${app} (${count})`)
      .join(", ");

    const highlights = chunks.slice(0, 5).map((chunk) => {
      const time = new Date(Number(chunk.start_ts)).toLocaleTimeString();
      const title = chunk.window_title ? ` — ${chunk.window_title}` : "";
      const snippet = normalizeText(chunk.text).slice(0, 180);
      return `- ${time} | ${chunk.app ?? "UnknownApp"}${title}: ${snippet}`;
    });

    const summary = [
      `每日总结 — ${dateStr}`,
      "",
      `片段数：${chunks.length}`,
      `主要应用：${topApps || "无"}`,
      "",
      "要点：",
      ...highlights,
    ].join("\n");

    return { date: dateStr, startTs, endTs, summary };
  }

  function readAllSettingsRows() {
    try {
      return listSettingsStmt.all();
    } catch {
      // 兼容旧库或迁移失败的极端情况：返回空，让上层走默认值。
      return [];
    }
  }

  function getSettings() {
    const settings = cloneDefaults();
    const rows = readAllSettingsRows();

    for (const row of rows) {
      const key = String(row.key ?? "");
      const parsed = safeJsonParse(row.value_json);
      if (parsed == null) continue;

      // 我们只读取“已知 key”，避免未来扩展时污染当前返回结构。
      switch (key) {
      case "collector.intervalSeconds": {
        const value = Number(parsed);
        if (Number.isFinite(value) && value > 0) settings.collector.intervalSeconds = value;
        break;
      }
      case "collector.dedupeThreshold": {
        const value = Number.parseInt(String(parsed), 10);
        if (Number.isFinite(value) && value >= 0) settings.collector.dedupeThreshold = value;
        break;
      }
      case "collector.thumbnailEnabled": {
        if (typeof parsed === "boolean") settings.collector.thumbnailEnabled = parsed;
        break;
      }
      case "collector.thumbnailMaxWidth": {
        const value = Number.parseInt(String(parsed), 10);
        if (Number.isFinite(value) && value > 0) settings.collector.thumbnailMaxWidth = value;
        break;
      }
      case "collector.ocrLevel": {
        const value = String(parsed);
        if (value === "fast" || value === "accurate") settings.collector.ocrLevel = value;
        break;
      }
      case "collector.ocrLanguages": {
        if (Array.isArray(parsed)) {
          const langs = parsed
            .map((x) => String(x).trim())
            .filter((x) => x);
          if (langs.length > 0) settings.collector.ocrLanguages = langs;
        }
        break;
      }
      case "agent.evidenceRetentionDays": {
        const value = Number.parseInt(String(parsed), 10);
        if (Number.isFinite(value) && value > 0) settings.agent.evidenceRetentionDays = value;
        break;
      }
      case "agent.evidenceCleanupIntervalMinutes": {
        const value = Number.parseInt(String(parsed), 10);
        if (Number.isFinite(value) && value > 0) settings.agent.evidenceCleanupIntervalMinutes = value;
        break;
      }
      default:
        break;
      }
    }

    return settings;
  }

  function patchSettings(patch) {
    if (!isPlainObject(patch)) {
      throw new Error("settings patch must be an object");
    }

    const now = Date.now();
    const updates = [];

    if (isPlainObject(patch.collector)) {
      const c = patch.collector;
      if (c.intervalSeconds != null) {
        const value = Number(c.intervalSeconds);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("collector.intervalSeconds must be a positive number");
        }
        updates.push(["collector.intervalSeconds", JSON.stringify(value)]);
      }
      if (c.dedupeThreshold != null) {
        const value = Number.parseInt(String(c.dedupeThreshold), 10);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("collector.dedupeThreshold must be >= 0");
        }
        updates.push(["collector.dedupeThreshold", JSON.stringify(value)]);
      }
      if (c.thumbnailEnabled != null) {
        if (typeof c.thumbnailEnabled !== "boolean") {
          throw new Error("collector.thumbnailEnabled must be boolean");
        }
        updates.push(["collector.thumbnailEnabled", JSON.stringify(c.thumbnailEnabled)]);
      }
      if (c.thumbnailMaxWidth != null) {
        const value = Number.parseInt(String(c.thumbnailMaxWidth), 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("collector.thumbnailMaxWidth must be a positive integer");
        }
        updates.push(["collector.thumbnailMaxWidth", JSON.stringify(value)]);
      }
      if (c.ocrLevel != null) {
        const value = String(c.ocrLevel);
        if (value !== "fast" && value !== "accurate") {
          throw new Error("collector.ocrLevel must be fast|accurate");
        }
        updates.push(["collector.ocrLevel", JSON.stringify(value)]);
      }
      if (c.ocrLanguages != null) {
        if (!Array.isArray(c.ocrLanguages)) {
          throw new Error("collector.ocrLanguages must be an array of strings");
        }
        const langs = c.ocrLanguages
          .map((x) => String(x).trim())
          .filter((x) => x);
        if (langs.length === 0) {
          throw new Error("collector.ocrLanguages must not be empty");
        }
        updates.push(["collector.ocrLanguages", JSON.stringify(langs)]);
      }
    }

    if (isPlainObject(patch.agent)) {
      const a = patch.agent;
      if (a.evidenceRetentionDays != null) {
        const value = Number.parseInt(String(a.evidenceRetentionDays), 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("agent.evidenceRetentionDays must be a positive integer");
        }
        updates.push(["agent.evidenceRetentionDays", JSON.stringify(value)]);
      }
      if (a.evidenceCleanupIntervalMinutes != null) {
        const value = Number.parseInt(String(a.evidenceCleanupIntervalMinutes), 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("agent.evidenceCleanupIntervalMinutes must be a positive integer");
        }
        updates.push(["agent.evidenceCleanupIntervalMinutes", JSON.stringify(value)]);
      }
    }

    if (updates.length === 0) {
      return getSettings();
    }

    withTransaction(db, () => {
      for (const [key, valueJson] of updates) {
        upsertSettingStmt.run(String(key), String(valueJson), now);
      }
    });

    return getSettings();
  }

  function upsertDailySummary({ date, startTs, endTs, summary }) {
    const now = Date.now();
    const dateStr = String(date);
    const start = Number(startTs);
    const end = Number(endTs);
    const text = normalizeText(summary ?? "");

    if (!dateStr) throw new Error("date is required");
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("startTs/endTs must be numbers");
    }
    if (!text) throw new Error("summary is required");

    withTransaction(db, () => {
      upsertDailySummaryStmt.run(dateStr, start, end, text, now, now);
    });

    return { date: dateStr };
  }

  function ensureDailySummary(dateStr) {
    const generated = generateDailySummary({ date: dateStr });
    if (!generated) return getDailySummary(dateStr) ?? null;

    upsertDailySummary(generated);
    return getDailySummary(dateStr);
  }

  function compactFramesToChunks({
    maxGapMs = 15_000,
    maxChunkDurationMs = 120_000,
    maxFramesPerRun = 2000,
  } = {}) {
    const frames = listUnchunkedFramesStmt.all(maxFramesPerRun);
    if (frames.length === 0) {
      return { createdChunks: 0, consumedFrames: 0 };
    }

    let createdChunks = 0;
    let consumedFrames = 0;

    let currentGroup = [];
    let currentKey = null;

    const flush = () => {
      if (currentGroup.length === 0) return;

      const first = currentGroup[0];
      const last = currentGroup[currentGroup.length - 1];
      const chunkTextParts = [];
      let previousNormalized = "";

      for (const frame of currentGroup) {
        const normalized = normalizeText(frame.ocr_text);
        if (!normalized) continue;
        if (normalized === previousNormalized) continue;
        chunkTextParts.push(normalized);
        previousNormalized = normalized;
      }

      const text = normalizeText(chunkTextParts.join("\n\n"));
      if (!text) {
        currentGroup = [];
        return;
      }

      const chunkId = ulid(first.ts);

      withTransaction(db, () => {
        const now = Date.now();
        insertChunkStmt.run(
          chunkId,
          first.ts,
          last.ts,
          first.app ?? null,
          first.window_title ?? null,
          text,
          now,
          now
        );
        if (ftsEnabled && deleteChunkFtsStmt && insertChunkFtsStmt) {
          deleteChunkFtsStmt.run(chunkId);
          insertChunkFtsStmt.run(
            chunkId,
            text,
            first.app ?? "",
            first.window_title ?? ""
          );
        }

        for (const frame of currentGroup) {
          setFrameChunkStmt.run(chunkId, frame.id);
        }
      });

      createdChunks += 1;
      consumedFrames += currentGroup.length;
      currentGroup = [];
    };

    for (const frame of frames) {
      const frameKey = `${frame.app ?? ""}\n${frame.window_title ?? ""}`;

      if (currentGroup.length === 0) {
        currentKey = frameKey;
        currentGroup.push(frame);
        continue;
      }

      const previous = currentGroup[currentGroup.length - 1];
      const gap = frame.ts - previous.ts;
      const duration = frame.ts - currentGroup[0].ts;

      const shouldSplit =
        frameKey !== currentKey ||
        gap > maxGapMs ||
        duration > maxChunkDurationMs;

      if (shouldSplit) {
        flush();
        currentKey = frameKey;
        currentGroup.push(frame);
        continue;
      }

      currentGroup.push(frame);
    }

    flush();

    return { createdChunks, consumedFrames };
  }

  function deleteExpiredEvidenceFrames({
    cutoffTs,
    maxFramesPerRun = 5000,
  } = {}) {
    const cutoff = Number(cutoffTs);
    if (!Number.isFinite(cutoff)) {
      throw new Error("cutoffTs must be a number");
    }

    const limit = Number(maxFramesPerRun);
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(50_000, limit))
      : 5000;

    const rows = listExpiredChunkedFramesStmt.all(cutoff, safeLimit);
    if (rows.length === 0) {
      return { deletedFrames: 0, deletedBeforeTs: cutoff, filePaths: [] };
    }

    withTransaction(db, () => {
      for (const row of rows) {
        deleteFrameStmt.run(row.id);
      }
    });

    const fileSet = new Set();
    for (const row of rows) {
      if (row.screenshot_path) fileSet.add(String(row.screenshot_path));
      if (row.thumbnail_path) fileSet.add(String(row.thumbnail_path));
    }

    return {
      deletedFrames: rows.length,
      deletedBeforeTs: cutoff,
      filePaths: [...fileSet],
    };
  }

  return {
    getSettings,
    patchSettings,
    ingestFrame,
    upsertChunk,
    getChunk,
    searchChunks,
    getDailySummary,
    ensureDailySummary,
    compactFramesToChunks,
    deleteExpiredEvidenceFrames,
  };
}

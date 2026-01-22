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
      thumbnailMaxWidth: 720,
      ocrLevel: "fast",
      ocrLanguages: ["zh-Hans", "en-US"],
      excludedApps: [],
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

function splitLines(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);
}

function countGoodChars(text) {
  // 允许中英文与数字，作为“这行是不是有意义”的粗判断。
  // 注意：使用 Unicode property escapes，需要 Node 16+（当前项目默认 Node 18+）。
  const matches = String(text ?? "").match(/[\p{Script=Han}A-Za-z0-9]/gu);
  return matches ? matches.length : 0;
}

function countWeirdChars(text) {
  // “怪字符”过滤（适配本项目：中文 + 英文）。
  // 背景：OCR 在 UI 图标/阴影/低对比度区域，常会生成一些非 ASCII 且非汉字的字符（例如 È、¥）。
  // 这些内容对检索价值很低，且会严重污染 chunk 文本与搜索结果。
  const raw = String(text ?? "");
  if (!raw) return 0;

  const nonAscii = raw.match(/[^\x00-\x7F]/g)?.length ?? 0;
  const han = raw.match(/\p{Script=Han}/gu)?.length ?? 0;
  const weird = nonAscii - han;
  return weird > 0 ? weird : 0;
}

function normalizeToken(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return "";
  // 中文不做字母化；英文做简化（去掉非字母数字字符，便于匹配 menu token）。
  if (/\p{Script=Han}/u.test(raw)) return raw;
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looksLikeMenuBarLine(line) {
  // 常见顶栏菜单项（跨应用比较通用）。如果一行几乎全由这些 token 组成，基本都是噪声。
  const tokens = String(line ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 3) return false;

  const menu = new Set([
    "file",
    "edit",
    "view",
    "history",
    "window",
    "help",
    "format",
    "insert",
    "tools",
    "go",
    "navigate",
    "debug",
    "terminal",
  ]);

  let hit = 0;
  for (const t of tokens) {
    const normalized = normalizeToken(t);
    if (menu.has(normalized)) hit += 1;
  }

  return hit / tokens.length >= 0.8;
}

function looksLikeUiChromeLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return false;

  const compact = trimmed.replace(/\s+/g, " ");
  const tokens = compact.split(" ").filter(Boolean);

  // 1) 单词级别的常见 UI 文本（多 App 通用）
  // 说明：只在“整行就是一个 token”或“极短”时才过滤，尽量避免误杀正文。
  const uiTokens = new Set([
    // 英文
    "file",
    "edit",
    "view",
    "history",
    "window",
    "help",
    "search",
    "share",
    "home",
    "inbox",
    "favorites",
    "settings",
    "preference",
    "preferences",
    "today",
    "yesterday",
    // 中文
    "文件",
    "编辑",
    "查看",
    "历史",
    "窗口",
    "帮助",
    "搜索",
    "分享",
    "主页",
    "首页",
    "收件箱",
    "收藏",
    "设置",
    "偏好设置",
  ]);

  if (tokens.length === 1) {
    const t = tokens[0];
    const normalized = normalizeToken(t);
    if (uiTokens.has(normalized) && normalized.length <= 16) return true;
    if (uiTokens.has(t) && t.length <= 8) return true;
  }

  // 2) “Warp File”、“Edit View”、“Tab Blocks” 这类：短行由 2~3 个 menu/ui token 组成。
  // 说明：OCR 常把顶栏菜单项拆成多行；用“短行 + token 命中率”来识别。
  if (tokens.length >= 2 && tokens.length <= 3) {
    const normalizedTokens = tokens.map(normalizeToken).filter(Boolean);
    if (normalizedTokens.length === 0) return false;

    // 补充：一些终端/IDE 会在菜单里出现 tab 之类词（尤其 Warp）。
    const uiExtended = new Set([...uiTokens, "tab", "tabs", "blocks", "drive"]);

    let hit = 0;
    for (const t of normalizedTokens) {
      if (uiExtended.has(t)) hit += 1;
    }

    // 2 token：>=1 命中就很可疑；3 token：>=2 命中。
    if (tokens.length === 2 && hit >= 1 && compact.length <= 18) return true;
    if (tokens.length === 3 && hit >= 2 && compact.length <= 24) return true;

    // “AppName File” 的模式：第一段像 app 名（字母/数字/点/短横线），第二段是 menu token。
    if (tokens.length === 2) {
      const a = tokens[0];
      const b = normalizeToken(tokens[1]);
      if (uiExtended.has(b) && /^[A-Za-z0-9][A-Za-z0-9._-]{1,24}$/.test(a)) {
        return true;
      }
    }
  }

  return false;
}

function isLowSignalLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return true;

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 2) return true;

  // OCR 乱码常出现 “****”、“%%%%” 之类符号块；一般不是用户内容。
  if (/([^\p{Script=Han}A-Za-z0-9\s])\1{3,}/u.test(trimmed)) return true;

  if (looksLikeMenuBarLine(trimmed)) return true;
  if (looksLikeUiChromeLine(trimmed)) return true;

  // 过滤掉几乎全是标点/乱码的行（例如 OCR 抖动产生的符号块）。
  const good = countGoodChars(compact);
  const ratio = good / compact.length;
  if (good < 2) return true;
  if (ratio < 0.40) return true;

  // 非 ASCII 且非汉字占比过高（常见 OCR 噪声）
  const weird = countWeirdChars(trimmed);
  if (weird >= 2 && weird / trimmed.length > 0.12) return true;

  // 纯数字/页码之类的短行一般意义不大。
  if (/^\d{1,4}$/.test(compact)) return true;
  // UI 计数徽标（例如 99+ / 199+）通常是噪声。
  if (/^\d{1,4}\+$/.test(compact)) return true;

  return false;
}

function cleanOcrLinesForChunk(rawText) {
  const normalized = normalizeText(rawText);
  if (!normalized) return [];

  const lines = splitLines(normalized)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line && !isLowSignalLine(line));

  // 同一帧内去重（保持顺序）
  const seen = new Set();
  const deduped = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }

  return deduped;
}

function stableTextSignature(lines) {
  // 轻量级签名：用于判断“这一帧的可用文本是否真的变化了”。
  // 不引入哈希依赖，先用归一化拼接即可。
  if (!Array.isArray(lines)) return "";
  return lines.join("\n");
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

  const listUnchunkedFrameIdsInRangeStmt = db.prepare(
    `SELECT id, screenshot_path, thumbnail_path
     FROM frames
     WHERE deleted_at IS NULL
       AND chunk_id IS NULL
       AND ts >= ?
       AND ts < ?
     ORDER BY ts ASC
     LIMIT ?`
  );

  const listChunkIdsOverlappingRangeStmt = db.prepare(
    `SELECT DISTINCT chunk_id
     FROM frames
     WHERE deleted_at IS NULL
       AND chunk_id IS NOT NULL
       AND chunk_id != ''
       AND ts >= ?
       AND ts < ?
     LIMIT ?`
  );

  const listFrameFilePathsByChunkIdStmt = db.prepare(
    `SELECT screenshot_path, thumbnail_path
     FROM frames
     WHERE deleted_at IS NULL
       AND chunk_id = ?`
  );

  const listFrameIdsByChunkIdStmt = db.prepare(
    `SELECT id
     FROM frames
     WHERE deleted_at IS NULL
       AND chunk_id = ?
     ORDER BY ts ASC`
  );

  const deleteChunkStmt = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  const deleteDailySummariesOverlappingRangeStmt = db.prepare(
    `DELETE FROM summaries_daily
     WHERE deleted_at IS NULL
       AND end_ts >= ?
       AND start_ts < ?`
  );

  const deleteAllFramesStmt = db.prepare(`DELETE FROM frames`);
  const deleteAllChunksStmt = db.prepare(`DELETE FROM chunks`);
  const deleteAllDailySummariesStmt = db.prepare(`DELETE FROM summaries_daily`);

  const setFrameChunkStmt = db.prepare(
    `UPDATE frames SET chunk_id = ? WHERE id = ?`
  );

  const insertChunkStmt = db.prepare(
    `INSERT INTO chunks (
        id, start_ts, end_ts, app, window_title, text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateChunkTextStmt = db.prepare(
    `UPDATE chunks
     SET text = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  );

  const listChunksForRecleanStmt = db.prepare(
    `SELECT id, text, start_ts
     FROM chunks
     WHERE deleted_at IS NULL
     ORDER BY start_ts DESC
     LIMIT ?`
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

  function isNoSuchModuleError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("no such module: fts5") || message.includes("no such module: fts4");
  }

  function isNoSuchTableError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("no such table: chunks_fts");
  }

  function probeChunksFtsMode(db) {
    if (process.env.RECAPSENSE_DISABLE_FTS === "1") return null;
    const mode = detectChunksFtsMode(db);
    if (mode !== "fts5" && mode !== "fts4") return null;

    // 关键：sqlite_master 里“存在”不等于“可用”。
    // 当 SQLite 缺少对应模块时，准备/执行任何访问 chunks_fts 的语句都会抛：
    //   no such module: fts5
    // 这种情况必须降级，否则 Agent 会直接启动失败。
    try {
      // 触发 virtual table 模块加载（空表也没关系）。
      db.prepare("SELECT 1 FROM chunks_fts LIMIT 1").get();
      return mode;
    } catch (error) {
      if (isNoSuchModuleError(error) || isNoSuchTableError(error)) {
        console.warn(
          "[store] chunks_fts exists but is unusable (missing module/table); falling back to LIKE search.",
          String(error)
        );
        return null;
      }
      // 其他错误也不应阻塞启动；保守降级并输出告警。
      console.warn("[store] chunks_fts probe failed (ignored); falling back to LIKE search:", error);
      return null;
    }
  }

  let ftsMode = probeChunksFtsMode(db);
  let ftsEnabled = ftsMode === "fts5" || ftsMode === "fts4";

  function safePrepareFts(sql) {
    if (!ftsEnabled) return null;
    try {
      return db.prepare(sql);
    } catch (error) {
      if (isNoSuchModuleError(error) || isNoSuchTableError(error)) {
        console.warn("[store] prepare FTS statement failed; falling back to LIKE search.", String(error));
      } else {
        console.warn("[store] prepare FTS statement failed (ignored); falling back to LIKE search:", error);
      }
      ftsMode = null;
      ftsEnabled = false;
      return null;
    }
  }

  const deleteChunkFtsStmt = safePrepareFts(
    `DELETE FROM chunks_fts WHERE chunk_id = ?`
  );

  const insertChunkFtsStmt = safePrepareFts(
    `INSERT INTO chunks_fts (chunk_id, text, app, window_title) VALUES (?, ?, ?, ?)`
  );

  const getChunkStmt = db.prepare(
    `SELECT id, start_ts, end_ts, app, window_title, text
     FROM chunks
     WHERE id = ? AND deleted_at IS NULL`
  );

  const searchChunksFtsStmt = (() => {
    if (!ftsEnabled) return null;

    if (ftsMode === "fts5") {
      const stmt = safePrepareFts(
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
      if (stmt) return stmt;
      // 如果 fts5 的 bm25 等语句准备失败，保守降级到 LIKE（ftsEnabled 已被 safePrepareFts 置为 false）。
      return null;
    }

    // fts4/fts3：没有 bm25，先按时间倒序（更符合“回忆”的直觉）。
    return safePrepareFts(
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

  function recleanChunks({ limit = 500, dryRun = false } = {}) {
    // 说明：
    // - 这是一个“维护/修复”能力：当我们升级了 OCR 清洗规则后，历史 chunks 里的文本仍然是旧规则生成的。
    // - 该函数会在 chunks 表上就地重写 text（并尽力更新 FTS 索引），让搜索结果立刻变干净。
    // - 默认限制处理数量，避免一次性操作过大；需要全量修复时可以多次调用。
    const rawLimit = Number(limit);
    const safeLimit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(50_000, rawLimit))
      : 500;

    const rows = listChunksForRecleanStmt.all(safeLimit);
    if (rows.length === 0) {
      return {
        processed: 0,
        updated: 0,
        skippedEmpty: 0,
        dryRun: Boolean(dryRun),
      };
    }

    let processed = 0;
    let updated = 0;
    let skippedEmpty = 0;
    const now = Date.now();

    const apply = () => {
      for (const row of rows) {
        processed += 1;

        const original = String(row.text ?? "");
        const lines = cleanOcrLinesForChunk(original);
        const next = normalizeText(lines.join("\n"));

        if (!next) {
          skippedEmpty += 1;
          continue;
        }

        if (next === normalizeText(original)) {
          continue;
        }

        updated += 1;

        if (dryRun) continue;

        updateChunkTextStmt.run(next, now, row.id);

        if (ftsEnabled && deleteChunkFtsStmt && insertChunkFtsStmt) {
          deleteChunkFtsStmt.run(row.id);
          // 注意：这里不回填 app/window_title（它们仍然在 chunks 表里），FTS 仅用于文本匹配与排序。
          // 未来如需更精准的 app/title 过滤，可以扩展 API 走结构化字段筛选。
          insertChunkFtsStmt.run(row.id, next, "", "");
        }
      }
    };

    if (dryRun) {
      apply();
      return { processed, updated, skippedEmpty, dryRun: true };
    }

    withTransaction(db, apply);
    return { processed, updated, skippedEmpty, dryRun: false };
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
      case "collector.excludedApps": {
        if (Array.isArray(parsed)) {
          const apps = parsed
            .map((x) => String(x).trim())
            .filter((x) => x);
          // 允许清空（空数组），表示“不排除任何应用”
          settings.collector.excludedApps = apps;
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
      if (c.excludedApps != null) {
        if (!Array.isArray(c.excludedApps)) {
          throw new Error("collector.excludedApps must be an array of strings");
        }
        const apps = c.excludedApps
          .map((x) => String(x).trim())
          .filter((x) => x);
        if (apps.length > 200) {
          throw new Error("collector.excludedApps is too large");
        }
        updates.push(["collector.excludedApps", JSON.stringify(apps)]);
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
      const cleanedPerFrame = [];
      const lineCounts = new Map(); // line -> count (per-frame unique)

      for (const frame of currentGroup) {
        const lines = cleanOcrLinesForChunk(frame.ocr_text);
        if (lines.length === 0) continue;

        cleanedPerFrame.push(lines);

        const unique = new Set(lines);
        for (const line of unique) {
          lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
        }
      }

      if (cleanedPerFrame.length === 0) {
        currentGroup = [];
        return;
      }

      // 过滤“高频出现”的短行（侧边栏/菜单/固定 UI 组件），降低碎片与噪声。
      // 说明：
      // - OCR 会有抖动（同一行偶尔识别成不同字符），如果阈值过高（例如 90%），
      //   很多“稳定 UI 噪声”反而无法被识别为高频行，导致 chunk 文本被顶栏/侧边栏污染。
      // - 但当帧数太少时（例如只有 1~2 帧），基于“频率”的过滤容易误杀，甚至导致 chunk 变空。
      //   所以这里仅在帧数足够（>=4）时启用该过滤。
      const frequentShortLines = new Set();
      if (cleanedPerFrame.length >= 4) {
        const threshold = Math.ceil(cleanedPerFrame.length * 0.7);
        for (const [line, count] of lineCounts.entries()) {
          if (count >= threshold && line.length <= 32) {
            frequentShortLines.add(line);
          }
        }
      }

      // 组装 chunk 文本：跨帧去重（保持顺序），并跳过 frequentShortLines。
      const out = [];
      const seenLines = new Set();
      let previousSig = "";

      for (const lines of cleanedPerFrame) {
        const sig = stableTextSignature(lines);
        if (sig === previousSig) continue;
        previousSig = sig;

        for (const line of lines) {
          if (frequentShortLines.has(line)) continue;
          if (seenLines.has(line)) continue;
          seenLines.add(line);
          out.push(line);
        }
      }

      const text = normalizeText(out.join("\n"));
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

  function deleteDangerZone({ startTs, endTs, scope, maxChunkIdsPerBatch = 200, maxFramesPerBatch = 5000 } = {}) {
    const now = Date.now();
    const resolvedScope = String(scope ?? "").trim();

    if (resolvedScope !== "lastHour" && resolvedScope !== "lastDay" && resolvedScope !== "all" && resolvedScope !== "range") {
      throw new Error("scope must be lastHour|lastDay|all|range");
    }

    let effectiveStartTs = Number(startTs);
    let effectiveEndTs = Number(endTs);
    if (resolvedScope === "lastHour") {
      effectiveEndTs = now;
      effectiveStartTs = now - 60 * 60_000;
    } else if (resolvedScope === "lastDay") {
      effectiveEndTs = now;
      effectiveStartTs = now - 24 * 60 * 60_000;
    } else if (resolvedScope === "all") {
      effectiveStartTs = 0;
      effectiveEndTs = Number.MAX_SAFE_INTEGER;
    } else {
      // range
      if (!Number.isFinite(effectiveStartTs) || !Number.isFinite(effectiveEndTs)) {
        throw new Error("startTs/endTs must be numbers for scope=range");
      }
      if (effectiveEndTs <= effectiveStartTs) {
        throw new Error("endTs must be greater than startTs");
      }
    }

    const result = {
      scope: resolvedScope,
      startTs: effectiveStartTs,
      endTs: effectiveEndTs,
      deletedFrames: 0,
      deletedChunks: 0,
      deletedDailySummaries: 0,
      filePaths: [],
    };

    // scope=all：直接清空表（FTS 也清空）。证据文件由上层按 dataDir/media 整体清理更划算。
    if (resolvedScope === "all") {
      withTransaction(db, () => {
        deleteAllFramesStmt.run();
        deleteAllChunksStmt.run();
        deleteAllDailySummariesStmt.run();
        if (ftsEnabled) {
          try {
            db.exec("DELETE FROM chunks_fts;");
          } catch {
            // 忽略：没有 chunks_fts 或 SQLite 构建不支持 FTS 时会失败
          }
        }
      });
      return result;
    }

    // 关键原则：
    // - 删除时间范围内的 unchunked frames（还没压实的）；
    // - 对于已经压实成 chunk 的内容：只要 chunk 有任何 frame 命中范围，就删除整个 chunk，
    //   并删除所有属于该 chunk 的 frames（避免 chunk 文本仍残留敏感信息）。
    while (true) {
      const chunkIds = listChunkIdsOverlappingRangeStmt
        .all(effectiveStartTs, effectiveEndTs, maxChunkIdsPerBatch)
        .map((row) => String(row.chunk_id ?? "").trim())
        .filter((x) => x);

      const unchunkedFrames = listUnchunkedFrameIdsInRangeStmt
        .all(effectiveStartTs, effectiveEndTs, maxFramesPerBatch)
        .map((row) => ({
          id: Number(row.id),
          screenshot_path: row.screenshot_path,
          thumbnail_path: row.thumbnail_path,
        }));

      if (chunkIds.length === 0 && unchunkedFrames.length === 0) break;

      withTransaction(db, () => {
        // 1) 删除 unchunked frames（并收集文件路径）
        for (const frame of unchunkedFrames) {
          if (frame.screenshot_path) result.filePaths.push(frame.screenshot_path);
          if (frame.thumbnail_path) result.filePaths.push(frame.thumbnail_path);
          deleteFrameStmt.run(frame.id);
          result.deletedFrames += 1;
        }

        // 2) 删除 chunk + chunk 相关 frames（并收集文件路径）
        for (const chunkId of chunkIds) {
          const paths = listFrameFilePathsByChunkIdStmt.all(chunkId);
          for (const row of paths) {
            if (row.screenshot_path) result.filePaths.push(row.screenshot_path);
            if (row.thumbnail_path) result.filePaths.push(row.thumbnail_path);
          }

          const frameIds = listFrameIdsByChunkIdStmt.all(chunkId);
          for (const row of frameIds) {
            deleteFrameStmt.run(Number(row.id));
            result.deletedFrames += 1;
          }

          if (ftsEnabled && deleteChunkFtsStmt) {
            deleteChunkFtsStmt.run(chunkId);
          }
          deleteChunkStmt.run(chunkId);
          result.deletedChunks += 1;
        }
      });
    }

    // 删除可能受影响的日总结：按时间范围 overlap 删掉，后续再访问会自动再生成（基于剩余 chunks）。
    try {
      const info = deleteDailySummariesOverlappingRangeStmt.run(effectiveStartTs, effectiveEndTs);
      result.deletedDailySummaries = Number(info.changes ?? 0);
    } catch {
      result.deletedDailySummaries = 0;
    }

    return result;
  }

  return {
    getSettings,
    patchSettings,
    ingestFrame,
    upsertChunk,
    getChunk,
    searchChunks,
    recleanChunks,
    getDailySummary,
    ensureDailySummary,
    compactFramesToChunks,
    deleteExpiredEvidenceFrames,
    deleteDangerZone,
  };
}

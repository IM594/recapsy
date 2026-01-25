import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dbFilePath } from "./paths.mjs";

function tableExists(db, name) {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type='table' AND name = ?`
    )
    .get(name);
  return Boolean(row);
}

function isNoSuchModuleError(error, moduleName) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`no such module: ${moduleName}`);
}

function ensureChunksFts(db) {
  // 尽力而为：创建 chunks_fts（优先 fts5，其次 fts4）。
  // 兼容某些 SQLite 构建没有 fts 模块的情况：失败则降级为 LIKE 搜索。
  if (process.env.RECAPSENSE_DISABLE_FTS === "1") {
    return { ok: true, mode: null, reason: "disabled" };
  }

  if (tableExists(db, "chunks_fts")) {
    return { ok: true, mode: "existing", reason: "already-exists" };
  }

  const backfill = () => {
    // FTS 表新建后，需要把已有 chunks 回填进去，否则历史内容搜不到。
    // 只回填未删除的 chunks；FTS 属于“派生索引”，可重建。
    db.exec(
      `INSERT INTO chunks_fts (chunk_id, text, app, window_title)
       SELECT
          id,
          text,
          COALESCE(app, ''),
          COALESCE(window_title, '')
       FROM chunks
       WHERE deleted_at IS NULL`
    );
  };

  try {
    db.exec(
      `CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunk_id UNINDEXED,
        text,
        app,
        window_title
      );`
    );
    backfill();
    return { ok: true, mode: "fts5", reason: "created" };
  } catch (error) {
    if (!isNoSuchModuleError(error, "fts5")) {
      // 不是“缺模块”导致的错误：仍然不让它阻塞启动，但要打出警告，便于排查。
      console.warn("[db] create fts5 failed (ignored):", error);
    }
  }

  try {
    db.exec(
      `CREATE VIRTUAL TABLE chunks_fts USING fts4(
        chunk_id,
        text,
        app,
        window_title,
        notindexed=chunk_id
      );`
    );
    backfill();
    return { ok: true, mode: "fts4", reason: "created" };
  } catch (error) {
    if (!isNoSuchModuleError(error, "fts4")) {
      console.warn("[db] create fts4 failed (ignored):", error);
    }
  }

  return { ok: true, mode: null, reason: "no-fts-module" };
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 忽略回滚错误（保持原始异常作为主错误）
    }
    throw error;
  }
}

async function loadSchemaSql() {
  const schemaPath = new URL("./schema.sql", import.meta.url);
  return fs.readFile(schemaPath, "utf8");
}

async function loadMigrationSql(relativePath) {
  const migrationPath = new URL(relativePath, import.meta.url);
  return fs.readFile(migrationPath, "utf8");
}

export async function openDatabase(dataDir) {
  const filePath = dbFilePath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const shouldInit = !(await fileExists(filePath));
  const db = new DatabaseSync(filePath);

  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  await migrate(db);
  ensureChunksFts(db);

  if (shouldInit) {
    // 简单自检：确保数据库可写
    db.exec("PRAGMA quick_check;");
  }

  return { db, withTransaction };
}

export async function migrate(db) {
  const versionRow = db.prepare("PRAGMA user_version;").get();
  let currentVersion = Number(versionRow?.user_version ?? 0);

  const migrations = [
    { version: 1, sql: () => loadSchemaSql() },
    { version: 2, sql: () => loadMigrationSql("./migrations/0002_vision.sql") },
    { version: 3, sql: () => loadMigrationSql("./migrations/0003_settings.sql") },
    { version: 4, sql: () => loadMigrationSql("./migrations/0004_thumbnail_width.sql") },
    { version: 5, sql: () => loadMigrationSql("./migrations/0005_app_bundle_id.sql") },
  ];

  for (const migration of migrations) {
    if (currentVersion >= migration.version) continue;

    const sql = await migration.sql();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 忽略回滚错误（保持原始异常作为主错误）
      }
      throw error;
    }

    currentVersion = migration.version;
  }
}

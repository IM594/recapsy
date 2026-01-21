PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  app TEXT,
  window_title TEXT,
  ocr_text TEXT NOT NULL,
  phash TEXT,
  screenshot_path TEXT,
  thumbnail_path TEXT,
  created_at INTEGER NOT NULL,
  chunk_id TEXT,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(ts);
CREATE INDEX IF NOT EXISTS idx_frames_chunk_id ON frames(chunk_id);
CREATE INDEX IF NOT EXISTS idx_frames_deleted_at ON frames(deleted_at);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  app TEXT,
  window_title TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_start_ts ON chunks(start_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_end_ts ON chunks(end_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_deleted_at ON chunks(deleted_at);

-- 全文索引（FTS）不在 schema.sql 中强制创建。
-- 原因：部分 Node/SQLite 构建可能不包含 fts5/fts4，直接创建会导致迁移失败。
-- Agent 会在启动时尽力而为地创建 `chunks_fts`（优先 fts5，其次 fts4），创建失败则降级为 LIKE 搜索。

CREATE TABLE IF NOT EXISTS summaries_daily (
  date TEXT PRIMARY KEY,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_summaries_daily_deleted_at ON summaries_daily(deleted_at);

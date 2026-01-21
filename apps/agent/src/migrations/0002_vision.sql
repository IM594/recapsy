-- 0002：预留 LLM 视觉增强相关表（暂不启用，不影响现有流程）
--
-- 设计目标：
-- 1) 视觉增强属于“派生信息”，可重建；但其输出（文本/结构化信息）会被长期保存用于检索与总结。
-- 2) 任务与结果分离：jobs 负责调度/重试/预算控制；extractions 负责存储产物。
-- 3) B 模式兼容：即便热窗口图片被删除，抽取出来的文本仍可长期保留。

CREATE TABLE IF NOT EXISTS vision_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  run_after_ts INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  model TEXT,
  prompt_version TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (source_type IN ('frame', 'chunk')),
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_vision_jobs_status_run_after
  ON vision_jobs(status, run_after_ts);

CREATE INDEX IF NOT EXISTS idx_vision_jobs_deleted_at
  ON vision_jobs(deleted_at);

CREATE INDEX IF NOT EXISTS idx_vision_jobs_source
  ON vision_jobs(source_type, source_id);

CREATE TABLE IF NOT EXISTS vision_extractions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  text TEXT NOT NULL,
  json TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (source_type IN ('frame', 'chunk'))
);

CREATE INDEX IF NOT EXISTS idx_vision_extractions_source
  ON vision_extractions(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_vision_extractions_deleted_at
  ON vision_extractions(deleted_at);

-- 预留：如需对视觉抽取结果做全文检索，可在后续按需创建 FTS（fts5/fts4）。
-- 注意：此处不强制创建，避免在缺少 fts 模块的 SQLite 构建上导致迁移失败。

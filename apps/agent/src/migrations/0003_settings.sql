-- 0003_settings.sql
-- 目标：把“用户可配置项”落到数据库（settings 表），让 UI/服务端都能统一读取与修改。
-- 注意：settings 属于“长期状态”（应随 db 迁移），不同于可重建的派生索引（FTS/embedding）。

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 默认值（只在不存在时写入；用户一旦修改不会被覆盖）
-- value_json 使用 JSON 文本：数字/布尔/字符串/数组都可表达。

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.intervalSeconds', '5', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.dedupeThreshold', '2', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.thumbnailEnabled', 'true', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.thumbnailMaxWidth', '420', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.ocrLevel', '\"fast\"', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('collector.ocrLanguages', '[\"zh-Hans\",\"en-US\"]', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('agent.evidenceRetentionDays', '30', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('agent.evidenceCleanupIntervalMinutes', '60', CAST(strftime('%s','now') AS INTEGER) * 1000);


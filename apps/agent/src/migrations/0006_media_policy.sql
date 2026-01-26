-- 0006_media_policy.sql
-- 目标：
-- - frames 的原始文本证据（ocr_text 等）永久保留（可反悔）。
-- - “热证据”仅指 media（截图/缩略图文件），可按天数清理。
-- - 增加 media 占用提醒阈值（只提醒，不自动清理）。

-- 1) 新增提醒阈值（只在不存在时写入；用户一旦修改不会被覆盖）
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('agent.mediaWarnThresholdBytes', '10737418240', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- 2) 将历史默认的热证据保留从 30 天调整为 365 天：
--    - 只在仍为旧默认值（30）时更新，尽量避免覆盖用户自定义。
UPDATE settings
SET value_json = '365',
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE key = 'agent.evidenceRetentionDays'
  AND value_json = '30';


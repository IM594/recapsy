-- 0004_thumbnail_width.sql
--
-- 目标：提升缩略图默认尺寸，便于后续多模态/视觉处理使用。
--
-- 说明：
-- - 旧默认值为 420px，在喂给小型多模态模型时经常偏糊、可读性不足。
-- - 这里把默认值提升到 720px。
-- - 为了不覆盖用户自定义：仅当该 key 仍为旧默认值（420）时才更新。

UPDATE settings
SET value_json = '720',
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE key = 'collector.thumbnailMaxWidth'
  AND value_json = '420';


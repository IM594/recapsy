-- 0005_app_bundle_id.sql
--
-- 目标：为 frames 增加 app_bundle_id 字段，用于“应用黑名单按身份匹配”（Bundle ID），
--       避免应用名称多语言/不稳定导致的漏判。

ALTER TABLE frames ADD COLUMN app_bundle_id TEXT;

CREATE INDEX IF NOT EXISTS idx_frames_app_bundle_id ON frames(app_bundle_id);


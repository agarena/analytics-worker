-- 2026-09-08 升级：给已有线上库补新列（全新空库直接跑 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute analytics-db --remote -y --file=./alter-2026-09-08.sql
-- 注意：ALTER 不可重复执行，重复跑会报 duplicate column name，属正常现象。

ALTER TABLE visits ADD COLUMN anon_id TEXT;
ALTER TABLE visits ADD COLUMN session_id TEXT;
ALTER TABLE visits ADD COLUMN src TEXT;
ALTER TABLE visits ADD COLUMN src_v TEXT;
ALTER TABLE visits ADD COLUMN landing TEXT;
ALTER TABLE events ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_visits_sid ON visits(session_id);

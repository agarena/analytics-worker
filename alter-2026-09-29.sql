-- 2026-09-29：feedback 表加 source 列（区分提交来源：主站表单 site / 沃池静态站反馈通道
-- form·agent / 各站自定标签）。线上库升级执行一次：
--   npx wrangler d1 execute analytics-db --remote -y --file=./alter-2026-09-29.sql
-- （重复执行会报 duplicate column name，属预期——说明已升级过。）
ALTER TABLE feedback ADD COLUMN source TEXT;

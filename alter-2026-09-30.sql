-- 2026-09-30：feedback 表加 channel 列（联系方式渠道：邮箱/微信号/手机号/QQ号/飞书/其他）。
-- 线上库升级执行一次（重复执行报 duplicate column name 属预期）：
--   bash cf-relay.sh npx wrangler d1 execute analytics-db --remote -y --file=./alter-2026-09-30.sql
ALTER TABLE feedback ADD COLUMN channel TEXT;

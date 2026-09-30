-- 2026-09-30 智能体中继上线：用量记账两表（站点级每日 + 单 IP 每日）
-- 线上库执行：cf-relay.sh npx wrangler d1 execute analytics-db --remote -y --file=./alter-2026-09-30b.sql

CREATE TABLE IF NOT EXISTS agent_relay_usage (
  day      TEXT PRIMARY KEY,   -- 北京时区 YYYY-MM-DD
  cost_rmb REAL NOT NULL DEFAULT 0,
  tin      INTEGER NOT NULL DEFAULT 0,
  tout     INTEGER NOT NULL DEFAULT 0,
  calls    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_relay_ip (
  day      TEXT,
  ip       TEXT,
  cost_rmb REAL NOT NULL DEFAULT 0,
  tin      INTEGER NOT NULL DEFAULT 0,
  tout     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip)
);

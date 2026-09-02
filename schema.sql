-- D1 (SQLite at edge) schema for visitor analytics + feedback
-- 部署时执行：wrangler d1 execute analytics-db --file=./schema.sql
--
-- 采集层（Worker /api/visit）只写入原始字段：
--   ip / ua / referer / path / day / ts / dwell_ms
-- 地理解析结果列（country/continent/region/city/asn/isp/lat/lon/tz）初始为空，
-- 由后续离线程序基于 ip 解析后 UPDATE 回填，不在访客请求路径上做解析。

CREATE TABLE IF NOT EXISTS visits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ip        TEXT,
  ua        TEXT,
  referer   TEXT,
  path      TEXT,
  day       TEXT,            -- YYYY-MM-DD，便于按天聚合
  ts        INTEGER,         -- 毫秒时间戳
  dwell_ms  INTEGER DEFAULT 0,
  country   TEXT,
  continent TEXT,
  region    TEXT,
  city      TEXT,
  asn       INTEGER,
  isp       TEXT,
  lat       REAL,
  lon       REAL,
  tz        TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_ts   ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_day  ON visits(day);
CREATE INDEX IF NOT EXISTS idx_visits_ip   ON visits(ip);

CREATE TABLE IF NOT EXISTS feedback (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT,
  name    TEXT,
  message TEXT,
  ts      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fb_ts ON feedback(ts);

-- 交互事件（按钮点击等）。与 visits 分开，语义清晰，便于分析。
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT,
  type    TEXT,        -- 事件类型，如 'btn_click'
  detail  TEXT,        -- 事件细节，如按钮标识 'cta_like'
  path    TEXT,
  day     TEXT,        -- YYYY-MM-DD，便于按天聚合
  ts      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

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

-- ===== 内容表：新主页 /api/tools /api/feed /api/site 的数据源 =====
-- 修改内容走 /api/admin/* 接口或 wrangler d1 execute，访客下次打开即生效。

CREATE TABLE IF NOT EXISTS tools (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT UNIQUE NOT NULL,   -- 稳定标识，管理接口按它定位
  name      TEXT NOT NULL,
  category  TEXT DEFAULT '',        -- 角标/分类，如 Voice
  one_liner TEXT DEFAULT '',        -- 一句话描述
  sort      INTEGER DEFAULT 0,      -- 展示顺序，小者在前
  links_json  TEXT DEFAULT '[]',    -- [{kind:'open'|'demo', url:'...'}]
  media_json  TEXT DEFAULT '[]',    -- [{type:'image'|'video', url, caption, poster}]
  qa_json     TEXT DEFAULT '[]',    -- [{question, answer}]
  updated_ts  INTEGER
);

CREATE TABLE IF NOT EXISTS feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT DEFAULT 'update', -- update | news | soon
  text       TEXT NOT NULL,
  sort       INTEGER DEFAULT 0,
  created_ts INTEGER
);

CREATE TABLE IF NOT EXISTS site (
  key   TEXT PRIMARY KEY,           -- brand_name / contact_email
  value TEXT
);

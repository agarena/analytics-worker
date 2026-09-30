-- D1 (SQLite at edge) schema for visitor analytics + feedback
-- 部署时执行：wrangler d1 execute analytics-db --file=./schema.sql
--
-- 采集层（Worker /api/collect）只写入原始字段：
--   ip / ua / referer / path / day / ts / dwell_ms
--   + anon_id / session_id（前端匿名卡号与会话号）
--   + src / src_v / landing（来源暗号 ?from=平台&v=内容编号 与完整落地网址）
-- 地理解析结果列（country/continent/region/city/asn/isp/lat/lon/tz）初始为空，
-- 由后续离线程序基于 ip 解析后 UPDATE 回填，不在访客请求路径上做解析。
-- 注意：已有线上库升级到新列需手动 ALTER（见 alter-2026-09-08.sql），
-- 本文件的 CREATE TABLE IF NOT EXISTS 只对全新空库生效。

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
  tz        TEXT,
  anon_id   TEXT,            -- 访客匿名卡号（localStorage 持久），识别回头客
  session_id TEXT,           -- 会话号（每次打开页面一个），串联一次访问的全部行为
  src       TEXT,            -- 来源平台暗号，如 bilibili / gzh / xhs / douyin
  src_v     TEXT,            -- 来源内容编号，如 lv01（哪条视频/笔记带来的）
  landing   TEXT             -- 落地完整网址（含查询参数），原始留档防丢信息
);
CREATE INDEX IF NOT EXISTS idx_visits_ts   ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_day  ON visits(day);
CREATE INDEX IF NOT EXISTS idx_visits_ip   ON visits(ip);
CREATE INDEX IF NOT EXISTS idx_visits_sid  ON visits(session_id);

CREATE TABLE IF NOT EXISTS feedback (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT,
  name    TEXT,
  message TEXT,
  source  TEXT,           -- 提交来源：site（主站表单）/ form / agent（沃池反馈通道）/ 各站自定标签
  channel TEXT,           -- 联系方式渠道：邮箱/微信号/手机号/QQ号/飞书/其他（未留联系方式为 NULL）
  ts      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fb_ts ON feedback(ts);

-- 智能体对话全息记录（浏览器每轮后台上传，BYOK 与中继两形态同表，source 区分）
CREATE TABLE IF NOT EXISTS agent_chats (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT,
  sid     TEXT,            -- 会话 id（浏览器生成，同会话多问同 sid）
  source  TEXT,            -- byok / relay
  model   TEXT,            -- 模型 id
  effort  TEXT,            -- 思考强度实发值（上游拒收降级后为 NULL）
  base_url TEXT,           -- 访客所用的 API 地址（不含密钥）
  q       TEXT,            -- 用户问题
  a       TEXT,            -- 最终答案
  think   TEXT,            -- 各轮思考（截断留存）
  tools   TEXT,            -- JSON [{name,args,ok,summary,result}]（截断留存）
  req     TEXT,            -- 末轮完整请求 messages JSON（含系统栈与工具往来，截断）
  resp    TEXT,            -- 末轮完整响应 JSON（content/tool_calls/usage，截断）
  usage   TEXT,            -- JSON {input,output,cached?}
  ts      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ac_ts ON agent_chats(ts);

-- 智能体中继用量记账（/api/agent/chat 限额依据）：站点级每日 + 单 IP 每日。
-- 成本按牌价换算（Worker env RELAY_PRICE_IN/OUT，¥/百万 token），缓存命中按常规
-- 输入计价（保守）；日界按北京时区。已有线上库升级见 alter-2026-09-30b.sql。
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

-- 交互事件（按钮点击等）。与 visits 分开，语义清晰，便于分析。
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT,
  type    TEXT,        -- 事件类型，如 'btn_click'
  detail  TEXT,        -- 事件细节，如按钮标识 'cta_like'
  path    TEXT,
  day     TEXT,        -- YYYY-MM-DD，便于按天聚合
  ts      INTEGER,
  session_id TEXT     -- 会话号，可与 visits 按 session 关联出来源/访客
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

-- ===== 提示词聚合网站（prompts.agarena.xyz）=====
-- 内容表：官方提示词 + 访客投稿共用，投稿先审后显（status=pending）。
-- 展示编号 no 在审核通过时才分配（pending 期为 NULL，UNIQUE 允许多个 NULL）。

CREATE TABLE IF NOT EXISTS prompts (
  id         TEXT PRIMARY KEY,      -- 官方 pf01… / 投稿 u+毫秒时间戳
  no         TEXT UNIQUE,           -- 展示编号 PF-01；投稿通过审核时分配
  title      TEXT NOT NULL,
  author     TEXT DEFAULT '',
  platform   TEXT DEFAULT '',
  account    TEXT DEFAULT '',
  url        TEXT DEFAULT '',
  tags_json  TEXT DEFAULT '[]',
  scene      TEXT DEFAULT '',
  content    TEXT NOT NULL,
  example    TEXT DEFAULT '',
  img        TEXT DEFAULT '',       -- 配图 dataURL（≤200KB，前端压缩）或图片 URL
  likes      INTEGER DEFAULT 0,
  status     TEXT DEFAULT 'published', -- pending | published | hidden
  source     TEXT DEFAULT 'official',  -- official | user
  created_ts INTEGER,
  updated_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prompts_status ON prompts(status, updated_ts);

-- 点赞去重：同一访客对同一提示词只算一票，可再点取消
CREATE TABLE IF NOT EXISTS prompt_likes (
  prompt_id  TEXT NOT NULL,
  visitor_id TEXT NOT NULL,         -- 前端 localStorage 匿名 id（复用主站 shufy_anon）
  ts         INTEGER,
  PRIMARY KEY (prompt_id, visitor_id)
);

-- 提示词站内反馈（评价/建议/问题，可关联某张卡片），不公开，仅后台可见
CREATE TABLE IF NOT EXISTS prompt_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT DEFAULT '评价',    -- 评价 | 建议 | 问题
  prompt_id  TEXT DEFAULT '',
  message    TEXT NOT NULL,
  ip         TEXT,
  visitor_id TEXT,
  ts         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pfb_ts ON prompt_feedback(ts);

-- 关键节点日志：前端行为（page_view/search/copy/like/share/submit/feedback…）
-- + 服务端错误（type='error'）+ 管理操作（type='admin_*'），一张表按 type 区分
CREATE TABLE IF NOT EXISTS pf_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  site       TEXT DEFAULT 'prompts', -- prompts | stickers（区分来源站）
  prompt_id  TEXT DEFAULT '',        -- 关联对象 id（提示词卡片或表情包）
  detail     TEXT DEFAULT '',       -- JSON，写入前截断 500 字符
  ip         TEXT,
  visitor_id TEXT,
  session_id TEXT,
  day        TEXT,                  -- YYYY-MM-DD，便于按天聚合
  ts         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pf_logs_ts   ON pf_logs(ts);
CREATE INDEX IF NOT EXISTS idx_pf_logs_type ON pf_logs(type, day);

-- ===== AI 表情包站（stickers.agarena.xyz）=====
-- 官方收藏 + 访客投稿共用；投稿先审后显。官方图片走仓库 assets/ 相对路径，
-- 投稿图片是前端压缩后的 dataURL（≤200KB），两种都存 img 列。

CREATE TABLE IF NOT EXISTS stickers (
  id              TEXT PRIMARY KEY,   -- 官方 s01… / 投稿 u+毫秒
  title           TEXT NOT NULL,
  characters_json TEXT DEFAULT '[]',  -- 角色 key 数组（合照多个；未知 key 前端以色块占位）
  tags_json       TEXT DEFAULT '[]',
  author          TEXT DEFAULT '',
  platform        TEXT DEFAULT '',
  source_url      TEXT DEFAULT '',
  img             TEXT DEFAULT '',    -- assets/sticker-xx.png 或 dataURL(≤200KB)
  likes           INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'published', -- pending | published | hidden
  source          TEXT DEFAULT 'official',  -- official | user
  phash           TEXT,                     -- 感知哈希（16 hex），投稿去重用
  created_ts      INTEGER,
  updated_ts      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stickers_status ON stickers(status, updated_ts);

CREATE TABLE IF NOT EXISTS sticker_likes (
  sticker_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ts         INTEGER,
  PRIMARY KEY (sticker_id, visitor_id)
);

-- 表情包站公开评论区（留言即显，蜜罐+限流防刷；后台可删）
CREATE TABLE IF NOT EXISTS sticker_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sticker_id TEXT NOT NULL,
  nick       TEXT DEFAULT '匿名',
  text       TEXT NOT NULL,
  ip         TEXT,
  visitor_id TEXT,
  ts         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sticker_comments_sid ON sticker_comments(sticker_id, ts);

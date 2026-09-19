# analytics-worker — 不吃鲸B 站点矩阵云端后端

Cloudflare Worker（api.agarena.xyz）+ D1，服务主站（agarena.xyz）与所有子站（prompts.agarena.xyz 等）的内容接口、访客统计与开放投稿 API。

## 文件

- `src/index.js` — 全部逻辑：路由分发表在文件末尾 `export default fetch`
- `schema.sql` — D1 表结构（`CREATE TABLE IF NOT EXISTS` 幂等，可重复执行）
- `seed.sql` — 种子数据（tools/feed/site + 12 条官方提示词，冲突跳过幂等）
- `wrangler.toml` — 部署配置（自定义域名、D1 id、`ALLOW_ORIGIN` CORS 白名单）
- `resolve.mjs` — 本地离线 IP→省/市 解析后回填 D1（不在请求路径上解析）
- `.env` — 本地凭据（CLOUDFLARE_API_TOKEN + ADMIN_TOKEN），**绝不入 git**

## 部署

```bash
export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2)
npx wrangler d1 execute analytics-db --remote -y --file=./schema.sql   # 建表（幂等）
npx wrangler d1 execute analytics-db --remote -y --file=./seed.sql     # 种子（幂等）
npx wrangler deploy
```

> ⚠️ 2026-09-19 起 deploy.sh 已删除（它每次运行会重置 ADMIN_TOKEN）。
> 全新空库首次搭建：`npx wrangler d1 create analytics-db` → id 填入 wrangler.toml →
> `npx wrangler secret put ADMIN_TOKEN` → 上面三条命令。

## 接口一览

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/tools` `/api/feed` `/api/site` | GET | 主站内容（缓存 60s） |
| `/api/visit` `/api/dwell` | POST | 老版单条访问上报（主站新代码走 /api/collect） |
| `/api/collect` | POST | 批量埋点：page_view→visits、dwell→回写停留、其余→events（限流 30/min/IP） |
| `/api/feedback` `/api/event` | POST | 留言（蜜罐）/ 单条事件 |
| `/api/prompts` | GET | 提示词站已发布列表（缓存 60s） |
| `/api/prompts/like` | POST | 点赞/取消（visitor 去重，返回权威计数） |
| `/api/prompts/submit` | POST | 投稿入库 pending（蜜罐，限流 3/min/IP，img dataURL ≤200KB 白名单） |
| `/api/prompts/feedback` | POST | 提示词站反馈（kind 白名单，蜜罐，限流 5/min/IP） |
| `/api/prompts/log` | POST | 关键节点日志批量接收（≤20 条/请求） |
| `/api/admin/tool` `/api/admin/feed` `/api/admin/site` | POST/DELETE | 主站内容管理 |
| `/api/admin/prompts` | GET | 提示词全状态列表（?status=pending） |
| `/api/admin/prompt` | POST | `{"id","action":"publish\|hide\|delete"}`，publish 自动分配下一可用 PF 编号 |
| `/admin?key=` | GET | 密码后台：统计图表 / 投稿审核 / 反馈 / 日志 |

管理接口认证：`X-Admin-Key` 头或 `?key=`，与 secret `ADMIN_TOKEN` 严格相等。

## D1 表

主站：`visits`（逐 IP 访问，含来源暗号 src/src_v/landing 与会话号）、`events`、`feedback`、`tools`、`feed`、`site`。
提示词站：`prompts`（status: pending/published/hidden，no 编号审核通过时分配）、`prompt_likes`（联合主键去重）、`prompt_feedback`、`pf_logs`（关键节点日志 + 服务端 error + admin_*）。

## 日志与上报约定（踩过的坑）

- Worker 内**响应返回之后**的 D1 写入必须经 `ctx.waitUntil`，否则被运行时取消（like 日志曾因此丢失）。
- 浏览器端跨域 `sendBeacon` + JSON Blob 会被静默丢弃，前端统一用 `fetch(..., {keepalive:true})`。

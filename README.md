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
| `/api/agent/log` | POST | 智能体对话全息记录（浏览器每轮后台上传，source=byok/relay，限流 30/min/IP） |
| `/api/agent/chat` | POST | **智能体中继**：公开站访客零配置用站方密钥对话（见下节） |
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
智能体：`agent_chats`（对话全息，浏览器上传，byok/relay 同表 source 区分）、`agent_relay_usage`（中继站点级每日用量）、`agent_relay_ip`（中继单 IP 每日用量）。
提示词站：`prompts`（status: pending/published/hidden，no 编号审核通过时分配）、`prompt_likes`（联合主键去重）、`prompt_feedback`、`pf_logs`（关键节点日志 + 服务端 error + admin_*）。

## 智能体中继（/api/agent/chat，服务 token情报站公开版）

公开站（price.agarena.xyz）访客**零配置**用站方密钥对话：浏览器把 OpenAI 兼容 chat 请求
发到本端点，Worker 持密钥转发智谱 paas/v4 并把 SSE 流原样透传回去。

- **安全模型**：只转发白名单字段（messages/tools/tool_choice/temperature），model 一律
  用 `RELAY_MODEL` 覆盖，绝不接受调用方 baseUrl/鉴权——中继只可能打到 `RELAY_BASE_URL`。
- **限额**（改 wrangler.toml `[vars]` 后 redeploy 即调参，不动静态站）：站点每日
  `RELAY_DAILY_BUDGET` 元（默认 5）＋单 IP 每日 `RELAY_IP_DAILY_BUDGET` 元（默认 1）＋
  每 IP 每分钟 15 次；日界按北京时区。成本＝usage tokens × `RELAY_PRICE_IN/OUT`
  （¥/百万 token 牌价，缓存命中按常规输入计价＝保守）。额度用尽返回 429＋引导文案
  （前端在会话内原样呈现）。
- **密钥**：`RELAY_API_KEY` 为 secret（`echo <key> | bash cf-relay.sh bash -c
  'npx wrangler secret put RELAY_API_KEY < keyfile'`——注意直接管道经 cf-relay.sh 会被
  隧道装配的 ssh 吞掉 stdin，必须在内层命令里重定向文件）。换模型/调价只改 vars。
- **记账**：流式透传的 flush 里写 `agent_relay_usage`（站点级）与 `agent_relay_ip`
  （单 IP）两表；访客中途断开（cancel 而非 close）时该轮上游消耗漏记——低估不超支，
  方向安全。对话内容不落本端（浏览器经 /api/agent/log 上传，source=relay），避免重复。
- **admin 后台**：「智能体中继用量」区显示近 7 日花费/tokens/调用数与今日用量 Top IP。

## 日志与上报约定（踩过的坑）

- Worker 内**响应返回之后**的 D1 写入必须经 `ctx.waitUntil`，否则被运行时取消（like 日志曾因此丢失）。
- 浏览器端跨域 `sendBeacon` + JSON Blob 会被静默丢弃，前端统一用 `fetch(..., {keepalive:true})`。

#!/usr/bin/env bash
# 用 API Token 非交互部署（免费，无需浏览器、无需绑卡）
# 用法：
#   export CLOUDFLARE_API_TOKEN=xxxx
#   export ADMIN_TOKEN=$(openssl rand -hex 16)   # 后台密码，自己记好
#   bash deploy.sh
# 说明：脚本会自动创建 D1、把返回的 id 填进 wrangler.toml、建表、设密码、发布。

set -e

: "${CLOUDFLARE_API_TOKEN:?请先 export CLOUDFLARE_API_TOKEN}"
export CLOUDFLARE_API_TOKEN

WRANGLER="wrangler"
command -v wrangler >/dev/null 2>&1 || WRANGLER="npx --yes wrangler"

# 后台密码：优先用环境变量，否则自动生成一个（会打印出来，请记下）
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p)
  echo "★ 自动生成后台密码 ADMIN_TOKEN=$ADMIN_TOKEN （请记下，部署后用于 /admin?key=...）"
fi
export ADMIN_TOKEN

# 1) 创建 D1（若已存在会报错，忽略即可；仍尝试解析已有 id）
DB_OUT=$($WRANGLER d1 create analytics-db 2>&1) || true
DB_ID=$(echo "$DB_OUT" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
if [ -n "$DB_ID" ]; then
  echo "D1 id=$DB_ID，写入 wrangler.toml"
  # 兼容 macOS/Linux 的 sed -i；Windows Git Bash 同样支持 -i.bak
  sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
  rm -f wrangler.toml.bak
else
  echo "未从创建输出中解析到 D1 id（可能已存在）。请确认 wrangler.toml 中 database_id 已正确填写。"
fi

# 2) 建表
$WRANGLER d1 execute analytics-db --file=./schema.sql

# 3) 设后台密码（从环境变量读取，非交互）
echo "$ADMIN_TOKEN" | $WRANGLER secret put ADMIN_TOKEN

# 4) 发布
$WRANGLER deploy

echo ""
echo "★ 部署完成。Worker 地址见上方输出（形如 https://demo-analytics.<sub>.workers.dev）。"
echo "  把它填进 demo-site/index.html 的 WORKER 常量，然后重新发布 demo 站。"

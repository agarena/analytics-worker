#!/bin/bash
# cf-relay.sh —— 免 Clash 的 Cloudflare 部署中继：本机 → SSH 隧道 → 腾讯轻量服务器
# 临时代理 → CF API。本机代理工具没开、直连被墙时用它包装任意 wrangler 命令。
#
# 用法（在 analytics-worker/ 目录）：
#   export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2)
#   bash cf-relay.sh npx wrangler deploy
#   bash cf-relay.sh npx wrangler d1 execute analytics-db --remote -y --file=./schema.sql
#   bash cf-relay.sh npx wrangler pages deploy <目录> --project-name=price-public --branch=main
#
# 代理只在服务器 127.0.0.1:18080 监听（经 SSH 隧道可达，外网不可达）；
# 命令结束自动拆隧道、杀服务器代理进程（脚本文件保留在 /tmp 供复用）。
set -e
KEY="$HOME/.agents/skills/tencent-lighthouse-ssh/0816.pem"
SRV=ubuntu@150.158.37.185
PORT=18080
cd "$(dirname "$0")"

# 服务器侧：确保临时代理在跑（幂等：先清旧实例，防多重绑定抢连接）
if ! ssh -i "$KEY" "$SRV" 'test -f /tmp/cf-relay-proxy.py' 2>/dev/null; then
  cat > /tmp/cf-relay-proxy.py <<'PYEOF'
#!/usr/bin/env python3
import socket, threading, select

def pipe(a, b):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 300)
            if not r:
                return
            for s in r:
                d = s.recv(65536)
                if not d:
                    return
                (b if s is a else a).sendall(d)
    except OSError:
        pass

def handle(c):
    u = None
    try:
        req = b""
        while b"\r\n\r\n" not in req:
            d = c.recv(4096)
            if not d:
                return
            req += d
        parts = req.split(b"\r\n")[0].decode().split()
        if len(parts) < 2 or parts[0] != "CONNECT":
            c.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        host, port = parts[1].rsplit(":", 1)
        u = socket.create_connection((host, int(port)), timeout=20)
        c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        pipe(c, u)
    except OSError:
        pass
    finally:
        for s in (c, u):
            if s:
                try:
                    s.close()
                except OSError:
                    pass

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 18080))
s.listen(64)
while True:
    conn, _addr = s.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
PYEOF
  scp -q -i "$KEY" /tmp/cf-relay-proxy.py "$SRV":/tmp/cf-relay-proxy.py
fi
printf '%s\n' '#!/bin/bash' \
  'pkill -f "[c]f-relay-proxy.py" 2>/dev/null' \
  'sleep 0.3' \
  'nohup python3 /tmp/cf-relay-proxy.py >/tmp/cf-relay-proxy.log 2>&1 &' \
  'sleep 0.8' > /tmp/cf-relay-restart.sh
scp -q -i "$KEY" /tmp/cf-relay-restart.sh "$SRV":/tmp/cf-relay-restart.sh
ssh -i "$KEY" "$SRV" 'bash /tmp/cf-relay-restart.sh'

# 本地隧道（后台），退出自动拆
ssh -i "$KEY" -N -L $PORT:127.0.0.1:$PORT "$SRV" &
TUNNEL=$!
cleanup() {
  kill $TUNNEL 2>/dev/null || true
  ssh -i "$KEY" "$SRV" 'pkill -f "[c]f-relay-proxy.py" 2>/dev/null || true' || true
}
trap cleanup EXIT
sleep 1.5

export HTTPS_PROXY=http://127.0.0.1:$PORT
echo "[cf-relay] 中继就绪（HTTPS_PROXY=http://127.0.0.1:$PORT），执行：$*"
"$@"

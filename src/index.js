// 轻量访客统计 + 留言反馈 + 密码后台
// 免费额度：Workers Free（10万次/天）+ D1 Free（5GB）
// 数据全部进 D1，逐 IP 明文存储；Worker 只做原始采集，不做地理解析
// （城市 / 地域解析交由后续离线程序基于 IP 回填）

// 绑定：DB = D1 数据库；env 变量：ADMIN_TOKEN（后台密码，secret）、ALLOW_ORIGIN（CORS 来源）

const RATE = new Map(); // 极简内存限流，防刷

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

// CORS：ALLOW_ORIGIN 支持逗号分隔的白名单源。
// "*" 表示全开放；否则仅放行列表内的源（回显该源，其余拒绝）。
function corsHeaders(env, request) {
  const allow = (env.ALLOW_ORIGIN || "*").trim();
  let origin = allow;
  if (allow !== "*" && request) {
    const reqOrigin = request.headers.get("Origin") || "";
    const list = allow.split(",").map((s) => s.trim());
    origin = list.includes(reqOrigin) ? reqOrigin : "";
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function withCors(res, headers) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

async function handleVisit(request, env) {
  const ip = clientIp(request);
  const now = Date.now();
  // 限流：同一 IP 每分钟最多 30 次写入
  const bucket = Math.floor(now / 60000);
  const rk = ip + ":" + bucket;
  RATE.set(rk, (RATE.get(rk) || 0) + 1);
  if (RATE.get(rk) > 30) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });

  const body = await request.json().catch(() => ({}));
  const cf = request.cf || {};
  const ua = request.headers.get("User-Agent") || "";
  const ref = request.headers.get("Referer") || "";
  const path = (body.path || "/").toString().slice(0, 300);
  const dwell = Number(body.dwell) || 0;

  // 原始采集：IP 与客户端信息原样存下。
  // 国家级字段由 Cloudflare 边缘节点白送（零外部请求、零暴露面增加），顺手存下；
  // 城市级（region/city）留空，交由后续离线程序基于 ip 解析后回填。
  await env.DB.prepare(
    `INSERT INTO visits (ip, ua, referer, path, day, ts, dwell_ms, country, continent, asn, isp, tz)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      ip, ua, ref, path,
      new Date(now).toISOString().slice(0, 10), now, dwell,
      cf.country || "??",
      cf.continent || "",
      cf.asn || null,
      cf.asOrganization || "",
      cf.timezone || ""
    )
    .run();

  return Response.json({ ok: true });
}

// 页面关闭时回写停留时长（更新该 IP 最新一行）
async function handleDwell(request, env) {
  const ip = clientIp(request);
  const body = await request.json().catch(() => ({}));
  const dwell = Number(body.dwell) || 0;
  await env.DB.prepare(
    `UPDATE visits SET dwell_ms = ? WHERE id = (SELECT id FROM visits WHERE ip = ? ORDER BY ts DESC LIMIT 1)`
  )
    .bind(dwell, ip)
    .run();
  return Response.json({ ok: true });
}

// 留言反馈（不公开，仅后台可见）；带蜜罐字段防机器人
async function handleFeedback(request, env) {
  const ip = clientIp(request);
  const body = await request.json().catch(() => ({}));
  if (body.hp) return Response.json({ ok: true }); // 蜜罐：人类不会填
  const msg = (body.message || "").toString().slice(0, 2000);
  const name = (body.name || "匿名").toString().slice(0, 60);
  if (!msg.trim()) return Response.json({ ok: false, msg: "empty" }, { status: 400 });
  await env.DB.prepare(`INSERT INTO feedback (ip, name, message, ts) VALUES (?,?,?,?)`)
    .bind(ip, name, msg, Date.now())
    .run();
  return Response.json({ ok: true });
}

// 交互事件（按钮点击等）：仅记录，不公开
async function handleEvent(request, env) {
  const ip = clientIp(request);
  const now = Date.now();
  const body = await request.json().catch(() => ({}));
  const type = (body.type || "event").toString().slice(0, 60);
  const detail = (body.detail || "").toString().slice(0, 200);
  const path = (body.path || "/").toString().slice(0, 300);
  await env.DB.prepare(
    `INSERT INTO events (ip, type, detail, path, day, ts) VALUES (?,?,?,?,?,?)`
  )
    .bind(ip, type, detail, path, new Date(now).toISOString().slice(0, 10), now)
    .run();
  return Response.json({ ok: true });
}

// 密码后台：聚合统计 + 反馈列表，返回内嵌图表的 HTML
async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("key") || request.headers.get("X-Admin-Key");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("401 Unauthorized", { status: 401 });
  }
  const days = Number(url.searchParams.get("days")) || 30;
  const since = Date.now() - days * 86400000;

  const total = await env.DB.prepare(`SELECT COUNT(*) c FROM visits WHERE ts > ?`).bind(since).first();
  const byCountry = await env.DB.prepare(
    `SELECT country, COUNT(*) c FROM visits WHERE ts > ? GROUP BY country ORDER BY c DESC LIMIT 20`
  ).bind(since).all();
  const byDay = await env.DB.prepare(
    `SELECT day, COUNT(*) c FROM visits WHERE ts > ? GROUP BY day ORDER BY day`
  ).bind(since).all();
  const byPath = await env.DB.prepare(
    `SELECT path, COUNT(*) c FROM visits WHERE ts > ? GROUP BY path ORDER BY c DESC LIMIT 20`
  ).bind(since).all();
  const avgDwell = await env.DB.prepare(
    `SELECT AVG(dwell_ms) a FROM visits WHERE ts > ? AND dwell_ms > 0`
  ).bind(since).first();
  const fb = await env.DB.prepare(`SELECT name, message, ts FROM feedback ORDER BY ts DESC LIMIT 50`).all();
  const btnClicks = await env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='btn_click' AND ts > ?`).bind(since).first();
  const events = await env.DB.prepare(`SELECT type, detail, ip, ts FROM events ORDER BY ts DESC LIMIT 30`).all();

  const data = {
    total: total?.c || 0,
    avgDwellSec: avgDwell?.a ? Math.round(avgDwell.a / 1000) : 0,
    btnClicks: btnClicks?.c || 0,
    byCountry: byCountry.results,
    byDay: byDay.results,
    byPath: byPath.results,
    feedback: fb.results,
    events: events.results,
  };

  return new Response(renderAdmin(data, days), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderAdmin(d, days) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const countryRows = d.byCountry
    .map((r) => `<tr><td>${esc(r.country)}</td><td>${r.c}</td></tr>`)
    .join("");
  const pathRows = d.byPath
    .map((r) => `<tr><td>${esc(r.path)}</td><td>${r.c}</td></tr>`)
    .join("");
  const fbRows = d.feedback.length
    ? d.feedback
        .map(
          (r) =>
            `<li><b>${esc(r.name)}</b> · ${new Date(r.ts).toLocaleString()}<br>${esc(r.message)}</li>`
        )
        .join("")
    : "<li>暂无留言</li>";

  const evRows = d.events.length
    ? d.events
        .map(
          (r) =>
            `<li><b>${esc(r.type)}</b> · ${esc(r.detail || "")} · <code>${esc(r.ip)}</code> · ${new Date(r.ts).toLocaleString()}</li>`
        )
        .join("")
    : "<li>暂无事件</li>";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>分析后台</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fb;color:#1f2733;margin:0;padding:24px;}
h1{font-size:20px;} .wrap{max-width:960px;margin:0 auto;}
.cards{display:flex;gap:16px;margin:16px 0;} .card{flex:1;background:#fff;border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(30,50,90,.08);}
.card .n{font-size:28px;font-weight:700;color:#3b6cf6;} .card .l{color:#6b7686;font-size:13px;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;}
.box{background:#fff;border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(30,50,90,.08);}
table{width:100%;border-collapse:collapse;font-size:13px;} td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f5;}
ul{font-size:13px;line-height:1.7;padding-left:18px;}
</style></head><body><div class="wrap">
<h1>访客分析后台（近 ${days} 天）</h1>
<div class="cards">
<div class="card"><div class="n">${d.total}</div><div class="l">总访问次数</div></div>
<div class="card"><div class="n">${d.avgDwellSec}s</div><div class="l">平均停留时长</div></div>
<div class="card"><div class="n">${d.byCountry.length}</div><div class="l">覆盖国家/地区</div></div>
<div class="card"><div class="n">${d.btnClicks}</div><div class="l">按钮点击次数</div></div>
</div>
<div class="grid">
<div class="box"><h3>每日访问趋势</h3><canvas id="trend"></canvas></div>
<div class="box"><h3>地域分布（Top）</h3><canvas id="geo"></canvas></div>
</div>
<div class="grid">
<div class="box"><h3>访问路径</h3><table><tr><th>路径</th><th>次数</th></tr>${pathRows}</table></div>
<div class="box"><h3>留言反馈（不公开）</h3><ul>${fbRows}</ul></div>
<div class="box" style="grid-column:1/-1;"><h3>交互事件 · 按钮点击等（不公开）</h3><ul>${evRows}</ul></div>
</div>
<script>
const byDay=${JSON.stringify(d.byDay)};
const byCountry=${JSON.stringify(d.byCountry)};
new Chart(document.getElementById('trend'),{type:'line',data:{labels:byDay.map(r=>r.day),datasets:[{label:'访问',data:byDay.map(r=>r.c),borderColor:'#3b6cf6',fill:false}]},options:{plugins:{legend:{display:false}}}});
new Chart(document.getElementById('geo'),{type:'bar',data:{labels:byCountry.map(r=>r.country),datasets:[{label:'访问',data:byCountry.map(r=>r.c),backgroundColor:'#3b6cf6'}]},options:{plugins:{legend:{display:false}},indexAxis:'y'}});
</script>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (p === "/api/visit" && request.method === "POST") return withCors(await handleVisit(request, env), cors);
      if (p === "/api/dwell" && request.method === "POST") return withCors(await handleDwell(request, env), cors);
      if (p === "/api/feedback" && request.method === "POST") return withCors(await handleFeedback(request, env), cors);
      if (p === "/api/event" && request.method === "POST") return withCors(await handleEvent(request, env), cors);
      if (p === "/admin") return await handleAdmin(request, env);
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response("err: " + e.message, { status: 500 });
    }
  },
};

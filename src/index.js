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
  const bySrc = await env.DB.prepare(
    `SELECT src, src_v, COUNT(*) c FROM visits WHERE ts > ? AND src IS NOT NULL AND src != '' GROUP BY src, src_v ORDER BY c DESC LIMIT 20`
  ).bind(since).all();
  const fb = await env.DB.prepare(`SELECT name, message, ts FROM feedback ORDER BY ts DESC LIMIT 50`).all();
  const btnClicks = await env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE type='btn_click' AND ts > ?`).bind(since).first();
  const events = await env.DB.prepare(`SELECT type, detail, ip, ts FROM events ORDER BY ts DESC LIMIT 30`).all();

  // 提示词站（prompts.agarena.xyz）：待审投稿 / 统计 / 反馈 / 关键节点日志
  const pendingN = await env.DB.prepare(`SELECT COUNT(*) c FROM prompts WHERE status='pending'`).first();
  const pendingList = await env.DB.prepare(
    `SELECT id, title, author, platform, account, url, scene, content, example, img, created_ts
     FROM prompts WHERE status='pending' ORDER BY created_ts DESC`
  ).all();
  const totalLikes = await env.DB.prepare(`SELECT COALESCE(SUM(likes),0) s FROM prompts`).first();
  const copiesN = await env.DB.prepare(`SELECT COUNT(*) c FROM pf_logs WHERE type='copy'`).first();
  const pfb = await env.DB.prepare(
    `SELECT kind, prompt_id, message, ip, ts FROM prompt_feedback ORDER BY ts DESC LIMIT 50`
  ).all();
  const pfLogTypes = await env.DB.prepare(
    `SELECT type, COUNT(*) c FROM pf_logs WHERE ts > ? GROUP BY type ORDER BY c DESC`
  ).bind(since).all();
  const pfLogRecent = await env.DB.prepare(
    `SELECT type, prompt_id, detail, ip, ts FROM pf_logs ORDER BY ts DESC LIMIT 100`
  ).all();

  const data = {
    total: total?.c || 0,
    avgDwellSec: avgDwell?.a ? Math.round(avgDwell.a / 1000) : 0,
    btnClicks: btnClicks?.c || 0,
    byCountry: byCountry.results,
    byDay: byDay.results,
    byPath: byPath.results,
    bySrc: bySrc.results,
    feedback: fb.results,
    events: events.results,
    pf: {
      pendingN: pendingN?.c || 0,
      pending: pendingList.results,
      totalLikes: totalLikes?.s || 0,
      copies: copiesN?.c || 0,
      pfb: pfb.results,
      logTypes: pfLogTypes.results,
      logRecent: pfLogRecent.results,
    },
  };

  return new Response(renderAdmin(data, days, token), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderAdmin(d, days, key) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const countryRows = d.byCountry
    .map((r) => `<tr><td>${esc(r.country)}</td><td>${r.c}</td></tr>`)
    .join("");
  const pathRows = d.byPath
    .map((r) => `<tr><td>${esc(r.path)}</td><td>${r.c}</td></tr>`)
    .join("");
  const srcRows = d.bySrc.length
    ? d.bySrc
        .map((r) => `<tr><td>${esc(r.src)}</td><td>${esc(r.src_v || "")}</td><td>${r.c}</td></tr>`)
        .join("")
    : '<tr><td colspan="3">暂无来源数据（站外链接需带 ?from= 参数）</td></tr>';
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

  // 提示词站区块
  const pfbRows = d.pf.pfb.length
    ? d.pf.pfb
        .map(
          (r) =>
            `<li><b>${esc(r.kind)}</b>${r.prompt_id ? " · " + esc(r.prompt_id) : ""} · <code>${esc(r.ip || "")}</code> · ${new Date(r.ts).toLocaleString()}<br>${esc(r.message)}</li>`
        )
        .join("")
    : "<li>暂无提示词反馈</li>";
  const pendingRows = d.pf.pending.length
    ? d.pf.pending
        .map(
          (r) =>
            `<div class="sub"><b>${esc(r.title)}</b> · ${esc(r.author)}${r.platform ? " · " + esc(r.platform) : ""} · ${new Date(r.created_ts).toLocaleString()}<br>` +
            `<span class="dim">场景：${esc(r.scene)}</span><br>` +
            `${esc(String(r.content).slice(0, 240))}${String(r.content).length > 240 ? "…" : ""}` +
            `${r.img ? `<br><img src="${esc(r.img)}" alt="配图">` : ""}<br>` +
            `<button data-pf-action="publish" data-id="${esc(r.id)}">通过上架</button>` +
            `<button data-pf-action="hide" data-id="${esc(r.id)}" class="warn">隐藏</button>` +
            `<button data-pf-action="delete" data-id="${esc(r.id)}" class="warn">删除</button></div>`
        )
        .join("")
    : "<div class='dim'>暂无待审投稿</div>";
  const logTypeRows = d.pf.logTypes.length
    ? d.pf.logTypes.map((r) => `<tr><td>${esc(r.type)}</td><td>${r.c}</td></tr>`).join("")
    : '<tr><td colspan="2">暂无日志</td></tr>';
  const logRows = d.pf.logRecent.length
    ? d.pf.logRecent
        .map(
          (r) =>
            `<li><b>${esc(r.type)}</b>${r.prompt_id ? " · " + esc(r.prompt_id) : ""}${r.detail ? " · " + esc(r.detail) : ""} · <code>${esc(r.ip || "")}</code> · ${new Date(r.ts).toLocaleString()}</li>`
        )
        .join("")
    : "<li>暂无日志</li>";

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
.sub{border:1px solid #eef1f5;border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px;line-height:1.7;background:#fbfcfe;}
.sub button{margin:8px 8px 0 0;padding:4px 14px;border:1px solid #3b6cf6;background:#fff;color:#3b6cf6;border-radius:6px;cursor:pointer;font-size:13px;}
.sub button:hover{background:#3b6cf6;color:#fff;}
.sub button.warn{border-color:#e5484d;color:#e5484d;}
.sub button.warn:hover{background:#e5484d;color:#fff;}
.sub img{max-width:220px;max-height:160px;border-radius:8px;margin-top:6px;display:block;}
.dim{color:#6b7686;font-size:12px;}
</style></head><body><div class="wrap">
<h1>访客分析后台（近 ${days} 天）</h1>
<div class="cards">
<div class="card"><div class="n">${d.total}</div><div class="l">总访问次数</div></div>
<div class="card"><div class="n">${d.avgDwellSec}s</div><div class="l">平均停留时长</div></div>
<div class="card"><div class="n">${d.byCountry.length}</div><div class="l">覆盖国家/地区</div></div>
<div class="card"><div class="n">${d.btnClicks}</div><div class="l">按钮点击次数</div></div>
<div class="card"><div class="n">${d.pf.pendingN}</div><div class="l">提示词待审投稿</div></div>
<div class="card"><div class="n">${d.pf.copies}</div><div class="l">提示词复制次数</div></div>
<div class="card"><div class="n">${d.pf.totalLikes}</div><div class="l">提示词总点赞</div></div>
</div>
<div class="grid">
<div class="box"><h3>每日访问趋势</h3><canvas id="trend"></canvas></div>
<div class="box"><h3>地域分布（Top）</h3><canvas id="geo"></canvas></div>
</div>
<div class="grid">
<div class="box"><h3>访问路径</h3><table><tr><th>路径</th><th>次数</th></tr>${pathRows}</table></div>
<div class="box"><h3>来源渠道（平台 · 内容编号）</h3><table><tr><th>平台</th><th>内容</th><th>次数</th></tr>${srcRows}</table></div>
<div class="box"><h3>留言反馈（不公开）</h3><ul>${fbRows}</ul></div>
<div class="box" style="grid-column:1/-1;"><h3>交互事件 · 按钮点击等（不公开）</h3><ul>${evRows}</ul></div>
<div class="box" style="grid-column:1/-1;"><h3>提示词投稿审核（待审 ${d.pf.pendingN} 条 · 通过后上架 prompts.agarena.xyz）</h3>${pendingRows}</div>
<div class="box"><h3>提示词反馈（不公开）</h3><ul>${pfbRows}</ul></div>
<div class="box"><h3>提示词日志 · 按类型（近 ${days} 天）</h3><table><tr><th>类型</th><th>次数</th></tr>${logTypeRows}</table></div>
<div class="box" style="grid-column:1/-1;"><h3>提示词日志 · 最近 100 条（不公开）</h3><ul>${logRows}</ul></div>
</div>
<script>
const KEY = ${JSON.stringify(key).replace(/</g, "\\u003c")};
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pf-action]");
  if (!b) return;
  if (!confirm((b.dataset.pfAction === "publish" ? "通过上架" : b.dataset.pfAction === "hide" ? "隐藏" : "删除") + "这条投稿？")) return;
  b.disabled = true;
  try {
    const r = await fetch("/api/admin/prompt?key=" + encodeURIComponent(KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.dataset.id, action: b.dataset.pfAction }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) location.reload();
    else { alert("操作失败：" + (j.msg || r.status)); b.disabled = false; }
  } catch (err) { alert("请求失败：" + err.message); b.disabled = false; }
});
const byDay=${JSON.stringify(d.byDay)};
const byCountry=${JSON.stringify(d.byCountry)};
new Chart(document.getElementById('trend'),{type:'line',data:{labels:byDay.map(r=>r.day),datasets:[{label:'访问',data:byDay.map(r=>r.c),borderColor:'#3b6cf6',fill:false}]},options:{plugins:{legend:{display:false}}}});
new Chart(document.getElementById('geo'),{type:'bar',data:{labels:byCountry.map(r=>r.country),datasets:[{label:'访问',data:byCountry.map(r=>r.c),backgroundColor:'#3b6cf6'}]},options:{plugins:{legend:{display:false}},indexAxis:'y'}});
</script>
</div></body></html>`;
}

// ---------- 内容接口：新主页从 D1 拉取展示内容（改库即改站，无需重新部署） ----------
function jparse(s, d) {
  try { return JSON.parse(s); } catch (e) { return d; }
}

function jsonRes(obj, cache) {
  const h = { "Content-Type": "application/json; charset=utf-8" };
  if (cache) h["Cache-Control"] = "public, max-age=" + cache;
  return new Response(JSON.stringify(obj), { headers: h });
}

async function handleTools(env) {
  const r = await env.DB.prepare(
    `SELECT slug, name, category, one_liner, links_json, media_json, qa_json
     FROM tools ORDER BY sort, id`
  ).all();
  const tools = (r.results || []).map((x) => ({
    slug: x.slug,
    name: x.name,
    category: x.category,
    one_liner: x.one_liner,
    links: jparse(x.links_json, []),
    media: jparse(x.media_json, []),
    qa: jparse(x.qa_json, []),
  }));
  return jsonRes(tools, 60);
}

async function handleFeed(env) {
  const r = await env.DB.prepare(`SELECT type, text FROM feed ORDER BY sort, id DESC`).all();
  return jsonRes(r.results || [], 60);
}

async function handleSite(env) {
  const r = await env.DB.prepare(`SELECT key, value FROM site`).all();
  const o = {};
  for (const x of r.results || []) o[x.key] = x.value;
  return jsonRes(o, 60);
}

// 新主页批量上报：page_view → visits（带边缘地理信息）；dwell → 回写停留时长；
// 其余事件（tool_view / outbound_click / demo_open / scroll_depth ...）→ events 表
async function handleCollect(request, env) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = Math.floor(now / 60000);
  const rk = ip + ":" + bucket;
  RATE.set(rk, (RATE.get(rk) || 0) + 1);
  if (RATE.get(rk) > 30) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });

  const body = await request.json().catch(() => ({}));
  const ctx = body.context || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
  const cf = request.cf || {};
  const ua = request.headers.get("User-Agent") || "";
  // 访客匿名卡号 / 会话号 / 来源暗号（?from=平台&v=内容编号），随 page_view 落库
  const anon = (body.anonId || "").toString().slice(0, 60) || null;
  const sid = (body.sessionId || "").toString().slice(0, 60) || null;
  const src = (ctx.src || "").toString().slice(0, 40) || null;
  const srcV = (ctx.v || "").toString().slice(0, 40) || null;
  const landing = (ctx.landing || "").toString().slice(0, 500) || null;

  for (const ev of events) {
    const type = (ev.type || "event").toString().slice(0, 60);
    const path = (ev.path || ctx.path || "/").toString().slice(0, 300);
    const ts = Number(ev.ts) || now;
    const day = new Date(ts).toISOString().slice(0, 10);

    if (type === "page_view") {
      await env.DB.prepare(
        `INSERT INTO visits (ip, ua, referer, path, day, ts, dwell_ms, country, continent, asn, isp, tz, anon_id, session_id, src, src_v, landing)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          ip, ua, ctx.referrer || request.headers.get("Referer") || "", path,
          day, ts,
          cf.country || "??", cf.continent || "", cf.asn || null,
          cf.asOrganization || "", cf.timezone || "",
          anon, sid, src, srcV, landing
        )
        .run();
    } else if (type === "dwell") {
      const dwell = Math.max(0, Number(ev.meta && ev.meta.dwell) || 0);
      if (dwell > 0) {
        // 优先按会话号回写（同一会话只有一次 page_view）；老访客无会话号时退回按 IP
        if (sid) {
          await env.DB.prepare(
            `UPDATE visits SET dwell_ms = ? WHERE id = (SELECT id FROM visits WHERE session_id = ? ORDER BY ts DESC LIMIT 1)`
          ).bind(dwell, sid).run();
        } else {
          await env.DB.prepare(
            `UPDATE visits SET dwell_ms = ? WHERE id = (SELECT id FROM visits WHERE ip = ? ORDER BY ts DESC LIMIT 1)`
          ).bind(dwell, ip).run();
        }
      }
    } else {
      const detail = JSON.stringify({
        t: ev.targetType != null ? ev.targetType : null,
        id: ev.targetId != null ? ev.targetId : null,
        url: ev.url != null ? ev.url : null,
        meta: ev.meta != null ? ev.meta : null,
      }).slice(0, 200);
      await env.DB.prepare(
        `INSERT INTO events (ip, type, detail, path, day, ts, session_id) VALUES (?,?,?,?,?,?,?)`
      ).bind(ip, type, detail, path, day, ts, sid).run();
    }
  }
  return Response.json({ ok: true, accepted: events.length });
}

// ---------- 管理写接口：改内容不用重新部署。密码与 /admin 相同 ----------
function isAdmin(request, env) {
  const t =
    request.headers.get("X-Admin-Key") ||
    new URL(request.url).searchParams.get("key") || "";
  return Boolean(env.ADMIN_TOKEN) && t === env.ADMIN_TOKEN;
}

function unauthorized() {
  return new Response("401 Unauthorized", { status: 401 });
}

// 新增/更新一个工具（slug 定位；JSON 字段传对象数组，不必自己拼字符串）
async function handleToolUpsert(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !b.name) return Response.json({ ok: false, msg: "name required" }, { status: 400 });
  const slug = (b.slug || b.name).toString().trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
  await env.DB.prepare(
    `INSERT INTO tools (slug, name, category, one_liner, sort, links_json, media_json, qa_json, updated_ts)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET
       name=excluded.name, category=excluded.category, one_liner=excluded.one_liner,
       sort=excluded.sort, links_json=excluded.links_json, media_json=excluded.media_json,
       qa_json=excluded.qa_json, updated_ts=excluded.updated_ts`
  )
    .bind(
      slug,
      b.name.toString().slice(0, 80),
      (b.category || "").toString().slice(0, 40),
      (b.one_liner || "").toString().slice(0, 500),
      Number(b.sort) || 0,
      JSON.stringify(b.links || []),
      JSON.stringify(b.media || []),
      JSON.stringify(b.qa || []),
      Date.now()
    )
    .run();
  return Response.json({ ok: true, slug });
}

// 跑马灯：POST {type:'update'|'news'|'soon', text} 加一条；DELETE ?id= 删一条
async function handleFeedPost(request, env) {
  const b = await request.json().catch(() => ({}));
  const text = (b.text || "").toString().slice(0, 120).trim();
  if (!text) return Response.json({ ok: false, msg: "text required" }, { status: 400 });
  const type = ["update", "news", "soon"].includes(b.type) ? b.type : "update";
  await env.DB.prepare(`INSERT INTO feed (type, text, created_ts) VALUES (?,?,?)`)
    .bind(type, text, Date.now())
    .run();
  return Response.json({ ok: true });
}

async function handleFeedDelete(request, env) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!id) return Response.json({ ok: false, msg: "id required" }, { status: 400 });
  await env.DB.prepare(`DELETE FROM feed WHERE id = ?`).bind(id).run();
  return Response.json({ ok: true });
}

// 站点信息：POST {brand_name, contact_email} 任意子集
async function handleSiteSet(request, env) {
  const b = await request.json().catch(() => ({}));
  for (const k of ["brand_name", "contact_email"]) {
    if (b[k] === undefined || b[k] === null || b[k] === "") continue;
    await env.DB.prepare(
      `INSERT INTO site (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
      .bind(k, b[k].toString().slice(0, 120))
      .run();
  }
  return Response.json({ ok: true });
}

// ---------- 提示词聚合网站（prompts.agarena.xyz）----------

// 关键节点日志写入（pf_logs 表）：尽力而为，写失败不影响主流程。
// 传 ctx 时走 waitUntil 不阻塞响应；不传则由调用方自行 await 返回的 Promise。
function pfLog(env, ctx, entry) {
  const ts = Number(entry.ts) || Date.now();
  const p = env.DB.prepare(
    `INSERT INTO pf_logs (type, prompt_id, detail, ip, visitor_id, session_id, day, ts) VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      (entry.type || "event").toString().slice(0, 60),
      (entry.prompt_id || "").toString().slice(0, 60),
      entry.detail != null ? JSON.stringify(entry.detail).slice(0, 500) : "",
      entry.ip || "",
      (entry.visitor_id || "").toString().slice(0, 60),
      (entry.session_id || "").toString().slice(0, 60),
      new Date(ts).toISOString().slice(0, 10),
      ts
    )
    .run();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
  return p;
}

// 已发布列表（前端缓存 60s，字段与前端卡片对象对齐）
async function handlePromptsList(env) {
  const r = await env.DB.prepare(
    `SELECT id, no, title, author, platform, account, url, tags_json, scene, content, example, img, likes, created_ts, updated_ts
     FROM prompts WHERE status = 'published' ORDER BY updated_ts DESC`
  ).all();
  const list = (r.results || []).map((x) => ({
    id: x.id,
    no: x.no || "",
    title: x.title,
    author: x.author || "",
    platform: x.platform || "",
    account: x.account || "",
    url: x.url || "",
    tags: jparse(x.tags_json, []),
    scene: x.scene || "",
    content: x.content,
    example: x.example || "",
    img: x.img || "",
    likes: x.likes || 0,
    ts: x.updated_ts || x.created_ts || 0,
  }));
  return jsonRes(list, 60);
}

// 限流：key 可加后缀隔离配额（如 ':sub' 给投稿/反馈更严的额度）
function rateLimit(request, extra) {
  const ip = clientIp(request);
  const rk = ip + ":" + Math.floor(Date.now() / 60000) + (extra || "");
  RATE.set(rk, (RATE.get(rk) || 0) + 1);
  return RATE.get(rk) <= 30;
}

// 点赞/取消：prompt_likes 去重表 + prompts.likes 计数，batch 保证一致
async function handlePromptLike(request, env) {
  if (!rateLimit(request)) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString().slice(0, 60);
  const vid = (body.vid || "").toString().slice(0, 60);
  if (!id || !vid) return Response.json({ ok: false, msg: "id/vid required" }, { status: 400 });
  const wantLike = body.liked !== false;

  const cur = await env.DB.prepare(`SELECT 1 AS x FROM prompt_likes WHERE prompt_id = ? AND visitor_id = ?`)
    .bind(id, vid)
    .first();
  const now = Date.now();
  if (wantLike && !cur) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO prompt_likes (prompt_id, visitor_id, ts) VALUES (?,?,?)`).bind(id, vid, now),
      env.DB.prepare(`UPDATE prompts SET likes = likes + 1 WHERE id = ?`).bind(id),
    ]);
  } else if (!wantLike && cur) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM prompt_likes WHERE prompt_id = ? AND visitor_id = ?`).bind(id, vid),
      env.DB.prepare(`UPDATE prompts SET likes = MAX(likes - 1, 0) WHERE id = ?`).bind(id),
    ]);
  }
  const row = await env.DB.prepare(`SELECT likes FROM prompts WHERE id = ?`).bind(id).first();
  pfLog(env, null, {
    type: wantLike ? "like" : "unlike",
    prompt_id: id,
    ip: clientIp(request),
    visitor_id: vid,
    ts: now,
  }).catch(() => {});
  return Response.json({ ok: true, liked: wantLike, likes: row ? row.likes : null });
}

// 投稿：先审后显，入库 status='pending'，展示编号待审核通过时分配
async function handlePromptSubmit(request, env, ctx) {
  if (!rateLimit(request, ":sub")) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  if (body.hp) return Response.json({ ok: true }); // 蜜罐：人类不会填
  const title = (body.title || "").toString().trim().slice(0, 80);
  const scene = (body.scene || "").toString().trim().slice(0, 300);
  const content = (body.content || "").toString().trim().slice(0, 6000);
  const example = (body.example || "").toString().trim().slice(0, 2000);
  const platform = (body.platform || "").toString().slice(0, 40);
  const account = (body.account || "").toString().slice(0, 60);
  let url = (body.url || "").toString().trim().slice(0, 300);
  if (url && !/^https?:\/\/.+\..+/i.test(url)) url = "";
  let img = (body.img || "").toString();
  // 只接受前端压缩后的图片 dataURL，且 ≤200KB；否则丢弃（不影响文字投稿）
  if (img && !(/^data:image\/(png|jpe?g|webp);base64,/.test(img) && img.length <= 200 * 1024)) img = "";
  if (!title || !scene || !content)
    return Response.json({ ok: false, msg: "title/scene/content required" }, { status: 400 });

  const now = Date.now();
  const id = "u" + now;
  await env.DB.prepare(
    `INSERT INTO prompts (id, title, author, platform, account, url, tags_json, scene, content, example, img, likes, status, source, created_ts, updated_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'pending','user',?,?)`
  )
    .bind(
      id, title, account || "匿名作者", platform, account, url,
      JSON.stringify(["投稿"]), scene, content, example, img, now, now
    )
    .run();
  pfLog(env, ctx, { type: "submit", prompt_id: id, ip: clientIp(request), visitor_id: body.vid, detail: { title, platform } });
  return Response.json({ ok: true, id });
}

// 提示词站反馈（评价/建议/问题，可关联卡片），仅后台可见
async function handlePromptFeedback(request, env, ctx) {
  if (!rateLimit(request, ":sub")) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  if (body.hp) return Response.json({ ok: true });
  const text = (body.text || "").toString().trim().slice(0, 2000);
  if (!text) return Response.json({ ok: false, msg: "empty" }, { status: 400 });
  const kind = ["评价", "建议", "问题"].includes(body.kind) ? body.kind : "评价";
  const pid = (body.promptId || "").toString().slice(0, 60);
  await env.DB.prepare(
    `INSERT INTO prompt_feedback (kind, prompt_id, message, ip, visitor_id, ts) VALUES (?,?,?,?,?,?)`
  )
    .bind(kind, pid || null, text, clientIp(request), (body.vid || "").toString().slice(0, 60) || null, Date.now())
    .run();
  pfLog(env, ctx, { type: "feedback", prompt_id: pid, ip: clientIp(request), visitor_id: body.vid, detail: { kind } });
  return Response.json({ ok: true });
}

// 前端行为日志批量接收（sendBeacon / fetch keepalive）
async function handlePromptLog(request, env) {
  if (!rateLimit(request)) return Response.json({ ok: false, msg: "rate limited" }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  const ip = clientIp(request);
  await Promise.all(
    events.map((ev) =>
      pfLog(env, null, {
        type: ev.type,
        prompt_id: ev.promptId,
        detail: ev.meta != null ? ev.meta : null,
        ip,
        visitor_id: body.vid,
        session_id: body.sid,
        ts: Number(ev.ts) || Date.now(),
      }).catch(() => {})
    )
  );
  return Response.json({ ok: true, accepted: events.length });
}

// 管理：全状态列表（?status=pending|published|hidden 过滤可选）
async function handleAdminPrompts(request, env) {
  const status = new URL(request.url).searchParams.get("status");
  const sql = `SELECT id, no, title, author, platform, account, url, tags_json, scene, content, example, img, likes, status, source, created_ts, updated_ts
               FROM prompts ${status ? "WHERE status = ?" : ""} ORDER BY updated_ts DESC`;
  const r = status ? await env.DB.prepare(sql).bind(status).all() : await env.DB.prepare(sql).all();
  return Response.json({ ok: true, items: r.results || [] });
}

// 管理：publish（分配下一可用 PF 编号）/ hide / delete（连带清点赞）
async function handlePromptAdmin(request, env, ctx) {
  const b = await request.json().catch(() => null);
  const id = b && (b.id || "").toString().slice(0, 60);
  const action = b && b.action;
  if (!id || !["publish", "hide", "delete"].includes(action))
    return Response.json({ ok: false, msg: "id/action required" }, { status: 400 });

  if (action === "publish") {
    const rows = await env.DB.prepare(`SELECT no FROM prompts WHERE no LIKE 'PF-%'`).all();
    const used = new Set(
      (rows.results || []).map((x) => parseInt(String(x.no).slice(3), 10)).filter((n) => !isNaN(n))
    );
    let n = 1;
    while (used.has(n)) n++;
    const no = "PF-" + String(n).padStart(2, "0");
    await env.DB.prepare(`UPDATE prompts SET status='published', no=?, updated_ts=? WHERE id=?`)
      .bind(no, Date.now(), id)
      .run();
    pfLog(env, ctx, { type: "admin_publish", prompt_id: id, detail: { no } });
    return Response.json({ ok: true, no });
  }
  if (action === "hide") {
    await env.DB.prepare(`UPDATE prompts SET status='hidden', updated_ts=? WHERE id=?`).bind(Date.now(), id).run();
    pfLog(env, ctx, { type: "admin_hide", prompt_id: id });
    return Response.json({ ok: true });
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM prompt_likes WHERE prompt_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM prompts WHERE id = ?`).bind(id),
  ]);
  pfLog(env, ctx, { type: "admin_delete", prompt_id: id });
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (p === "/api/visit" && request.method === "POST") return withCors(await handleVisit(request, env), cors);
      if (p === "/api/dwell" && request.method === "POST") return withCors(await handleDwell(request, env), cors);
      if (p === "/api/feedback" && request.method === "POST") return withCors(await handleFeedback(request, env), cors);
      if (p === "/api/event" && request.method === "POST") return withCors(await handleEvent(request, env), cors);
      if (p === "/api/tools" && request.method === "GET") return withCors(await handleTools(env), cors);
      if (p === "/api/feed" && request.method === "GET") return withCors(await handleFeed(env), cors);
      if (p === "/api/site" && request.method === "GET") return withCors(await handleSite(env), cors);
      if (p === "/api/collect" && request.method === "POST") return withCors(await handleCollect(request, env), cors);
      // 提示词聚合网站
      if (p === "/api/prompts" && request.method === "GET") return withCors(await handlePromptsList(env), cors);
      if (p === "/api/prompts/like" && request.method === "POST") return withCors(await handlePromptLike(request, env), cors);
      if (p === "/api/prompts/submit" && request.method === "POST") return withCors(await handlePromptSubmit(request, env, ctx), cors);
      if (p === "/api/prompts/feedback" && request.method === "POST") return withCors(await handlePromptFeedback(request, env, ctx), cors);
      if (p === "/api/prompts/log" && request.method === "POST") return withCors(await handlePromptLog(request, env), cors);
      if (p === "/api/admin/tool" && request.method === "POST")
        return isAdmin(request, env) ? withCors(await handleToolUpsert(request, env), cors) : unauthorized();
      if (p === "/api/admin/feed" && request.method === "POST")
        return isAdmin(request, env) ? withCors(await handleFeedPost(request, env), cors) : unauthorized();
      if (p === "/api/admin/feed" && request.method === "DELETE")
        return isAdmin(request, env) ? withCors(await handleFeedDelete(request, env), cors) : unauthorized();
      if (p === "/api/admin/site" && request.method === "POST")
        return isAdmin(request, env) ? withCors(await handleSiteSet(request, env), cors) : unauthorized();
      if (p === "/api/admin/prompts" && request.method === "GET")
        return isAdmin(request, env) ? withCors(await handleAdminPrompts(request, env), cors) : unauthorized();
      if (p === "/api/admin/prompt" && request.method === "POST")
        return isAdmin(request, env) ? withCors(await handlePromptAdmin(request, env, ctx), cors) : unauthorized();
      if (p === "/admin") return await handleAdmin(request, env);
      return new Response("not found", { status: 404 });
    } catch (e) {
      // 提示词站路由出错时记服务端日志（尽力而为，不掩盖原始错误）
      if (p.startsWith("/api/prompts")) {
        try {
          pfLog(env, ctx, {
            type: "error",
            detail: { route: p, method: request.method, msg: String(e.message).slice(0, 300) },
            ip: clientIp(request),
          });
        } catch (_) {}
      }
      return new Response("err: " + e.message, { status: 500 });
    }
  },
};

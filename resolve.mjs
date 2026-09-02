// 离线解析 + 回填：把 visits 表里 city 为空的行的 IP，用 ip2region 解析成省/市，写回 D1。
// 与访客请求路径完全解耦——只在你自己的机器/服务器上跑，不增加任何暴露面、零成本。
//
// 前提：
//   1) 已安装并登录 wrangler（或设了环境变量 CLOUDFLARE_API_TOKEN），且 wrangler.toml 中 database_id 已填。
//   2) 在本目录执行一次： npm install ip2region
//   注：ip2region 不同版本 API 略有差异；若构造 Searcher 或 search 调用报错，请按所装版本 README 微调。
//
// 用法： node resolve.mjs
// 可定时跑（如 crontab 每天一次），每次只处理 city 仍为空的行。

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Searcher } = require("ip2region");

const DB = "analytics-db";

// 调用 wrangler d1 execute；读时返回结果数组，写时不返回。兼容 wrangler 不同版本的 JSON 结构。
function query(sql, isWrite = false) {
  const args = ["wrangler", "d1", "execute", DB, "--command", sql, "--json"];
  const out = execFileSync("npx", args, { encoding: "utf8" });
  if (isWrite) return;
  return extractResults(JSON.parse(out));
}

function extractResults(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.results)) return obj.results;
  for (const k of Object.keys(obj)) {
    const v = extractResults(obj[k]);
    if (v) return v;
  }
  return null;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/'/g, "''");
}

const rows = query("SELECT id, ip FROM visits WHERE city IS NULL OR city = '' LIMIT 2000");
if (!rows || !rows.length) {
  console.log("没有待解析的记录了，全部已填城市。");
  process.exit(0);
}
console.log(`待解析 ${rows.length} 条`);

const searcher = new Searcher();
let done = 0,
  failed = 0;
for (const row of rows) {
  try {
    // ip2region 返回形如 { region: "中国|0|广东省|深圳市|电信" }
    const res = searcher.search(row.ip);
    const region = (res && (res.region || res.regionStr)) || "";
    const parts = region.split("|");
    const province = parts[2] || ""; // 省/直辖市
    const city = parts[3] || ""; // 城市
    // 只回填省级与市级；国家级保留 Cloudflare 边缘已给的国家码，不动它。
    query(
      `UPDATE visits SET region='${esc(province)}', city='${esc(city)}' WHERE id=${Number(row.id)}`,
      true
    );
    done++;
  } catch (e) {
    failed++;
    console.error(`解析失败 ${row.ip}: ${e.message}`);
  }
}
console.log(`完成：成功 ${done}，失败 ${failed}`);

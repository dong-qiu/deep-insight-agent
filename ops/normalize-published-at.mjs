/** 一次性 backfill：把 DB 里已有的 published_at 字符串（多数 RFC 2822）统一归一化到 ISO 8601。
 *  解决根因：之前存的是原始 feed 字符串，SQL 字典序与时间序不一致 → 窗口过滤 / 排序均失效。
 *
 *  幂等：已是 ISO 8601 的不动；解析失败的也不动（保留原值或 NULL）。
 *
 *  用法：docker compose exec -T app node /app/ops/normalize-published-at.mjs */
import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH || "/data/insight.db";
const db = new Database(dbPath);

// 复用 parsePublishedAt 的语义（内嵌避免 import 编译后模块路径问题）
function parsePublishedAt(s) {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

const rows = db.prepare("SELECT id, published_at FROM content_item WHERE published_at IS NOT NULL").all();
console.log(`扫描 ${rows.length} 条带 published_at 的 content_item…\n`);

const update = db.prepare("UPDATE content_item SET published_at = ? WHERE id = ?");
let normalized = 0, kept = 0, failed = 0;

const tx = db.transaction((items) => {
  for (const r of items) {
    const iso = parsePublishedAt(r.published_at);
    if (iso === r.published_at) {
      kept++; // 已是 ISO 不动
    } else if (iso == null) {
      failed++; // 解析失败保留原值
    } else {
      update.run(iso, r.id);
      normalized++;
    }
  }
});
tx(rows);

console.log(`归一化：${normalized} 条`);
console.log(`已是 ISO 跳过：${kept} 条`);
console.log(`解析失败保留原值：${failed} 条`);

// 抽 3 条示例展示
const sample = db.prepare(`
  SELECT title, published_at FROM content_item
  WHERE published_at LIKE '202%T%Z' ORDER BY published_at DESC LIMIT 5
`).all();
console.log(`\n归一化后样本（按 published_at DESC，字典序 = 时间序）：`);
for (const s of sample) {
  console.log(`  · ${s.published_at} · ${s.title.slice(0, 60)}`);
}

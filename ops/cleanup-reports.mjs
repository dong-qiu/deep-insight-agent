/** 一次性清理重复 / 为空的 Daily Brief（dogfood feedback 2026-06-06）。
 *
 *  策略：
 *  - 空报告（0 洞察）→ 直接删；
 *  - 同 topic 同日多份（cron 每 6h 跑 + 历史毫秒级双写）→ 保留洞察数最多 +
 *    citation_count 最多 + generated_at 最晚那一份，其余删；
 *  - FS 正文缺失（5 月历史包袱）不动，作"诚实空状态"测试样本保留。
 *
 *  幂等：删过的不会再删（按 id 决定）。
 *  事务：DB 删除 + FS 删除两段独立——DB 出错回滚，FS 删除是 best-effort。
 *
 *  用法：docker compose exec -T app node /app/ops/cleanup-reports.mjs --apply
 *        缺 --apply 则 dry-run（只打印不动）。 */
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const dbPath = process.env.DB_PATH || "/data/insight.db";
const db = new Database(dbPath);

// 1. 先收齐"应该删的 id 集合"
const allReports = db.prepare(`
  SELECT id, topic_id, date(generated_at) d, generated_at, citation_count,
         json_array_length(insight_ids) as insight_count, body_path
  FROM report ORDER BY generated_at DESC
`).all();

const toDelete = new Set();
const reasons = new Map();

// 1.a 空报告
for (const r of allReports) {
  if (r.insight_count === 0 || r.citation_count === 0) {
    toDelete.add(r.id);
    reasons.set(r.id, `0 洞察/引用`);
  }
}

// 1.b 同 topic 同日多份：留最丰富的，删其余
const grouped = new Map(); // "topic_id|date" → reports[]
for (const r of allReports) {
  const k = `${r.topic_id}|${r.d}`;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(r);
}
for (const [k, reports] of grouped) {
  if (reports.length <= 1) continue;
  // 排序：insight_count DESC, citation_count DESC, generated_at DESC
  reports.sort((a, b) =>
    b.insight_count - a.insight_count ||
    b.citation_count - a.citation_count ||
    b.generated_at.localeCompare(a.generated_at),
  );
  const keep = reports[0];
  for (const r of reports.slice(1)) {
    toDelete.add(r.id);
    reasons.set(r.id, (reasons.get(r.id) ?? "") + ` · 同${k}重复（留 ${keep.id}）`);
  }
}

console.log(`扫描 ${allReports.length} 份报告，应删 ${toDelete.size} 份：\n`);
for (const r of allReports) {
  if (!toDelete.has(r.id)) continue;
  console.log(`  ✗ ${r.id} · ${r.topic_id.padEnd(22)} · ${r.d} · ${r.insight_count}洞察/${r.citation_count}引用 · ${reasons.get(r.id)}`);
}

console.log(`\n保留的 ${allReports.length - toDelete.size} 份：`);
for (const r of allReports) {
  if (toDelete.has(r.id)) continue;
  console.log(`  ✓ ${r.id} · ${r.topic_id.padEnd(22)} · ${r.d} · ${r.insight_count}洞察/${r.citation_count}引用`);
}

if (!APPLY) {
  console.log(`\n[dry-run] 加 --apply 真正删除。`);
  process.exit(0);
}

console.log(`\n=== 执行删除 ===`);
const ids = [...toDelete];
const tx = db.transaction(() => {
  // FK：report_index 依赖 report、report_fts 是虚表无 FK 但需手动清；
  // ppt_polish_cache 可能也引用了该报告。
  for (const id of ids) {
    db.prepare("DELETE FROM ppt_polish_cache WHERE report_id = ?").run(id);
    db.prepare("DELETE FROM report_fts WHERE report_id = ?").run(id);
    db.prepare("DELETE FROM report_index WHERE report_id = ?").run(id);
    db.prepare("DELETE FROM report WHERE id = ?").run(id);
  }
});
tx();
console.log(`  ✓ DB 删 ${ids.length} 行（report + report_index + report_fts + ppt_polish_cache）`);

// FS 文件 best-effort
let fsCount = 0;
for (const r of allReports) {
  if (!toDelete.has(r.id)) continue;
  for (const ext of [".md", ".html"]) {
    const p = `${r.body_path}${ext}`;
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        fsCount++;
      }
    } catch (e) {
      console.warn(`  ⚠ ${p} 删失败: ${e.message}`);
    }
  }
}
console.log(`  ✓ FS 删 ${fsCount} 文件（.md + .html）`);
console.log(`\n完成。`);

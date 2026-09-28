/** 一次性清理重复 / 为空的 Daily Brief（dogfood feedback 2026-06-06）。
 *
 *  策略：
 *  - 空报告（0 洞察）→ 直接删；
 *  - 同 topic 同日多份（cron 每 6h 跑 + 历史毫秒级双写）→ 保留洞察数最多 +
 *    citation_count 最多 + generated_at 最晚那一份，其余删；
 *  - FS 正文缺失（5 月历史包袱）不动，作"诚实空状态"测试样本保留。
 *
 *  旧删除实现没有 redaction registry/发布协议，现只保留候选预览。
 *
 *  用法：DB_PATH=/path/to/standalone-snapshot.db node ops/cleanup-reports.mjs（仅预览）。 */
import { openReadonlyReportSnapshot } from "./readonly-report-snapshot.mjs";

if (process.argv.length !== 2) {
  console.error("仅支持无参数预览；--apply 已停用，报告删除须走 redaction registry 协议。");
  process.exit(2);
}
const db = openReadonlyReportSnapshot(process.env.DB_PATH);

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

db.close();
console.log("\n只读预览完成；旧 --apply 已停用，未删除报告或文件。");

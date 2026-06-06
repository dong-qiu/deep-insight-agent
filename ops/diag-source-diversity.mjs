/** 复现 6/4 cron 跑 rep_16c20be4 时的 selectAnalysisItems → rankAndDiversify。
 *  对比 analyzer 实际产洞察用到的 ci 分布、看哪一环导致单源垄断。 */
import Database from "better-sqlite3";
const db = new Database("/data/insight.db", { readonly: true });

// ── 复现 listContentForTopic ──
const sinceHours = 168; // PIPELINE_WINDOW_HOURS 默认
const reportGenAt = "2026-06-04T04:00:00Z";
const reportMs = Date.parse(reportGenAt);
const since = new Date(reportMs - sinceHours * 3_600_000).toISOString();
console.log(`窗口：${since.slice(0, 19)}Z → ${reportGenAt.slice(0, 19)}Z (7 天)\n`);

const candidates = db.prepare(`
  SELECT * FROM content_item
  WHERE topic_ids LIKE '%"t_code_agents"%'
    AND fetched_at >= ?
  ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 800
`).all(since).map((r) => ({
  ...r,
  topic_ids: JSON.parse(r.topic_ids),
  tags: JSON.parse(r.tags),
}));
console.log(`候选池：${candidates.length} 条`);

const bySrc = {};
for (const c of candidates) bySrc[c.source_id] = (bySrc[c.source_id] || 0) + 1;
console.log("候选池源分布：");
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(30)} ${n}`);
}

// ── 复现 keywordTokens + relevanceScore + rankAndDiversify ──
const topic = db.prepare("SELECT * FROM topic WHERE id='t_code_agents'").get();
const keywords = JSON.parse(topic.keywords);
console.log(`\n主题关键词（${keywords.length}）：${keywords.slice(0, 5).join(", ")}...`);

function keywordTokens(keywords) {
  const toks = new Set();
  for (const kw of keywords) {
    for (const t of kw.toLowerCase().split(/[\s/]+/)) {
      const minLen = /[a-z]/.test(t) ? 3 : 2;
      if (t.length >= minLen) toks.add(t);
    }
  }
  return [...toks];
}
const tokens = keywordTokens(keywords);
console.log(`Token 化（${tokens.length}）：${tokens.slice(0, 8).join(", ")}...`);

function relevanceScore(item, tokens) {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  return tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

const limit = 15;
const ranked = candidates
  .map((it, i) => ({ it, s: relevanceScore(it, tokens), i }))
  .sort((a, b) => b.s - a.s || a.i - b.i);

console.log(`\n=== ranked Top 20 候选（相关度分 + 源）===`);
for (const r of ranked.slice(0, 20)) {
  console.log(`  分=${r.s.toString().padStart(2)} ${r.it.source_id.padEnd(30)} ${r.it.title.slice(0, 60)}`);
}

const perSourceCap = Math.max(2, Math.ceil(limit / 3));
console.log(`\nperSourceCap = ${perSourceCap}\n`);

const bySource = new Map();
const out = [];
const takenIds = new Set();
for (const { it } of ranked) {
  if (out.length >= limit) break;
  const c = bySource.get(it.source_id) ?? 0;
  if (c >= perSourceCap) continue;
  bySource.set(it.source_id, c + 1);
  takenIds.add(it.id);
  out.push(it);
}
if (out.length < limit) {
  for (const { it } of ranked) {
    if (out.length >= limit) break;
    if (!takenIds.has(it.id)) {
      takenIds.add(it.id);
      out.push(it);
    }
  }
}

console.log(`=== rankAndDiversify 选出 ${out.length} 条（喂 analyzer）===`);
const selSrc = {};
for (const c of out) selSrc[c.source_id] = (selSrc[c.source_id] || 0) + 1;
for (const [s, n] of Object.entries(selSrc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(30)} ${n}`);
}
console.log(`\n喂 analyzer 的 15 条列表（标题前 60 字）：`);
for (const c of out) {
  console.log(`  ${c.source_id.padEnd(30)} ${c.title.slice(0, 60)}`);
}

// ── analyzer 实际选了哪些（rep_16c20be4 引用的 ci）──
console.log(`\n=== rep_16c20be4 实际引用的 ci（去重）===`);
const usedCis = db.prepare(`
  SELECT DISTINCT ci.id, ci.title, ci.source_id
  FROM citation c
  JOIN insight i ON i.id = c.insight_id
  JOIN content_item ci ON ci.id = c.content_item_id
  WHERE i.id IN (SELECT value FROM json_each((SELECT insight_ids FROM report WHERE id='rep_16c20be4')))
`).all();
console.log(`共 ${usedCis.length} 篇 content_item 被 24 次引用`);
for (const u of usedCis) {
  console.log(`  ${u.source_id.padEnd(30)} ${u.title.slice(0, 60)}`);
}

// 看这些 ci 是否在 selectAnalysisItems 选的 15 条里
const out15Ids = new Set(out.map((x) => x.id));
const inSelection = usedCis.filter((u) => out15Ids.has(u.id));
console.log(`\n→ ${inSelection.length}/${usedCis.length} 实际引用的 ci 在 selectAnalysisItems 选的 15 条里`);

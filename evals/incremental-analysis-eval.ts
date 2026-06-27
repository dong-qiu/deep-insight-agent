/** ADR-0009 切片2b：增量分析「时序对照」eval harness。
 *
 *  正确性闸（run-a1 做不了）：同一窗口分别用「全析」vs「增量(切片2)」产洞察，比质量是否等价。
 *  核心风险 = **跨条综合损失**：增量只析新 item、复用旧 item 的单源缓存洞察 → 丢「新×旧」跨条综合（ADR 估 ~4%）。
 *
 *  做法（单窗对照，成本有界）：
 *   1. 把每个 case 的 items 按 published_at 排序，older 60% 当「已缓存」（模拟前几日已析）、newer 40% 当「新 item」。
 *   2. seed：analyze(cached) 单独跑 → recordAnalysisCache（= 旧 item 在「没有新 item 语境」下的缓存洞察）。
 *   3. **全析**：analyze(all) → validate → metrics_full（cached+fresh 同批 → 跨条综合可发生）。
 *   4. **增量**：lookupCachedInsights(all) → 命中=cached、未命中=fresh → analyze(fresh) + 复用 cached → validate → metrics_inc。
 *   5. 比：洞察数 / 多源数(跨条综合) / 可达 / 一致 / 被采纳(≥1 pass 引用)。增量应保留绝大多数 + 多源损失 ≤ 阈，可达/一致不退。
 *
 *  用法：`npx tsx evals/incremental-analysis-eval.ts`（需 .env.local 的 key + ANALYZER≠VALIDATOR 模型）。
 *  INC_EVAL_CASES=N 限跑前 N 个 case（默认全 5，控成本）；A1_QUALITY_FILE 可指向其它数据集。 */
import "./load-env.js";
import { readFileSync } from "node:fs";
import { analyze, analyzerCacheVersion } from "../src/lib/agents/analyzer.js";
import { validateBatch } from "../src/lib/agents/validator.js";
import {
  instantiateCachedInsights, lookupCachedInsights, recordAnalysisCache,
} from "../src/lib/db/analysis-cache.js";
import { openDb } from "../src/lib/db/index.js";
import { contentHash } from "../src/lib/sources/normalize.js";
import { assertModelSeparation, getCostReport, MODELS } from "../src/lib/runtime/llm.js";
import type { ContentItem, Insight, Topic, ValidationResult } from "../src/lib/types.js";

assertModelSeparation();

interface RawCase {
  topic: Topic;
  time_window: { start: string; end: string };
  items: Array<Pick<ContentItem, "id" | "source_id" | "url" | "title" | "published_at" | "language" | "topic_ids" | "body">>;
}

/** 数据集 item 缺 content_hash 等字段——按真实 contentHash 派生 + 默认补全成完整 ContentItem。 */
function hydrate(it: RawCase["items"][number]): ContentItem {
  return {
    ...it,
    author: null,
    fetched_at: `${it.published_at ?? "2026-01-01"}T00:00:00Z`,
    tags: [],
    body_kind: "article",
    raw_ref: "",
    content_hash: contentHash(it.body),
    fetch_status: "ok",
  };
}

interface Metrics {
  insights: number;
  multiSource: number; // 跨条综合（≥2 源）——增量最可能丢的
  reachPass: number; // 可达通过率
  consistOk: number; // 一致 support / 已评 率
  adopted: number; // ≥1 pass 引用的洞察数（报告里真可溯源）
}

function metrics(insights: Insight[], vr: ValidationResult): Metrics {
  const checks = vr.checks;
  const reachable = checks.filter((c) => c.reachability === "pass").length;
  const passByInsight = new Set(checks.filter((c) => c.verdict === "pass").map((c) => c.insight_id));
  return {
    insights: insights.length,
    multiSource: insights.filter((i) => i.multi_source).length,
    reachPass: checks.length ? reachable / checks.length : 1,
    consistOk: reachable ? checks.filter((c) => c.consistency === "support").length / reachable : 1,
    adopted: insights.filter((i) => passByInsight.has(i.id)).length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function runCase(raw: RawCase, idx: number): Promise<{ full: Metrics; inc: Metrics; hitItems: number; missItems: number }> {
  const topic = raw.topic;
  const window = raw.time_window;
  const items = raw.items.map(hydrate);
  // 按 published_at 排序，older 60% 当已缓存、newer 当新 item
  const sorted = [...items].sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
  const cut = Math.max(1, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.6)));
  const cached = sorted.slice(0, cut);
  const version = analyzerCacheVersion();
  const db = openDb(":memory:");

  process.stdout.write(`\n[case ${idx + 1}] ${topic.name}（${items.length} 条：缓存 ${cached.length} / 新 ${items.length - cached.length}）\n`);
  // seed：旧 item 在「无新 item 语境」下单独析 → 缓存
  process.stdout.write("  seed(cached)… ");
  const seed = await analyze(topic, cached, window);
  recordAnalysisCache(db, topic.id, cached, seed.insights, version);
  process.stdout.write(`${seed.insights.length} 洞察缓存\n`);

  // 全析
  process.stdout.write("  全析(all)… ");
  const full = await analyze(topic, items, window);
  const vrFull = await validateBatch(full.insights, items);
  process.stdout.write(`${full.insights.length} 洞察\n`);

  // 增量
  process.stdout.write("  增量(miss+复用)… ");
  const { hits, missItems } = lookupCachedInsights(db, topic.id, items, version);
  const inc = await analyze(topic, missItems, window);
  const instantiated = instantiateCachedInsights(hits, inc.id, [], inc.insights.length);
  inc.insights.push(...instantiated);
  inc.no_significant_event = inc.insights.length === 0;
  const vrInc = await validateBatch(inc.insights, items);
  process.stdout.write(`${inc.insights.length} 洞察（析 ${missItems.length} miss + 复用 ${hits.length}）\n`);
  db.close();

  return { full: metrics(full.insights, vrFull), inc: metrics(inc.insights, vrInc), hitItems: items.length - missItems.length, missItems: missItems.length };
}

async function main(): Promise<void> {
  const file = process.env.A1_QUALITY_FILE ?? "evals/dataset/insight-quality.jsonl";
  const cases = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RawCase);
  const limit = Number(process.env.INC_EVAL_CASES) || cases.length;
  console.log(`增量分析时序对照 eval — analyzer=${MODELS.analyzer} validator=${MODELS.validator}`);
  console.log(`数据集 ${file}：${cases.length} case，跑前 ${Math.min(limit, cases.length)} 个`);

  const agg = { full: { insights: 0, multiSource: 0, adopted: 0 }, inc: { insights: 0, multiSource: 0, adopted: 0 }, hit: 0, miss: 0 };
  const rows: Array<{ i: number; full: Metrics; inc: Metrics }> = [];
  for (let i = 0; i < Math.min(limit, cases.length); i++) {
    const r = await runCase(cases[i], i);
    rows.push({ i, full: r.full, inc: r.inc });
    agg.full.insights += r.full.insights; agg.full.multiSource += r.full.multiSource; agg.full.adopted += r.full.adopted;
    agg.inc.insights += r.inc.insights; agg.inc.multiSource += r.inc.multiSource; agg.inc.adopted += r.inc.adopted;
    agg.hit += r.hitItems; agg.miss += r.missItems;
  }

  console.log("\n========== 全析 vs 增量（聚合）==========");
  console.log(`命中复用 item ${agg.hit} / 重析 item ${agg.miss}（复用率 ${pct(agg.hit / (agg.hit + agg.miss))}）`);
  console.log(`洞察数:     全析 ${agg.full.insights}  →  增量 ${agg.inc.insights}   （保留 ${pct(agg.inc.insights / (agg.full.insights || 1))}）`);
  console.log(`多源(跨条): 全析 ${agg.full.multiSource}  →  增量 ${agg.inc.multiSource}   （跨条综合损失 = 增量最可能丢的）`);
  console.log(`被采纳:     全析 ${agg.full.adopted}  →  增量 ${agg.inc.adopted}   （≥1 pass 引用、报告可溯源）`);
  const lostMulti = agg.full.multiSource - agg.inc.multiSource;
  console.log(`\n判读：跨条综合净损失 ${lostMulti} 条多源洞察（${agg.full.multiSource ? pct(lostMulti / agg.full.multiSource) : "n/a"}）；`);
  console.log(`     洞察保留率 ${pct(agg.inc.insights / (agg.full.insights || 1))}。若保留率高 + 多源损失 ≤ ~4-10% → 增量质量等价、可上 2c；否则需周期全析兜底加密或上综合子 pass。`);
  const cost = getCostReport();
  console.log(`\n成本：$${cost.totalUSD.toFixed(3)}（${cost.byModel.map((m) => `${m.model}`).join(" + ")}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

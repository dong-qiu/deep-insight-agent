/**
 * 从本地 .data 抽取多源 QualityCase，写本地评测集（不入仓）。
 *
 * 默认用途仍是 M3-2 多源重测。若设 EVAL_REQUIRED_SOURCE_IDS，则成为 source cohort
 * 的严格构建器：每个指定源必须有足够正文、并实际进入至少一个输出 case，否则非零退出。
 * 这只证明真实采集→analyzer→validator 路径的覆盖；小于 A1 的 5-topic 下限时，不能据此签 DCP。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../src/lib/db/index.js";
import { listContentForTopic, listTopics } from "../src/lib/db/repos.js";
import { buildLocalEvalCases, missingRequiredSources, parseSourceIds } from "./build-local-eval-lib.js";

const DEFAULT_OUT = "evals/dataset/insight-quality-multisource.local.jsonl";

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

const out = process.env.EVAL_LOCAL_OUT ?? DEFAULT_OUT;
const manifestOut = process.env.EVAL_SOURCE_COHORT_MANIFEST;
const requiredSourceIds = parseSourceIds(process.env.EVAL_REQUIRED_SOURCE_IDS, "EVAL_REQUIRED_SOURCE_IDS");
const minBody = parsePositiveInt(process.env.EVAL_MIN_BODY, 800, "EVAL_MIN_BODY");
const perSource = parsePositiveInt(process.env.EVAL_PER_SOURCE, 2, "EVAL_PER_SOURCE");
const maxItems = parsePositiveInt(process.env.EVAL_MAX_ITEMS, 8, "EVAL_MAX_ITEMS");
// 默认 A1 仍须多源；单一 staged source 的隔离验证可用同源两条内容验证真实采集→引文链路。
const minimumSources = requiredSourceIds.length === 1 ? 1 : 2;

const db = getDb();
const now = Date.now();
const window = { start: new Date(now - 7 * 24 * 3600_000).toISOString(), end: new Date(now).toISOString() };
const result = buildLocalEvalCases(
  listTopics(db, { enabledOnly: true }),
  (topicId) => listContentForTopic(db, topicId, { limit: 2000 }),
  window,
  { minBody, perSource, maxItems, requiredSourceIds, minimumSources },
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, result.cases.length ? `${result.cases.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "");
for (const skipped of result.skipped) {
  console.log(`  ⚠️ ${skipped.topicId}：富内容不足（${skipped.items} 条 / ${skipped.sources} 源），跳过`);
}
for (const entry of result.cases) {
  const sourceIds = [...new Set(entry.items.map((item) => item.source_id))];
  console.log(`  ${entry.topic.id}：${entry.items.length} 条 / ${sourceIds.length} 源（${sourceIds.map((id) => id.replace("src_", "")).join(", ")}）`);
}

const manifest = {
  generated_at: new Date().toISOString(),
  output: out,
  options: { min_body: minBody, per_source: perSource, max_items: maxItems, minimum_sources: minimumSources, required_source_ids: requiredSourceIds },
  topics: result.cases.map((entry) => ({ topic_id: entry.topic.id, source_ids: [...new Set(entry.items.map((item) => item.source_id))], item_count: entry.items.length })),
  cohort: result.cohort,
};
if (manifestOut) {
  mkdirSync(dirname(manifestOut), { recursive: true });
  writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`\n已写 ${out}（${result.cases.length} 主题；本地、不入仓）。`);
if (requiredSourceIds.length) {
  const missing = missingRequiredSources(result);
  if (missing.length) {
    throw new Error(`source cohort 不完整：以下指定源没有进入任何评测 case：${missing.join(", ")}`);
  }
  console.log(`source cohort 已覆盖：${requiredSourceIds.join(", ")}`);
}
console.log(`评测：A1_QUALITY_FILE=${out} npm run eval:a1`);

/**
 * 从本地 .data 抽取**多源** QualityCase，写本地评测集（不入仓，见 .gitignore）。
 * 用途：M3-2 多源评测——验证 A1 在非 arXiv 异构内容下是否稳健，而**不把第三方全文提交进仓库**
 * （项目原则「不复制全文存储」；方案 B：本地快照不入仓，只提交指标/基线）。
 *
 * 配方（可复现）：先 `npm run seed` + 采集（或既有 .data），再 `npm run eval:build-local`，
 * 然后 `A1_QUALITY_FILE=evals/dataset/insight-quality-multisource.local.jsonl npm run eval:a1`。
 *
 * 选片：每主题取富正文（body ≥ MIN_BODY）条目，每源 ≤ PER_SOURCE、整体 ≤ MAX_ITEMS，保证来源多样。
 */
import { writeFileSync } from "node:fs";
import { getDb } from "../src/lib/db/index.js";
import { listContentForTopic, listTopics } from "../src/lib/db/repos.js";
import type { ContentItem } from "../src/lib/types.js";

const OUT = "evals/dataset/insight-quality-multisource.local.jsonl";
const MIN_BODY = 800;
const PER_SOURCE = 2;
const MAX_ITEMS = 8;

const db = getDb();
const now = Date.now();
const window = { start: new Date(now - 7 * 24 * 3600_000).toISOString(), end: new Date(now).toISOString() };
const lines: string[] = [];

for (const topic of listTopics(db, { enabledOnly: true })) {
  const pool = listContentForTopic(db, topic.id, { limit: 2000 }).filter((i) => i.body.length >= MIN_BODY);
  const perSource = new Map<string, number>();
  const items: ContentItem[] = [];
  for (const it of pool) {
    if (items.length >= MAX_ITEMS) break;
    const c = perSource.get(it.source_id) ?? 0;
    if (c >= PER_SOURCE) continue;
    perSource.set(it.source_id, c + 1);
    items.push(it);
  }
  if (items.length < 2 || perSource.size < 2) {
    console.log(`  ⚠️ ${topic.id}：多源富内容不足（${items.length} 条 / ${perSource.size} 源），跳过——先采集更多源`);
    continue;
  }
  lines.push(JSON.stringify({ topic, time_window: window, items }));
  console.log(`  ${topic.id}：${items.length} 条 / ${perSource.size} 源（${[...perSource.keys()].map((s) => s.replace("src_", "")).join(", ")}）`);
}

writeFileSync(OUT, lines.length ? `${lines.join("\n")}\n` : "");
console.log(`\n已写 ${OUT}（${lines.length} 主题；本地、不入仓）。`);
console.log(`评测：A1_QUALITY_FILE=${OUT} npm run eval:a1`);

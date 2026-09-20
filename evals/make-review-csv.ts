/**
 * 把 A1 跑批产出的 review-queue.json 转成 CSV 打分表（用 Excel/Sheets 打开，多人分工 + 自动算比例）。
 * 用法：npm run review:csv [输入 json] [输出 csv]
 *   默认 latest-complete run 的 review-queue.json → 同目录 review.csv
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompleteStatement } from "../src/lib/agents/analyzer.js";
import type { Insight } from "../src/lib/types.js";
import { latestReviewQueuePath } from "./review-artifact-paths.js";

const inPath = process.argv[2] ?? latestReviewQueuePath();
const outPath = process.argv[3] ?? join(dirname(inPath), "review.csv");

if (!existsSync(inPath)) {
  console.error(`找不到 ${inPath}，请先跑 npm run eval:a1`);
  process.exit(1);
}
const queue = JSON.parse(readFileSync(inPath, "utf8")) as { run_id?: string; generated_at: string; insights: Insight[] };
const insights = queue.insights;

if (process.argv[4]) {
  console.error("review:csv 只生成盲评表，不能传入 AI 预标注。请把 diagnostic_only 预标注与两位人工提交分开保存，并在人工提交冻结后再揭示。");
  process.exit(2);
}

/** Spreadsheet formula injection is a data-integrity problem: reader-facing source text must
 * remain literal even when an evaluator opens the CSV in Excel or Sheets. */
const literalCell = (v: string | number): string => {
  const value = String(v).replace(/\r?\n/g, " ");
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
};
const esc = (v: string | number): string => `"${literalCell(v).replace(/"/g, '""')}"`;

const headers = [
  "run_id", "queue_generated_at", "序号", "id", "主题", "类型", "重要性", "结论", "引用",
  "statement_citation_index", "statement_citation_claim",
  "可定位", "截断",
  "非显然(是/否)", "幻觉(有/无)", "importance合理(是/否)", "备注",
];
const rows = [headers.map(esc).join(",")];

insights.forEach((it, i) => {
  const quotes = it.citations.map((c) => `[${c.content_item_id}] ${c.quote}`).join("  ‖  ");
  const boundCitation = it.statement_citation_index == null ? undefined : it.citations[it.statement_citation_index - 1];
  const locatable = it.citations.every((c) => c.locator.char_start >= 0) ? "是" : "否";
  const truncated = isCompleteStatement(it.statement) ? "" : "是";
  rows.push(
    [
      queue.run_id ?? "legacy", queue.generated_at, i + 1, it.id, it.topic_id, it.type, it.importance,
      it.statement, quotes, it.statement_citation_index ?? "", boundCitation?.claim ?? "", locatable, truncated,
      "", "", "", "",
    ].map(esc).join(","),
  );
});

// 前置 BOM，便于 Excel 正确识别 UTF-8 中文
writeFileSync(outPath, `﻿${rows.join("\n")}\n`);
console.log(`已生成 ${outPath}（${insights.length} 行 + 表头）`);

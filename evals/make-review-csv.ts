/**
 * 把 A1 跑批产出的 review-queue.json 转成 CSV 打分表（用 Excel/Sheets 打开，多人分工 + 自动算比例）。
 * 用法：npm run review:csv [输入 json] [输出 csv]
 *   默认 evals/out/review-queue.json → evals/out/review.csv
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isCompleteStatement } from "../src/lib/agents/analyzer.js";
import type { Insight } from "../src/lib/types.js";

const inPath = process.argv[2] ?? "evals/out/review-queue.json";
const outPath = process.argv[3] ?? "evals/out/review.csv";

if (!existsSync(inPath)) {
  console.error(`找不到 ${inPath}，请先跑 npm run eval:a1`);
  process.exit(1);
}
const insights = (JSON.parse(readFileSync(inPath, "utf8")) as { insights: Insight[] }).insights;

const esc = (v: string | number): string =>
  `"${String(v).replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;

const headers = [
  "序号", "id", "主题", "类型", "重要性", "结论", "引用",
  "可定位", "截断",
  "非显然(是/否)", "幻觉(有/无)", "importance合理(是/否)", "备注",
];
const rows = [headers.map(esc).join(",")];

insights.forEach((it, i) => {
  const quotes = it.citations.map((c) => `[${c.content_item_id}] ${c.quote}`).join("  ‖  ");
  const locatable = it.citations.every((c) => c.locator.char_start >= 0) ? "是" : "否";
  const truncated = isCompleteStatement(it.statement) ? "" : "是";
  rows.push(
    [
      i + 1, it.id, it.topic_id, it.type, it.importance,
      it.statement, quotes, locatable, truncated,
      "", "", "", "",
    ].map(esc).join(","),
  );
});

// 前置 BOM，便于 Excel 正确识别 UTF-8 中文
writeFileSync(outPath, `﻿${rows.join("\n")}\n`);
console.log(`已生成 ${outPath}（${insights.length} 行 + 表头）`);

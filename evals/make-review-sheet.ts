/**
 * 把 A1 跑批产出的 review-queue.json 转成人评工作表（Markdown）。
 * 人评是 A1 真正的判定环节（非显然占比 / 幻觉率），脚本算不了，只能把门槛降到最低。
 *
 * 用法：npm run review:sheet [输入 json] [输出 md]
 *   默认 evals/out/review-queue.json → evals/out/review-sheet.md
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Insight } from "../src/lib/types.js";

const inPath = process.argv[2] ?? "evals/out/review-queue.json";
const outPath = process.argv[3] ?? "evals/out/review-sheet.md";

if (!existsSync(inPath)) {
  console.error(`找不到 ${inPath}，请先跑 npm run eval:a1`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(inPath, "utf8")) as {
  generated_at: string;
  insights: Insight[];
};
const insights = data.insights;

const L: string[] = [];
L.push("# A1 洞察人评工作表");
L.push("");
L.push(`> 来源：\`${inPath}\`（生成于 ${data.generated_at}）· 共 ${insights.length} 条洞察。`);
L.push("> 每条评两项：① **非显然**——是否不是套话/对原文的显而易见复述；");
L.push("> ② **幻觉/不可溯源**——结论是否超出引用所能支持的范围。");
L.push("> 目标线（eval-criteria）：非显然占比 ≥ 60%、幻觉率 ≤ 2%。建议由非生成者评、可双人交叉。");
L.push("");
L.push("## 汇总（评完回填）");
L.push("");
L.push(`- 非显然：___ / ${insights.length} = ___%（目标 ≥ 60%）`);
L.push(`- 含幻觉：___ / ${insights.length} = ___%（目标 ≤ 2%）`);
L.push("");
L.push("---");
L.push("");

insights.forEach((it, i) => {
  L.push(`### ${i + 1}. \`${it.id}\` · ${it.topic_id} · ${it.type} · 重要性 ${it.importance}`);
  L.push("");
  L.push(`**结论**：${it.statement}`);
  L.push("");
  L.push(`**重要性依据**：${it.importance_basis}`);
  L.push("");
  L.push(`**引用（${it.citations.length}）**：`);
  for (const c of it.citations) {
    const q = c.quote.length > 240 ? `${c.quote.slice(0, 240)}…` : c.quote;
    const loc = c.locator.char_start >= 0 ? "✓可定位" : "✗未定位";
    L.push(`- \`${c.content_item_id}\` [${loc}] “${q}”`);
  }
  L.push("");
  L.push("**评审**：非显然 ☐是 ☐否　|　幻觉/不可溯源 ☐有 ☐无　|　importance 合理 ☐是 ☐否");
  L.push("备注：");
  L.push("");
  L.push("---");
  L.push("");
});

writeFileSync(outPath, L.join("\n"));
console.log(`已生成 ${outPath}（${insights.length} 条洞察）`);

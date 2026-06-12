/** 实跑追问管线（dogfood）：对真实库里的一份报告提问，打印可溯源回答。
 *  用法：tsx evals/run-followup.ts <reportId> "<question>"
 *  env 从 .env.local 读（relay key + DB_PATH 钉真实库）；llm client 懒加载，故 import 早于 env 注入无碍。 */
import { existsSync, readFileSync } from "node:fs";
import { answerFollowup } from "../src/lib/agents/followup.js";
import { getDb } from "../src/lib/db/index.js";
import { getReport } from "../src/lib/db/reports.js";

function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const reportId = process.argv[2];
  const question = process.argv[3];
  if (!reportId || !question) {
    console.error('用法：tsx evals/run-followup.ts <reportId> "<question>"');
    process.exit(1);
  }
  const db = getDb();
  const report = getReport(db, reportId);
  if (!report) throw new Error(`报告不存在：${reportId}`);

  console.log(`\n📄 报告：${report.title}`);
  console.log(`   洞察 ${report.insight_ids.length} 条 · 模型 followup=${process.env.FOLLOWUP_MODEL} / validator=${process.env.VALIDATOR_MODEL}`);
  console.log(`\n❓ 问：${question}\n`);
  const t0 = Date.now();
  const r = await answerFollowup(db, report, question);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("─".repeat(70));
  console.log(r.answer_md);
  console.log("─".repeat(70));
  console.log(`\nanswerable=${r.answerable} · 耗时 ${secs}s`);
  console.log(`校验：total=${r.validation.total} reachable=${r.validation.reachable} consistent=${r.validation.consistent} blocked=${r.validation.blocked} errored=${r.validation.errored}`);
  console.log(`引用 ${r.citations_used.length} 条 · 成本 $${r.cost.amount.toFixed(4)}（${r.cost.tokens} tokens）`);
}

main().catch((e) => {
  console.error("❌ 失败：", (e as Error).message);
  process.exit(1);
});

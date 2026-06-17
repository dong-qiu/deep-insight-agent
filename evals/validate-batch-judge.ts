/**
 * 批量一致性判定精度验证（PR #51 上线前门）：把 citation-consistency 标注集（120 例 / 60 负例）
 * 同时跑【单条 judgeConsistency】与【按源归并 judgeConsistencyBatch】，逐例对比 verdict。
 *
 * 安全门：批量的负例召回率（not_support 召回）不得低于单条；尤其任何 label=not_support 被批量判成
 * 非 not_support（漏网）都要单列。批量只在"同源多 claim"时与单条有别（本集 30 源被 ≥2 claim 共享）。
 *
 * 用法：tsx evals/validate-batch-judge.ts（需 .env.local 的 ANTHROPIC_API_KEY/BASE_URL）。一次性脚本。
 */
import { existsSync, readFileSync } from "node:fs";
import { judgeBatchWithRetry, judgeWithRetry } from "../src/lib/agents/validator.js";
import { assertModelSeparation, getCostReport, MODELS } from "../src/lib/runtime/llm.js";
import type { ConsistencyJudge } from "../src/lib/types.js";

function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as T);
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface Case { statement: string; source_text: string; expected_consistency: "support" | "not_support" | "uncertain"; negative_type?: string }
type V = ConsistencyJudge["consistency"] | "error";

async function mapPool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    for (let i = idx++; i < items.length; i = idx++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function metrics(verdicts: V[], cases: Case[]): { acc: number; negRecall: number; negTotal: number; negMissed: number[]; errors: number } {
  let correct = 0, negRecalled = 0, negTotal = 0, errors = 0;
  const negMissed: number[] = [];
  verdicts.forEach((v, i) => {
    if (v === "error") errors++;
    if (v === cases[i].expected_consistency) correct++;
    if (cases[i].expected_consistency === "not_support") {
      negTotal++;
      if (v === "not_support") negRecalled++;
      else negMissed.push(i); // 漏网负例（含 error）
    }
  });
  return { acc: correct / cases.length, negRecall: negTotal ? negRecalled / negTotal : 1, negTotal, negMissed, errors };
}

async function main(): Promise<void> {
  loadEnvLocal();
  assertModelSeparation();
  const CONC = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 6));
  const cases = readJsonl<Case>("evals/dataset/citation-consistency.jsonl");
  console.log(`validator=${MODELS.validator} · thinking=${process.env.VALIDATOR_THINKING !== "0" ? "on" : "off"} · 并发=${CONC}`);
  console.log(`样本：${cases.length} 例（负例 ${cases.filter((c) => c.expected_consistency === "not_support").length}）\n`);

  // ── 单条基线：每例 judgeConsistency ──
  console.log("跑单条判定（基线）...");
  const single = await mapPool(cases, CONC, async (c): Promise<V> => {
    try { return (await judgeWithRetry(c.statement, c.source_text)).consistency; } catch { return "error"; }
  });

  // ── 批量：按 source_text 归并，同源 ≥2 claim 走 judgeConsistencyBatch，单条仍 judgeConsistency ──
  console.log("跑批量判定（按源归并）...");
  const groups = new Map<string, number[]>(); // source_text → 全局 case 下标
  cases.forEach((c, i) => { if (!groups.has(c.source_text)) groups.set(c.source_text, []); groups.get(c.source_text)!.push(i); });
  const groupList = [...groups.values()];
  const batched = new Array<V>(cases.length);
  const batchGroupSizes: number[] = [];
  await mapPool(groupList, CONC, async (idxs) => {
    if (idxs.length === 1) {
      const i = idxs[0];
      try { batched[i] = (await judgeWithRetry(cases[i].statement, cases[i].source_text)).consistency; } catch { batched[i] = "error"; }
      return;
    }
    batchGroupSizes.push(idxs.length);
    const stmts = idxs.map((i) => cases[i].statement);
    try {
      const res = await judgeBatchWithRetry(stmts, cases[idxs[0]].source_text);
      idxs.forEach((i, k) => { batched[i] = res[k].consistency; });
    } catch {
      idxs.forEach((i) => { batched[i] = "error"; });
    }
  });

  // ── 指标 + 对比 ──
  const mS = metrics(single, cases);
  const mB = metrics(batched, cases);
  const sharedSources = groupList.filter((g) => g.length > 1).length;
  const inBatch = groupList.filter((g) => g.length > 1).reduce((s, g) => s + g.length, 0);

  console.log(`\n批量触发：${sharedSources} 个源被归并（覆盖 ${inBatch} 例；批量组大小 ${batchGroupSizes.sort((a, b) => a - b).join("/")}）`);
  console.log("\n指标         单条(基线)    批量        baseline.json");
  console.log(`三分类准确率  ${pct(mS.acc).padEnd(12)}${pct(mB.acc).padEnd(12)}0.821`);
  console.log(`负例召回率    ${pct(mS.negRecall).padEnd(12)}${pct(mB.negRecall).padEnd(12)}1.0  ← 安全门 ≥95%`);
  console.log(`调用失败      ${String(mS.errors).padEnd(12)}${String(mB.errors)}`);

  // 逐例分歧
  const disagree = cases.map((_, i) => i).filter((i) => single[i] !== batched[i]);
  console.log(`\n单条 vs 批量 分歧：${disagree.length}/${cases.length}`);
  for (const i of disagree) {
    console.log(`  [#${i}] label=${cases[i].expected_consistency} 单条=${single[i]} 批量=${batched[i]}  「${cases[i].statement.slice(0, 42)}…」`);
  }

  // 安全：批量漏掉的负例（label=not_support 但批量≠not_support）
  console.log(`\n🔒 安全门：批量漏网负例 ${mB.negMissed.length} 条（单条漏网 ${mS.negMissed.length} 条）`);
  const newMiss = mB.negMissed.filter((i) => !mS.negMissed.includes(i)); // 批量独有的漏网（回归）
  if (newMiss.length) {
    console.log(`  ⚠️ 批量【新增】漏网负例 ${newMiss.length} 条（单条能挡、批量漏）——精度回归：`);
    for (const i of newMiss) console.log(`    [#${i}] 批量=${batched[i]}  「${cases[i].statement.slice(0, 50)}…」\n      源：${cases[i].source_text.slice(0, 90)}…`);
  } else {
    console.log("  ✅ 批量未新增任何漏网负例（不弱于单条）");
  }

  const cost = getCostReport();
  console.log(`\n成本：$${cost.totalUSD.toFixed(4)}（单条 120 + 批量 ${groupList.length} 调用）`);

  // 判定
  const safe = mB.negRecall >= 0.95 && newMiss.length === 0;
  console.log(`\n结论：${safe ? "✅ 批量精度不弱于单条、负例召回守住 → 可上线" : "❌ 批量出现精度回归 → 暂不上线，排查"}`);
  process.exit(safe ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

/**
 * A1 验证实跑 —— charter 关键假设 A1 / insight-analysis AC10 / DCP-1→M2 硬门槛。
 *
 * 跑端到端切片：ContentItem[] → analyzer → Insight[] → validator → 指标，
 * 对照 `docs/verify/eval-criteria.md` 上线门槛打 PASS/FAIL。
 *
 * 用法：`npm run eval:a1`（需 .env.local 里的 ANTHROPIC_API_KEY）
 *
 * 自动可测指标：引用可达性 / 一致性合格率 / 失败率 / flagged 率 / 校验器准召。
 * 人工指标（非显然占比、幻觉率）：脚本导出 evals/out/review-queue.json 供人评。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { analyze, coverageGaps, specificClaims } from "../src/lib/agents/analyzer.js";
import { judgeConsistency, validateBatch } from "../src/lib/agents/validator.js";
import { MODELS, assertModelSeparation, getCostReport } from "../src/lib/runtime/llm.js";
import type { CitationCheck, ContentItem, Insight, Topic } from "../src/lib/types.js";

// ── eval-criteria.md 上线门槛（镜像；改阈值请同步那份文档） ──
const THRESHOLDS = {
  reachabilityPass: 1.0, // 引用可达性通过率 = 100%
  consistencyOk: 0.95, // 引用一致性合格率 ≥ 95%
  consistencyFailure: 0.05, // 一致性失败率 ≤ 5%
  flagged: 0.1, // flagged 率 ≤ 10%
  judgeAccuracy: 0.9, // 校验器三分类准确率 ≥ 90%
  judgeNegRecall: 0.95, // 校验器负例召回率 ≥ 95%
};
// eval-criteria 评测集规模下限（低于则结论仅供管线验证，不作 DCP 判定依据）
const MIN_TOPICS = 5;
const MIN_CONSISTENCY_PAIRS = 100;

interface QualityCase {
  topic: Topic;
  items: ContentItem[];
  time_window: { start: string; end: string };
}
interface ConsistencyCase {
  statement: string;
  source_text: string;
  expected_consistency: "support" | "not_support" | "uncertain";
  negative_type?: string;
}

function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface MetricRow {
  key: string; // 对齐 baseline.json auto_metrics 键（回归对照用）
  name: string;
  value: number;
  threshold: number;
  op: ">=" | "<=";
  pass: boolean;
}
function metric(key: string, name: string, value: number, threshold: number, op: ">=" | "<="): MetricRow {
  const pass = op === ">=" ? value >= threshold : value <= threshold;
  return { key, name, value, threshold, op, pass };
}

function printMetrics(rows: MetricRow[]): void {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log("\n指标".padEnd(w) + "   实测      门槛       结果");
  console.log("─".repeat(w + 34));
  for (const r of rows) {
    console.log(
      r.name.padEnd(w) +
        "   " +
        pct(r.value).padStart(7) +
        "   " +
        `${r.op} ${pct(r.threshold)}`.padStart(9) +
        "    " +
        (r.pass ? "✅ PASS" : "❌ FAIL"),
    );
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "缺少 ANTHROPIC_API_KEY。\n" +
        "  1) cp .env.example .env.local 并填入真实 key，或\n" +
        "  2) ANTHROPIC_API_KEY=sk-ant-... npm run eval:a1",
    );
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
    console.warn(
      "⚠️ ANTHROPIC_API_KEY 不以 'sk-ant-' 开头，可能不是有效的 Anthropic key" +
        "（Anthropic key 形如 sk-ant-api03-...）。若实跑报 401/403，请先核对 key。\n",
    );
  }
  assertModelSeparation();
  console.log(`A1 验证实跑\n模型：分析=${MODELS.analyzer} / 校验=${MODELS.validator}\n`);

  // 子集冒烟开关：A1_QUALITY_LIMIT / A1_CONSISTENCY_LIMIT 限制跑多少条（廉价验证链路+成本）
  const qLimit = Number(process.env.A1_QUALITY_LIMIT) || 0;
  const cLimit = Number(process.env.A1_CONSISTENCY_LIMIT) || 0;
  const smoke = qLimit > 0 || cLimit > 0;

  // ── Part A：洞察提炼 + 引用双层校验 ──
  // A1_QUALITY_FILE 可指向本地多源集（evals/dataset/*.local.jsonl，不入仓）；默认 arXiv 集
  const qualityFile = process.env.A1_QUALITY_FILE ?? "evals/dataset/insight-quality.jsonl";
  const qualityAll = readJsonl<QualityCase>(qualityFile);
  const qualityCases = qLimit ? qualityAll.slice(0, qLimit) : qualityAll;
  if (smoke) {
    console.log(
      `⚠️ 子集冒烟模式：主题 ${qualityCases.length}/${qualityAll.length}` +
        (cLimit ? `、一致性对上限 ${cLimit}` : "") +
        " —— 仅验证真模型链路与成本，不代表 A1 结论。\n",
    );
  }
  const allChecks: CitationCheck[] = [];
  const allInsights: Insight[] = [];
  for (const c of qualityCases) {
    process.stdout.write(`[分析] 主题「${c.topic.name}」… `);
    try {
      const batch = await analyze(c.topic, c.items, c.time_window);
      const vr = await validateBatch(batch.insights, c.items);
      allInsights.push(...batch.insights);
      allChecks.push(...vr.checks);
      console.log(`${batch.insights.length} 洞察 / ${vr.checks.length} 引用校验`);
    } catch (e) {
      console.log(`失败，跳过该主题（${(e as Error).message}）`);
    }
  }

  // ── Part B：校验器一致性准召（标注集） ──
  const consistencyAll = readJsonl<ConsistencyCase>("evals/dataset/citation-consistency.jsonl");
  const consistencyCases = cLimit ? consistencyAll.slice(0, cLimit) : consistencyAll;
  let judged = 0;
  let judgeCorrect = 0;
  let judgeErrors = 0;
  let negTotal = 0;
  let negRecalled = 0;
  process.stdout.write(`[校验器准召] ${consistencyCases.length} 组标注对… `);
  for (const c of consistencyCases) {
    let j: Awaited<ReturnType<typeof judgeConsistency>>;
    try {
      j = await judgeConsistency(c.statement, c.source_text);
    } catch {
      judgeErrors++;
      continue;
    }
    judged++;
    if (j.consistency === c.expected_consistency) judgeCorrect++;
    if (c.expected_consistency === "not_support") {
      negTotal++;
      if (j.consistency === "not_support") negRecalled++;
    }
  }
  console.log(`done（成功 ${judged}/${consistencyCases.length}${judgeErrors ? `，跳过 ${judgeErrors}` : ""}）`);

  // ── 指标 ──
  const total = allChecks.length;
  const reachPass = allChecks.filter((c) => c.reachability === "pass").length;
  const support = allChecks.filter((c) => c.consistency === "support").length;
  const notSupport = allChecks.filter((c) => c.consistency === "not_support").length;
  const uncertain = allChecks.filter((c) => c.consistency === "uncertain").length;

  const rows = [
    metric("reachability_pass", "引用可达性通过率", total ? reachPass / total : 0, THRESHOLDS.reachabilityPass, ">="),
    metric("consistency_ok", "引用一致性合格率", total ? support / total : 0, THRESHOLDS.consistencyOk, ">="),
    metric("consistency_failure", "一致性失败率(护栏)", total ? notSupport / total : 0, THRESHOLDS.consistencyFailure, "<="),
    metric("flagged_rate", "flagged率(第二护栏)", total ? uncertain / total : 0, THRESHOLDS.flagged, "<="),
    metric("judge_accuracy", "校验器三分类准确率", judged ? judgeCorrect / judged : 0, THRESHOLDS.judgeAccuracy, ">="),
    metric("judge_neg_recall", "校验器负例召回率", negTotal ? negRecalled / negTotal : 0, THRESHOLDS.judgeNegRecall, ">="),
  ];
  printMetrics(rows);

  // ── 覆盖度（第三层校验，informational）：结论里的具体声明（数字/实体）被引用直接覆盖的比例。
  // 统计 analyzer 产出层（用 it.citations 全量、不剔 blocked，与渲染层 〔待补引〕 口径不同）；
  // 非硬门（暂无基线/阈值），量化「可溯源覆盖度」现状缺口。 ──
  let claimsTotal = 0;
  let claimsCovered = 0;
  for (const it of allInsights) {
    const ents = (it.entities ?? []).map((e) => e.name);
    const quotes = it.citations.map((c) => c.quote);
    const all = specificClaims(it.statement, ents).length;
    const gaps = coverageGaps(it.statement, ents, quotes).length;
    claimsTotal += all;
    claimsCovered += all - gaps;
  }
  const coverageRatio = claimsTotal ? claimsCovered / claimsTotal : 1;
  console.log(
    `\n引用覆盖度（informational）：具体声明 ${claimsCovered}/${claimsTotal} 被引用直接覆盖 = ${pct(coverageRatio)}` +
      `（数字+实体，按 analyzer 产出 quote 直接覆盖；缺口由 report-gen 在渲染层外露 〔待补引〕）`,
  );

  // ── 成本（估算，A5 成本可控） ──
  const cost = getCostReport();
  console.log("\n本次运行成本（估算）：");
  for (const m of cost.byModel) {
    const cache = m.cacheRead || m.cacheWrite ? ` · cache r/w ${m.cacheRead}/${m.cacheWrite}` : "";
    console.log(
      `  ${m.model}：${m.calls} 次调用 · in ${m.input} / out ${m.output} tok${cache}` +
        ` → $${m.usd.toFixed(4)}${m.unpriced ? "（含未计价模型）" : ""}`,
    );
  }
  console.log(
    `  合计：$${cost.totalUSD.toFixed(4)}` +
      (total ? ` · 每引用校验 $${(cost.totalUSD / total).toFixed(5)}` : ""),
  );

  // ── 人工指标：导出 review queue（非显然占比、幻觉率需人评） ──
  mkdirSync("evals/out", { recursive: true });
  writeFileSync(
    "evals/out/review-queue.json",
    JSON.stringify({ generated_at: new Date().toISOString(), insights: allInsights }, null, 2),
  );
  console.log(
    "\n人工指标（脚本无法自动算）：\n" +
      "  · 非显然洞察占比 ≥ 60%、幻觉率 ≤ 2%\n" +
      "  → 见 evals/out/review-queue.json，逐条人评后回填。",
  );

  // ── 样本量提示 ──
  if (smoke) {
    console.log(
      `\n⚠️ 子集冒烟：仅跑了主题 ${qualityCases.length}/${qualityAll.length}、一致性对 ${consistencyCases.length}/${consistencyAll.length}。\n` +
        "   结果仅用于验证真模型链路 + 标定成本，不作 A1 / DCP 判定依据。去掉 A1_*_LIMIT 跑全量才出结论。",
    );
  } else if (qualityAll.length < MIN_TOPICS || consistencyAll.length < MIN_CONSISTENCY_PAIRS) {
    console.log(
      `\n⚠️ 样本量低于 eval-criteria 规模（主题 ${qualityAll.length}/${MIN_TOPICS}，` +
        `一致性对 ${consistencyAll.length}/${MIN_CONSISTENCY_PAIRS}）。\n` +
        "   当前结论仅验证管线打通，不作 DCP 判定依据。请用真实采集数据扩充数据集后重跑。",
    );
  }

  // ── 回归门（eval-criteria：任一指标较基线降 >3pp 告警/阻断）。基线 = arXiv 标准集 ──
  let regressed = false;
  try {
    const base = (JSON.parse(readFileSync("evals/baseline.json", "utf8")).auto_metrics ?? {}) as Record<string, number>;
    const TOL = 0.03;
    console.log("\n回归对照（vs baseline.json · arXiv 基线）：");
    for (const r of rows) {
      const b = base[r.key];
      if (typeof b !== "number") continue;
      const delta = r.value - b;
      const isReg = r.op === ">=" ? delta < -TOL : delta > TOL; // 升降方向按 op
      if (isReg) regressed = true;
      console.log(
        `  ${r.name.padEnd(18)} ${pct(b)} → ${pct(r.value)}（Δ${delta >= 0 ? "+" : ""}${pct(delta)}）${isReg ? " ⚠️ 回归" : ""}`,
      );
    }
    if (regressed) {
      console.log(
        "  ⚠️ 检测到 >3pp 回归。单次跑有非确定性噪声——标准 arXiv 全量跑下视为阻断；非标准数据集/冒烟仅供参考。",
      );
    }
  } catch {
    console.log("\n（无 baseline.json，跳过回归对照）");
  }

  const failed = rows.filter((r) => !r.pass);
  console.log(`\n自动门槛：${rows.length - failed.length}/${rows.length} 通过。`);
  // 阈值 FAIL 或（全量非冒烟下的）>3pp 回归 → 非零退出（带 key 的 job/CI 可据此阻断合并）
  process.exit(failed.length || (regressed && !smoke) ? 1 : 0);
}

main().catch((err) => {
  console.error("A1 验证运行出错：", err);
  process.exit(1);
});

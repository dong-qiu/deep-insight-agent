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
 *
 * ── 分形态（stratum）评测（ADR-0007 B2 前置）──
 * 数据集每条可带 `stratum`（缺省 `arxiv`）。指标**按 stratum 分组**算、各比各的基线，避免
 * 「转写口语体压低书面体基线」的假告警。reframe（红线=上报可溯源、由 validator blocking 守住）：
 *  - arxiv：可达率 100% 仍为硬门（书面体下 ≈ shipped 可达，历史口径不变）。
 *  - transcript：跨段漂移残差被 blocked、不上报 → **可达率降为信息量指标（不计 FAIL）**，
 *    改用 `yield`（=1-blocked 占比）作硬门（防"挡到没产出"）；一致性 95% / flagged 10% 照旧硬守。
 * 仅含 arxiv 数据时（当前默认数据集），行为与分形态前一致——arxiv 那组的门槛/退出码逐项不变。
 */
import "./load-env.js"; // 必须最先 import：载 .env.local，早于 MODELS（llm.ts 模块加载时求值）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { analyze, coverageGaps, specificClaims } from "../src/lib/agents/analyzer.js";
import { judgeConsistency, validateBatch } from "../src/lib/agents/validator.js";
import { MODELS, assertModelSeparation, getCostReport } from "../src/lib/runtime/llm.js";
import { validatorBatchOn, validatorThinking } from "../src/lib/runtime/env.js";
import type { CitationCheck, ContentItem, Insight, Topic } from "../src/lib/types.js";

type Stratum = "arxiv" | "transcript";
const STRATA: Stratum[] = ["arxiv", "transcript"];

interface Thresholds {
  reachabilityPass: number;
  reachabilityOp: ">=" | "info"; // info = 非硬门（仅信息量，恒 PASS）
  consistencyOk: number;
  consistencyFailure: number;
  flagged: number;
  judgeAccuracy: number;
  judgeNegRecall: number;
  yieldMin?: number; // 仅 transcript：上报 yield（1-blocked 占比）下限
}

// ── eval-criteria.md 上线门槛（镜像；改阈值请同步那份文档） ──
const THRESHOLDS_BY_STRATUM: Record<Stratum, Thresholds> = {
  // arxiv：历史硬门，逐项不变。
  arxiv: {
    reachabilityPass: 1.0, // 引用可达性通过率 = 100%（可溯源底线）
    reachabilityOp: ">=",
    consistencyOk: 0.95, // 引用一致性合格率 ≥ 95%
    consistencyFailure: 0.05, // 一致性失败率 ≤ 5%
    flagged: 0.1, // flagged 率 ≤ 10%
    judgeAccuracy: 0.9, // 校验器三分类准确率 ≥ 90%
    judgeNegRecall: 0.95, // 校验器负例召回率 ≥ 95%
  },
  // transcript：可达率转信息量（红线由 blocking 守，见文件头 reframe），加 yield 硬门。
  transcript: {
    reachabilityPass: 1.0, // 仍打印对照，但 op=info 不计 FAIL
    reachabilityOp: "info",
    consistencyOk: 0.95,
    consistencyFailure: 0.05,
    flagged: 0.1,
    judgeAccuracy: 0.9,
    judgeNegRecall: 0.95,
    yieldMin: 0.7, // 上报 yield ≥ 70%（暂定，真实转写跑批后标定）
  },
};
// eval-criteria 评测集规模下限（低于则结论仅供管线验证，不作 DCP 判定依据）
const MIN_TOPICS = 5;
const MIN_CONSISTENCY_PAIRS = 100;

interface QualityCase {
  topic: Topic;
  items: ContentItem[];
  time_window: { start: string; end: string };
  stratum?: Stratum; // 缺省 arxiv
}
interface ConsistencyCase {
  statement: string;
  source_text: string;
  expected_consistency: "support" | "not_support" | "uncertain";
  negative_type?: string;
  stratum?: Stratum; // 缺省 arxiv
}

interface JudgeStats {
  judged: number;
  correct: number;
  errors: number;
  negTotal: number;
  negRecalled: number;
}

type ConsistencyLabel = ConsistencyCase["expected_consistency"];
type ConfusionMatrix = Record<ConsistencyLabel, Record<ConsistencyLabel, number>>;

interface EvalConfig {
  analyzer_model: string;
  validator_model: string;
  validator_thinking: boolean;
  validator_batch: boolean;
  quality_dataset_sha256: string;
  consistency_dataset_sha256: string;
}

const EVAL_CONFIG_KEYS: Array<keyof EvalConfig> = [
  "analyzer_model",
  "validator_model",
  "validator_thinking",
  "validator_batch",
  "quality_dataset_sha256",
  "consistency_dataset_sha256",
];

interface QualityEvidence {
  case_index: number;
  topic_id: string;
  topic_name: string;
  stratum: Stratum;
  insight_count: number;
  checks: CitationCheck[];
}

interface JudgeEvidence {
  case_index: number;
  stratum: Stratum;
  expected: ConsistencyLabel;
  predicted: ConsistencyLabel | null;
  rationale: string | null;
  error: string | null;
}

function emptyMatrix(): ConfusionMatrix {
  return {
    support: { support: 0, not_support: 0, uncertain: 0 },
    not_support: { support: 0, not_support: 0, uncertain: 0 },
    uncertain: { support: 0, not_support: 0, uncertain: 0 },
  };
}

function datasetDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentEvalConfig(qualityFile: string, consistencyFile: string): EvalConfig {
  return {
    analyzer_model: MODELS.analyzer,
    validator_model: MODELS.validator,
    validator_thinking: validatorThinking(),
    validator_batch: validatorBatchOn(),
    quality_dataset_sha256: datasetDigest(qualityFile),
    consistency_dataset_sha256: datasetDigest(consistencyFile),
  };
}

function parseLimit(raw: string | undefined, name: string): number {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 必须是非负整数（0=全量）`);
  return n;
}

function sameEvalConfig(baseline: Record<string, unknown>, current: EvalConfig): boolean {
  return EVAL_CONFIG_KEYS.every((key) => baseline[key] === current[key]);
}

function emptyJudgeStats(): JudgeStats {
  return { judged: 0, correct: 0, errors: 0, negTotal: 0, negRecalled: 0 };
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
  key: string; // 对齐 baseline.json 各 stratum 段的键（回归对照用）
  name: string;
  value: number;
  threshold: number;
  op: ">=" | "<=" | "info";
  pass: boolean;
  /** raw_pipeline=analyzer 原始输出；validator_classifier=固定标注集；publish_safety=发布层。 */
  scope: "raw_pipeline" | "validator_classifier" | "publish_safety";
}
function metric(
  key: string,
  name: string,
  value: number,
  threshold: number,
  op: ">=" | "<=" | "info",
  scope: MetricRow["scope"],
): MetricRow {
  const pass = op === "info" ? true : op === ">=" ? value >= threshold : value <= threshold;
  return { key, name, value, threshold, op, pass, scope };
}

/** 一个 stratum 的全部自动指标行（含可达率/一致性/flagged/准召；transcript 另加 yield）。 */
function stratumRows(stratum: Stratum, checks: CitationCheck[], judge: JudgeStats): MetricRow[] {
  const t = THRESHOLDS_BY_STRATUM[stratum];
  const total = checks.length;
  const reachPass = checks.filter((c) => c.reachability === "pass").length;
  const support = checks.filter((c) => c.consistency === "support").length;
  const notSupport = checks.filter((c) => c.consistency === "not_support").length;
  const uncertain = checks.filter((c) => c.consistency === "uncertain").length;
  const blocked = checks.filter((c) => c.verdict === "blocked").length; // reachability=fail 短路（见 CitationCheck 注释）

  const rows: MetricRow[] = [
    metric("reachability_pass", "引用可达性通过率", total ? reachPass / total : 0, t.reachabilityPass, t.reachabilityOp, "raw_pipeline"),
    metric("consistency_ok", "引用一致性合格率", total ? support / total : 0, t.consistencyOk, ">=", "raw_pipeline"),
    metric("consistency_failure", "一致性失败率(护栏)", total ? notSupport / total : 0, t.consistencyFailure, "<=", "raw_pipeline"),
    metric("flagged_rate", "flagged率(第二护栏)", total ? uncertain / total : 0, t.flagged, "<=", "raw_pipeline"),
    metric("judge_accuracy", "校验器三分类准确率", judge.judged ? judge.correct / judge.judged : 0, t.judgeAccuracy, ">=", "validator_classifier"),
    metric("judge_neg_recall", "校验器负例召回率", judge.negTotal ? judge.negRecalled / judge.negTotal : 0, t.judgeNegRecall, ">=", "validator_classifier"),
  ];
  // transcript：yield = 上报引用 / 原始引用 = 1 - blocked 占比（量"漂移挡掉多少产出"，防挡到没产出）。
  if (t.yieldMin != null) {
    rows.push(metric("yield", "上报yield(1-blocked)", total ? (total - blocked) / total : 1, t.yieldMin, ">=", "publish_safety"));
  }
  return rows;
}

function printMetrics(stratum: Stratum, rows: MetricRow[]): void {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`\n── 形态：${stratum} ──`);
  console.log("指标".padEnd(w) + "   实测      门槛       结果");
  console.log("─".repeat(w + 34));
  for (const r of rows) {
    const gate = r.op === "info" ? "（信息量）" : `${r.op} ${pct(r.threshold)}`;
    const verdict = r.op === "info" ? "ℹ️ INFO" : r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(r.name.padEnd(w) + "   " + pct(r.value).padStart(7) + "   " + gate.padStart(9) + "    " + verdict);
  }
}

async function main(): Promise<void> {
  // .env.local 已由顶部 `import "./load-env.js"` 在 MODELS 求值前载入（见该模块注释）。
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
  // 子集冒烟开关：A1_QUALITY_LIMIT / A1_CONSISTENCY_LIMIT 限制跑多少条（廉价验证链路+成本）
  const qLimit = parseLimit(process.env.A1_QUALITY_LIMIT, "A1_QUALITY_LIMIT");
  const cLimit = parseLimit(process.env.A1_CONSISTENCY_LIMIT, "A1_CONSISTENCY_LIMIT");

  // ── Part A：洞察提炼 + 引用双层校验（按 stratum 分组收集） ──
  // A1_QUALITY_FILE 可指向本地多源集（evals/dataset/*.local.jsonl，不入仓）；默认 arXiv 集
  const qualityFile = process.env.A1_QUALITY_FILE ?? "evals/dataset/insight-quality.jsonl";
  const qualityAll = readJsonl<QualityCase>(qualityFile);
  const qualityCases = qLimit ? qualityAll.slice(0, qLimit) : qualityAll;
  // A1_CONSISTENCY_FILE 可指向分形态集（如 transcript 专集），默认 arXiv 标注集。
  const consistencyFile = process.env.A1_CONSISTENCY_FILE ?? "evals/dataset/citation-consistency.jsonl";
  const consistencyAll = readJsonl<ConsistencyCase>(consistencyFile);
  const consistencyCases = cLimit ? consistencyAll.slice(0, cLimit) : consistencyAll;
  // 仅实际缩小样本时才是冒烟；上限大于数据集不能悄悄绕过全量质量门。
  const smoke = qualityCases.length < qualityAll.length || consistencyCases.length < consistencyAll.length;
  const evalConfig = currentEvalConfig(qualityFile, consistencyFile);
  console.log(
    `A1 验证实跑\n模型：分析=${MODELS.analyzer} / 校验=${MODELS.validator}` +
      `\n配置：thinking=${evalConfig.validator_thinking ? "on" : "off"} / batch=${evalConfig.validator_batch ? "on" : "off"}\n`,
  );
  if (smoke) {
    console.log(
      `⚠️ 子集冒烟模式：主题 ${qualityCases.length}/${qualityAll.length}` +
        (cLimit ? `、一致性对上限 ${cLimit}` : "") +
        " —— 仅验证真模型链路与成本，不代表 A1 结论。\n",
    );
  }
  const checksByStratum: Record<Stratum, CitationCheck[]> = { arxiv: [], transcript: [] };
  const insightsByStratum: Record<Stratum, Insight[]> = { arxiv: [], transcript: [] };
  const qualityEvidence: Array<QualityEvidence & { error?: string }> = [];
  let qualitySucceeded = 0;
  for (const [caseIndex, c] of qualityCases.entries()) {
    const stratum: Stratum = c.stratum ?? "arxiv";
    process.stdout.write(`[分析] 主题「${c.topic.name}」(${stratum})… `);
    try {
      const batch = await analyze(c.topic, c.items, c.time_window);
      const vr = await validateBatch(batch.insights, c.items);
      insightsByStratum[stratum].push(...batch.insights);
      checksByStratum[stratum].push(...vr.checks);
      qualitySucceeded++;
      qualityEvidence.push({
        case_index: caseIndex,
        topic_id: c.topic.id,
        topic_name: c.topic.name,
        stratum,
        insight_count: batch.insights.length,
        checks: vr.checks,
      });
      console.log(`${batch.insights.length} 洞察 / ${vr.checks.length} 引用校验`);
    } catch (e) {
      const error = (e as Error).message;
      qualityEvidence.push({ case_index: caseIndex, topic_id: c.topic.id, topic_name: c.topic.name, stratum, insight_count: 0, checks: [], error });
      console.log(`失败，跳过该主题（${error}）`);
    }
  }

  // ── Part B：校验器一致性准召（标注集，按 stratum 分组） ──
  const judgeByStratum: Record<Stratum, JudgeStats> = { arxiv: emptyJudgeStats(), transcript: emptyJudgeStats() };
  const matrixByStratum: Record<Stratum, ConfusionMatrix> = { arxiv: emptyMatrix(), transcript: emptyMatrix() };
  const judgeEvidence: JudgeEvidence[] = [];
  let judgeSucceeded = 0;
  process.stdout.write(`[校验器准召] ${consistencyCases.length} 组标注对… `);
  for (const [caseIndex, c] of consistencyCases.entries()) {
    const st = judgeByStratum[c.stratum ?? "arxiv"];
    const stratum = c.stratum ?? "arxiv";
    let j: Awaited<ReturnType<typeof judgeConsistency>>;
    try {
      j = await judgeConsistency(c.statement, c.source_text);
    } catch (e) {
      st.errors++;
      judgeEvidence.push({ case_index: caseIndex, stratum, expected: c.expected_consistency, predicted: null, rationale: null, error: (e as Error).message });
      continue;
    }
    st.judged++;
    judgeSucceeded++;
    matrixByStratum[stratum][c.expected_consistency][j.consistency]++;
    judgeEvidence.push({ case_index: caseIndex, stratum, expected: c.expected_consistency, predicted: j.consistency, rationale: j.rationale, error: null });
    if (j.consistency === c.expected_consistency) st.correct++;
    if (c.expected_consistency === "not_support") {
      st.negTotal++;
      if (j.consistency === "not_support") st.negRecalled++;
    }
  }
  const judgedTotal = STRATA.reduce((n, s) => n + judgeByStratum[s].judged, 0);
  const errorsTotal = STRATA.reduce((n, s) => n + judgeByStratum[s].errors, 0);
  console.log(`done（成功 ${judgedTotal}/${consistencyCases.length}${errorsTotal ? `，跳过 ${errorsTotal}` : ""}）`);

  // ── 指标（按 stratum 分组打印 + 收集所有硬门行用于退出码） ──
  const activeStrata = STRATA.filter((s) => checksByStratum[s].length > 0 || judgeByStratum[s].judged > 0);
  const rowsByStratum: Record<string, MetricRow[]> = {};
  const allRows: MetricRow[] = [];
  for (const s of activeStrata) {
    const rows = stratumRows(s, checksByStratum[s], judgeByStratum[s]);
    rowsByStratum[s] = rows;
    printMetrics(s, rows);
    allRows.push(...rows);
  }

  // ── 覆盖度（第三层校验，informational，全形态合计）：结论里的具体声明（数字/实体）被引用直接
  // 覆盖的比例。统计 analyzer 产出层（用 it.citations 全量、不剔 blocked）；非硬门，量化缺口现状。 ──
  const allInsights = STRATA.flatMap((s) => insightsByStratum[s]);
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
  const checksTotal = STRATA.reduce((n, s) => n + checksByStratum[s].length, 0);
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
      (checksTotal ? ` · 每引用校验 $${(cost.totalUSD / checksTotal).toFixed(5)}` : ""),
  );

  // ── 人工指标：导出 review queue（非显然占比、幻觉率需人评） ──
  mkdirSync("evals/out", { recursive: true });
  writeFileSync(
    "evals/out/review-queue.json",
    JSON.stringify({ generated_at: new Date().toISOString(), insights: allInsights }, null, 2),
  );
  // 可审计证据：避免只留下聚合率，导致无法区分 analyzer 过度声称、validator 误杀或评测标签问题。
  // CI 会把本文件作为 artifact 上传；其中不含 API 凭据，仅含仓内评测样本索引和模型输出。
  writeFileSync(
    "evals/out/a1-run.json",
    JSON.stringify({
      generated_at: new Date().toISOString(),
      config: evalConfig,
      dataset: { quality_file: qualityFile, quality_cases: qualityCases.length, consistency_file: consistencyFile, consistency_cases: consistencyCases.length, smoke },
      quality_cases: qualityEvidence,
      judge_cases: judgeEvidence,
      confusion_matrix: matrixByStratum,
      metrics: rowsByStratum,
      coverage: { claims_covered: claimsCovered, claims_total: claimsTotal, ratio: coverageRatio },
    }, null, 2),
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

  // ── 回归门（eval-criteria：任一指标较基线降 >3pp 告警/阻断）。各 stratum 各比各的基线段。
  // baseline.json：arxiv → `auto_metrics`（历史键，向后兼容）；transcript → `transcript`。 ──
  let regressed = false;
  try {
    const baseDoc = JSON.parse(readFileSync("evals/baseline.json", "utf8")) as Record<string, unknown>;
    const configs = baseDoc.eval_configs;
    const configsByStratum = configs && typeof configs === "object" && !Array.isArray(configs)
      ? configs as Record<string, unknown>
      : {};
    const baseForStratum = (s: Stratum): Record<string, number> =>
      ((s === "arxiv" ? baseDoc.auto_metrics : baseDoc[s]) ?? {}) as Record<string, number>;
    const TOL = 0.03;
    for (const s of activeStrata) {
      const base = baseForStratum(s);
      if (!Object.keys(base).length) continue;
      const baseConfig = configsByStratum[s];
      const configCompatible = baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig)
        ? sameEvalConfig(baseConfig as Record<string, unknown>, evalConfig)
        : false;
      console.log(`\n回归对照（${s} · vs baseline.json）：`);
      if (!configCompatible) {
        console.log("  ⚠️ 此形态缺少同配置的结构化基线：仅展示指标，不作回归结论；请先全量重建该形态基线。");
      }
      for (const r of rowsByStratum[s]) {
        const b = base[r.key];
        if (typeof b !== "number") continue;
        const delta = r.value - b;
        // info 指标仅打印漂移、不触回归门（其红线由 blocking 守，非本指标）
        const isReg = configCompatible && r.op !== "info" && (r.op === ">=" ? delta < -TOL : delta > TOL);
        if (isReg) regressed = true;
        console.log(
          `  ${r.name.padEnd(18)} ${pct(b)} → ${pct(r.value)}（Δ${delta >= 0 ? "+" : ""}${pct(delta)}）${isReg ? " ⚠️ 回归" : ""}`,
        );
      }
    }
    if (regressed) {
      console.log(
        "  ⚠️ 检测到 >3pp 回归。单次跑有非确定性噪声——标准全量跑下视为阻断；非标准数据集/冒烟仅供参考。",
      );
    }
  } catch {
    console.log("\n（无 baseline.json，跳过回归对照）");
  }

  const failed = allRows.filter((r) => !r.pass);
  console.log(`\n自动门槛：${allRows.length - failed.length}/${allRows.length} 通过。`);
  // 空护栏：无任何可评指标（所有主题失败 + 零一致性对）= 跑批彻底失败，必须判红、不得当通过
  // （与重构前等价：原版恒 6 行、空数据下四项算 0 → FAIL → exit 1）。
  if (!allRows.length) console.log("❌ 无任何可评指标（所有主题失败 + 零一致性对）——判失败，非通过。");
  // 冒烟只证明链路能跑，刻意不把不完整子集的类别缺失当作质量失败；全量仍严格执行阈值与回归门。
  if (smoke) {
    const qualityPathSucceeded = qualityCases.length === 0 || qualitySucceeded > 0;
    const judgePathSucceeded = consistencyCases.length === 0 || judgeSucceeded > 0;
    if (allRows.length && qualityPathSucceeded && judgePathSucceeded) {
      console.log("冒烟模式：忽略质量阈值退出码；请查看 artifact，不能据此更新基线或签发布门。");
      process.exit(0);
    }
    console.log(
      `❌ 冒烟链路未完整跑通（analyzer+validator ${qualitySucceeded}/${qualityCases.length} 主题成功，` +
        `一致性校验 ${judgeSucceeded}/${consistencyCases.length} 对成功）。`,
    );
    process.exit(1);
  }
  // 阈值 FAIL 或（配置可比的）>3pp 回归 → 非零退出（带 key 的 job/CI 可据此阻断合并）
  process.exit(!allRows.length || failed.length || regressed ? 1 : 0);
}

main().catch((err) => {
  console.error("A1 验证运行出错：", err);
  process.exit(1);
});

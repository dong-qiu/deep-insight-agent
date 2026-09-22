/**
 * A1 验证实跑 —— charter 关键假设 A1 / insight-analysis AC10 / DCP-1→M2 硬门槛。
 *
 * 跑端到端切片：ContentItem[] → analyzer → Insight[] → validator → 指标，
 * 对照 `docs/verify/eval-criteria.md` 上线门槛打 PASS/FAIL。
 *
 * 用法：`npm run eval:a1`（需 .env.local 中与 LLM_PROVIDER 对应的凭据）
 *
 * 自动可测指标：引用可达性 / 一致性合格率 / 失败率 / flagged 率 / 校验器准召。
 * 人工指标（非显然占比、幻觉率）：脚本导出隔离的 evals/out/runs/<run-id>/review-queue.json 供人评。
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
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  analyze,
  analyzeChunkInputSha256,
  ANALYZE_BATCH_CHARS,
  ANALYZE_BODY_CHARS,
  ANALYZER_OUTPUT_VERSION,
  DISPLAY_COVERAGE_PRIMARY_CLAIMS_PER_CALL,
  ANALYZER_SYSTEM,
  DISPLAY_COVERAGE_PRIMARY_MAX_TOKENS,
  DISPLAY_COVERAGE_PRIMARY_RESPONSE_BUDGET_VERSION,
  coverageGaps,
  DISPLAY_COVERAGE_COUNTERCHECK_PROMPT_HASH,
  DISPLAY_COVERAGE_COUNTERCHECK_PROMPT_VERSION,
  DISPLAY_COVERAGE_GATE_VERSION,
  DISPLAY_COVERAGE_PROMPT_HASH,
  DISPLAY_COVERAGE_PROMPT_VERSION,
  filterByQuoteCoverage,
  chunkByChars,
  renderImportanceBasis,
  SELECT_WINDOW_CHARS,
  specificClaims,
  verifyQuoteSelfContained,
  type CoverageDecision,
} from "../src/lib/agents/analyzer.js";
import { consistencyBatchMax, consistencyCacheVersion, CONSISTENCY_WINDOW_CHARS, judgeWithRetry, validateBatch } from "../src/lib/agents/validator.js";
import { MODELS, assertCoverageModelSeparation, getCostReport, getRoleCallTelemetry } from "../src/lib/runtime/llm.js";
import { llmApiKey, llmBaseUrl, llmProvider, structuredTransportVersion } from "../src/lib/runtime/llm-provider.js";
import { coverageThinking, coverageThinkingSource, validatorBatchOn, validatorThinking } from "../src/lib/runtime/env.js";
import {
  RELAY_RECOVERY_MAX_PROBES,
  RELAY_RECOVERY_MAX_BACKOFF_WAIT_MS,
  RELAY_RECOVERY_EXHAUSTED_COOLDOWN_MS,
  RELAY_RECOVERY_POLICY_VERSION,
  relayRecoveryStats,
} from "../src/lib/runtime/relay-recovery.js";
import type { AnalysisBatch, CitationCheck, ContentItem, ImportanceReason, Insight, Topic, ValidationResult } from "../src/lib/types.js";
import { DISPLAY_PROJECTION_VERSION } from "../src/lib/utils/source-quote-projection.js";
import { selectInsights } from "../src/lib/agents/report-gen.js";
import { beginA1Run, finalizeA1Run, finalizeFailedA1Run, sha256File, writeA1RunProgress, writeJson, type A1RunProgress, type A1RunWorkspace } from "./a1-artifacts.js";
import { a1SmokeMode, selectA1Cases } from "./a1-case-limit.js";
import { isA1CoverageExecutionFailure } from "./a1-coverage-execution.js";
import { a1IndependentCallConcurrency, mapA1IndependentCalls } from "./a1-independent-call-concurrency.js";
import {
  a1CoverageTimeoutMs,
  A1TopicDeadlineExceededError,
  a1JudgeTimeoutMs,
  a1TopicTimeoutMs,
  runA1CoverageWithDeadline,
  runA1JudgeWithDeadline,
  runA1TopicWithDeadline,
  terminalA1QualityCaseFailure,
} from "./a1-run-control.js";
import { type EvalConfig } from "./a1-config.js";
import { comparableRegistryBaselineMetrics, formalA1GateExitCode } from "./a1-baseline-promotion.js";
import { validateDatasetLock, type DatasetLockValidation } from "./a1-dataset-lock.js";
import {
  countReaderVisibleByTopic,
  DCP_MIN_CONSISTENCY_PAIRS,
  DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC,
  DCP_MIN_TOPICS,
  DCP_SAMPLE_CONTRACT_VERSION,
  dcpSamplePrerequisite,
  readerVisibleDuplicateEvidence,
} from "./a1-dcp.js";
import { DIRTY_SOURCE_FINGERPRINT_ALGORITHM, dirtyFingerprintFromSnapshot } from "./a1-source-state.js";
import {
  a1QualityCheckpointConfigSha256,
  appendA1QualityCheckpointChunk,
  completeA1QualityCheckpointCase,
  createA1QualityCheckpoint,
  loadA1QualityCheckpoint,
  verifiedFailedA1CheckpointSha256,
  writeA1QualityCheckpoint,
  type A1QualityCheckpoint,
  type A1QualityCheckpointContext,
  type A1QualityCheckpointPlanCase,
} from "./a1-quality-checkpoint.js";
import {
  emptyJudgeStats,
  judgeAccuracy,
  judgeCompletion,
  judgeNegativeRecall,
  recordJudgeAttempt,
  type ConsistencyLabel,
  type JudgeStats,
} from "./a1-judge-metrics.js";

type Stratum = "arxiv" | "transcript";
const STRATA: Stratum[] = ["arxiv", "transcript"];
let activeWorkspace: A1RunWorkspace | null = null;
let activeProgress: Omit<A1RunProgress, "run_id" | "updated_at"> | null = null;
let activeQualityCheckpointPath: string | null = null;
let activeResumeCheckpointSha256: string | null = null;
/** Captured at startup so a long run cannot be attributed to a later checkout or dataset edit. */
let activeRunContext: {
  config: object;
  dataset: object;
  source: { commit: string | null; dirty_fingerprint: string | null; dirty_fingerprint_algorithm?: string };
} = {
  config: {}, dataset: {}, source: { commit: null, dirty_fingerprint: null },
};

function a1ErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function updateA1Progress(progress: Omit<A1RunProgress, "run_id" | "updated_at">): void {
  activeProgress = progress;
  if (activeWorkspace) writeA1RunProgress(activeWorkspace, progress);
}

/** Always publish an interrupted/failed run as terminal evidence when a workspace exists. */
function finalizeActiveA1Failure(error: unknown): void {
  const workspace = activeWorkspace;
  if (!workspace) return;
  activeWorkspace = null;
  const message = a1ErrorMessage(error);
  const prior = activeProgress ?? { state: "running" as const, phase: "setup" as const };
  try {
    const failureProgress: Omit<A1RunProgress, "run_id" | "updated_at"> = {
      ...prior,
      state: "failed",
      last_failure: {
        phase: prior.phase,
        ...(prior.current_case ? { case_index: prior.current_case.index, topic_id: prior.current_case.topic_id } : {}),
        error: message,
      },
    };
    activeProgress = failureProgress;
    writeA1RunProgress(workspace, failureProgress);
    const progressPath = join(workspace.tempDir, "progress.json");
    finalizeFailedA1Run(workspace, {
      run_id: workspace.runId,
      status: "failed",
      auto_gate: "not_evaluated",
      manual_review: "not_generated",
      dcp_eligibility: "not_evaluated",
      started_at: workspace.startedAt,
      ended_at: new Date().toISOString(),
      config: activeRunContext.config,
      dataset: activeRunContext.dataset,
      source: activeRunContext.source,
      insights: { count: 0, ids_sha256: createHash("sha256").update("").digest("hex") },
      artifacts: {
        ...(existsSync(progressPath) ? { "progress.json": sha256File(progressPath) } : {}),
        ...(activeQualityCheckpointPath && existsSync(activeQualityCheckpointPath)
          ? { "quality-checkpoint.json": sha256File(activeQualityCheckpointPath) }
          : {}),
      },
      ...(activeResumeCheckpointSha256 ? { resumed_from_checkpoint_sha256: activeResumeCheckpointSha256 } : {}),
      error: message,
    });
  } catch (artifactError) {
    console.error("A1 失败产物记录也失败：", artifactError);
  } finally {
    activeProgress = null;
    activeQualityCheckpointPath = null;
    activeResumeCheckpointSha256 = null;
  }
}

/** SIGTERM/SIGINT used to strand a private `.tmp` workspace in `running`; terminalize first. */
function installA1InterruptionHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const error = new Error(`A1 run interrupted by ${signal}`);
      console.error(error.message);
      finalizeActiveA1Failure(error);
      process.exit(1);
    });
  }
}

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
const DISPLAY_COVERAGE_FIXTURE = "evals/dataset/display-coverage-benchmark.json";
const QUOTE_SELF_CONTAINED_FIXTURE = "evals/dataset/quote-self-contained-benchmark.json";
const DEFAULT_DATASET_LOCK = "evals/dataset/dataset-lock.json";

interface QualityCase {
  topic: Topic;
  items: ContentItem[];
  time_window: { start: string; end: string };
  stratum?: Stratum; // 缺省 arxiv
}

function qualityCheckpointPlan(cases: readonly QualityCase[]): A1QualityCheckpointPlanCase[] {
  return cases.map((entry, caseIndex) => ({
    case_index: caseIndex,
    topic_id: entry.topic.id,
    stratum: entry.stratum ?? "arxiv",
    chunk_input_sha256: chunkByChars(entry.items).map((chunk) => analyzeChunkInputSha256(
      entry.topic, chunk, entry.time_window, [],
    )),
  }));
}

interface A1ResumeSource {
  checkpoint: A1QualityCheckpoint;
  checkpoint_sha256: string;
}

/**
 * A checkpoint may only come from a terminal failed A1 run whose manifest hashes that exact file.
 * This prevents a hand-edited temporary file from silently becoming model evidence on a new run.
 */
function loadA1ResumeSource(
  raw: string | undefined,
  context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
): A1ResumeSource | null {
  const requested = raw?.trim();
  if (!requested) return null;
  let checkpointPath: string;
  try {
    checkpointPath = statSync(requested).isDirectory() ? join(requested, "quality-checkpoint.json") : requested;
  } catch {
    throw new Error("A1_RESUME_FROM 不存在或不可读取");
  }
  const manifestPath = join(dirname(checkpointPath), "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("A1_RESUME_FROM 缺少所属失败 run 的 manifest.json");
  const checkpointSha256 = verifiedFailedA1CheckpointSha256(manifestPath, checkpointPath);
  return { checkpoint: loadA1QualityCheckpoint(checkpointPath, context, plan), checkpoint_sha256: checkpointSha256 };
}

interface ConsistencyCase {
  statement: string;
  source_text: string;
  expected_consistency: ConsistencyLabel;
  negative_type?: string;
  stratum?: Stratum; // 缺省 arxiv
}
type ConfusionMatrix = Record<ConsistencyLabel, Record<ConsistencyLabel, number>>;

interface QualityEvidence {
  case_index: number;
  topic_id: string;
  topic_name: string;
  stratum: Stratum;
  insight_count: number;
  /** Production reader selector after v6 audit/binding + validator whitelist, never raw analyze() yield. */
  reader_visible_insight_count: number;
  checks: CitationCheck[];
  coverage_decisions: CoverageDecision[];
}

interface DisplayCoverageCase {
  id: string;
  expected: "accept" | "reject";
  field: "statement" | "headline" | "importance_basis";
  facets: string[];
  statement: string;
  statement_citation_index: number;
  /** Required for accepted cases: the reader-visible statement must be this exact bound quote. */
  expected_statement?: string;
  headline?: string;
  importance_facts?: string[];
  importance_reason?: ImportanceReason;
  importance_reason_claim_indexes?: number[];
  citations: Array<{ claim: string; quote: string }>;
}

interface DisplayCoverageResult {
  id: string;
  expected: "accept" | "reject";
  field: DisplayCoverageCase["field"];
  facets: string[];
  actual: "accept" | "reject";
  rendered_statement: string | null;
  projection_matches_expected: boolean;
  decisions: CoverageDecision[];
  latency_ms: number;
  error: string | null;
}

interface QuoteSelfContainedCase {
  id: string;
  expected: "accept" | "reject";
  quote: string;
  locator: string;
}

interface QuoteSelfContainedResult {
  id: string;
  expected: "accept" | "reject";
  actual: "accept" | "reject";
  reason: string;
  latency_ms: number;
  error: string | null;
}

interface JudgeEvidence {
  case_index: number;
  stratum: Stratum;
  expected: ConsistencyLabel;
  predicted: ConsistencyLabel | null;
  rationale: string | null;
  /** End-to-end time including all nested SDK/application retry attempts. */
  latency_ms: number;
  error: string | null;
}

interface IndependentJudgeResult {
  case_index: number;
  stratum: Stratum;
  case: ConsistencyCase;
  judgment: Awaited<ReturnType<typeof judgeWithRetry>> | null;
  latency_ms: number;
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

function currentEvalConfig(qualityFile: string, consistencyFile: string, datasetLock: DatasetLockValidation): EvalConfig {
  return {
    llm_provider: llmProvider(),
    // An endpoint changes provider behaviour but can be deployment-sensitive; store only a hash
    // in A1 artifacts, as we already do for prompts and datasets.
    llm_endpoint_sha256: createHash("sha256").update(llmBaseUrl() ?? "provider-default").digest("hex"),
    analyzer_model: MODELS.analyzer,
    analyzer_output_version: ANALYZER_OUTPUT_VERSION,
    analyzer_prompt_sha256: createHash("sha256").update(ANALYZER_SYSTEM).digest("hex"),
    analyze_body_chars: ANALYZE_BODY_CHARS,
    analyze_batch_chars: ANALYZE_BATCH_CHARS,
    select_window_chars: SELECT_WINDOW_CHARS,
    validator_model: MODELS.validator,
    validator_contract_version: consistencyCacheVersion(),
    consistency_window_chars: CONSISTENCY_WINDOW_CHARS,
    consistency_batch_max: consistencyBatchMax(),
    independent_call_concurrency: a1IndependentCallConcurrency(),
    relay_recovery_policy_version: RELAY_RECOVERY_POLICY_VERSION,
    relay_recovery_max_probes: RELAY_RECOVERY_MAX_PROBES,
    relay_recovery_max_backoff_wait_ms: RELAY_RECOVERY_MAX_BACKOFF_WAIT_MS,
    relay_recovery_exhausted_cooldown_ms: RELAY_RECOVERY_EXHAUSTED_COOLDOWN_MS,
    coverage_model: MODELS.coverage,
    validator_thinking: validatorThinking(),
    coverage_thinking: coverageThinking(),
    coverage_thinking_source: coverageThinkingSource(),
    structured_thinking_transport_version: structuredTransportVersion(),
    validator_batch: validatorBatchOn(),
    quality_dataset_sha256: datasetDigest(qualityFile),
    consistency_dataset_sha256: datasetDigest(consistencyFile),
    dataset_lock_sha256: datasetLock.lock_sha256,
    dataset_lock_status: datasetLock.status,
    display_coverage_dataset_sha256: datasetDigest(DISPLAY_COVERAGE_FIXTURE),
    quote_self_contained_dataset_sha256: datasetDigest(QUOTE_SELF_CONTAINED_FIXTURE),
    display_coverage_gate_version: DISPLAY_COVERAGE_GATE_VERSION,
    display_projection_version: DISPLAY_PROJECTION_VERSION,
    display_coverage_primary_prompt_version: DISPLAY_COVERAGE_PROMPT_VERSION,
    display_coverage_primary_prompt_sha256: DISPLAY_COVERAGE_PROMPT_HASH,
    display_coverage_primary_response_budget_version: DISPLAY_COVERAGE_PRIMARY_RESPONSE_BUDGET_VERSION,
    display_coverage_primary_max_tokens: DISPLAY_COVERAGE_PRIMARY_MAX_TOKENS,
    display_coverage_primary_claims_per_call: DISPLAY_COVERAGE_PRIMARY_CLAIMS_PER_CALL,
    display_coverage_countercheck_prompt_version: DISPLAY_COVERAGE_COUNTERCHECK_PROMPT_VERSION,
    display_coverage_countercheck_prompt_sha256: DISPLAY_COVERAGE_COUNTERCHECK_PROMPT_HASH,
  };
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function readDisplayCoverageCases(path = DISPLAY_COVERAGE_FIXTURE): DisplayCoverageCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { cases?: DisplayCoverageCase[] };
  if (!Array.isArray(parsed.cases) || !parsed.cases.length) throw new Error(`${path} 缺少 display coverage cases`);
  return parsed.cases;
}

function readQuoteSelfContainedCases(path = QUOTE_SELF_CONTAINED_FIXTURE): QuoteSelfContainedCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string; cases?: QuoteSelfContainedCase[] };
  if (parsed.version !== "quote-self-contained-v1" || !Array.isArray(parsed.cases) || !parsed.cases.length) {
    throw new Error(`${path} 缺少 quote-self-contained-v1 cases`);
  }
  return parsed.cases;
}

function coveragePipelineSummary(decisions: CoverageDecision[]) {
  const terminal_reasons: Record<string, number> = {};
  const dropped_claims_by_field: Record<string, number> = {};
  const dropped_claims_by_reason: Record<string, number> = {};
  const projection_reasons: Record<string, number> = {};
  for (const decision of decisions) {
    terminal_reasons[decision.terminal_reason] = (terminal_reasons[decision.terminal_reason] ?? 0) + 1;
    for (const reason of decision.projection_reasons ?? []) {
      projection_reasons[reason] = (projection_reasons[reason] ?? 0) + 1;
    }
    for (const claim of decision.claims.filter((claim) => !claim.supports)) {
      dropped_claims_by_field[claim.field] = (dropped_claims_by_field[claim.field] ?? 0) + 1;
      dropped_claims_by_reason[claim.reason] = (dropped_claims_by_reason[claim.reason] ?? 0) + 1;
    }
  }
  return {
    generated: decisions.length,
    dropped_truncated: terminal_reasons.dropped_truncated ?? 0,
    dropped_other: (terminal_reasons.dropped_no_displayable_citation ?? 0) + (terminal_reasons.dropped_invalid_citation ?? 0),
    repair: { attempted: 0, kept: 0, note: "P0 disables automatic rewrite/backfill" },
    dropped_coverage: (terminal_reasons.dropped_coverage ?? 0) + (terminal_reasons.dropped_coverage_error ?? 0),
    kept: terminal_reasons.kept ?? 0,
    terminal_reasons,
    dropped_claims_by_field,
    dropped_claims_by_reason,
    projection_reasons,
  };
}

function hasCoverageExecutionError(decisions: CoverageDecision[]): boolean {
  return decisions.some((decision) => decision.claims.some((claim) => (
    isA1CoverageExecutionFailure(claim.reason)
    || claim.countercheck?.error != null
    || (claim.countercheck != null && isA1CoverageExecutionFailure(claim.countercheck.reason))
  )));
}

async function runDisplayCoverageBenchmark(
  cases: DisplayCoverageCase[],
  concurrency: number,
  timeoutMs: number,
  onSettled?: (index: number) => void,
): Promise<DisplayCoverageResult[]> {
  return mapA1IndependentCalls(cases, concurrency, async (c) => {
    const startedAt = Date.now();
    const controlled = c.importance_reason != null || c.importance_facts != null || c.importance_reason_claim_indexes != null;
    const facts = c.importance_facts ?? [];
    const reason = c.importance_reason;
    const insight: Insight = {
      id: `display-benchmark_${c.id}`,
      topic_id: "display-coverage-benchmark",
      type: "aggregation",
      event_id: null,
      statement: c.statement,
      statement_citation_index: c.statement_citation_index,
      headline: c.headline ?? "",
      importance: 3,
      ...(controlled && reason ? {
        importance_facts: facts,
        importance_reason: reason,
        importance_reason_claim_indexes: c.importance_reason_claim_indexes ?? [],
        importance_basis: renderImportanceBasis(facts, reason),
      } : { importance_basis: "" }),
      citations: c.citations.map((citation) => ({
        content_item_id: `benchmark_${c.id}`,
        claim: citation.claim,
        quote: citation.quote,
        locator: { paragraph_index: 0, char_start: 0, char_end: citation.quote.length },
      })),
      source_count: 1,
      multi_source: false,
      time_window: { start: "", end: "" },
      confidence: null,
      language: "en",
      is_followup: false,
    };
    const decisions: CoverageDecision[] = [];
    try {
      const kept = await runA1CoverageWithDeadline(
        c.id,
        timeoutMs,
        (signal) => filterByQuoteCoverage([insight], undefined, undefined, (decision) => decisions.push(decision), signal),
      );
      const rendered_statement = kept[0]?.statement ?? null;
      return {
        id: c.id, expected: c.expected, field: c.field, facets: c.facets,
        actual: kept.length ? "accept" : "reject", rendered_statement,
        projection_matches_expected: c.expected_statement == null || rendered_statement === c.expected_statement,
        decisions, latency_ms: Date.now() - startedAt,
        // The production gate rejects an unavailable countercheck. The evaluation must expose
        // that infrastructure gap instead of treating the conservative rejection as a pass.
        error: hasCoverageExecutionError(decisions) ? "coverage audit unavailable or invalid" : null,
      };
    } catch (error) {
      return {
        id: c.id, expected: c.expected, field: c.field, facets: c.facets, actual: "reject",
        rendered_statement: null, projection_matches_expected: c.expected_statement == null,
        decisions, latency_ms: Date.now() - startedAt, error: a1ErrorMessage(error),
      };
    }
  }, { onSettled });
}

/** Coverage is evaluated without the primary validator in this fixture.  Keeping this separate
 * prevents the end-to-end AND gate from masking an unsafe independent countercheck. */
async function runQuoteSelfContainedBenchmark(
  cases: QuoteSelfContainedCase[],
  concurrency: number,
  timeoutMs: number,
  onSettled?: (index: number) => void,
): Promise<QuoteSelfContainedResult[]> {
  return mapA1IndependentCalls(cases, concurrency, async (c) => {
    const startedAt = Date.now();
    const [paragraph, start, end] = c.locator.split(":").map(Number);
    try {
      const decision = await runA1CoverageWithDeadline(
        c.id,
        timeoutMs,
        (signal) => verifyQuoteSelfContained({
          content_item_id: `quote-benchmark_${c.id}`,
          quote: c.quote,
          locator: { paragraph_index: paragraph!, char_start: start!, char_end: end! },
        }, undefined, signal),
      );
      return {
        id: c.id,
        expected: c.expected,
        actual: decision.supports ? "accept" : "reject",
        reason: decision.reason,
        latency_ms: Date.now() - startedAt,
        error: decision.error || isA1CoverageExecutionFailure(decision.reason)
          ? "coverage countercheck unavailable or invalid"
          : null,
      };
    } catch (error) {
      return {
        id: c.id,
        expected: c.expected,
        actual: "reject",
        reason: "countercheck_threw",
        latency_ms: Date.now() - startedAt,
        error: a1ErrorMessage(error),
      };
    }
  }, { onSettled });
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function gitBuffer(args: string[]): Buffer | null {
  try {
    return execFileSync("git", args);
  } catch {
    return null;
  }
}

function sourceState() {
  const dirty = gitBuffer(["status", "--porcelain=v1", "-z"]);
  const untrackedPaths = gitBuffer(["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = untrackedPaths == null ? [] : untrackedPaths.toString("utf8").split("\0").filter(Boolean).map((path) => {
    try { return { path, content: readFileSync(path) }; } catch { return { path, content: null }; }
  });
  return {
    commit: gitValue(["rev-parse", "HEAD"]),
    dirty_fingerprint: dirtyFingerprintFromSnapshot({
      status: dirty,
      staged_diff: gitBuffer(["diff", "--no-ext-diff", "--binary", "--cached"]),
      unstaged_diff: gitBuffer(["diff", "--no-ext-diff", "--binary"]),
      untracked,
    }),
    dirty_fingerprint_algorithm: DIRTY_SOURCE_FINGERPRINT_ALGORITHM,
  };
}

function insightManifest(insights: Insight[]) {
  const ids = insights.map((insight) => insight.id).sort();
  return {
    count: ids.length,
    ids_sha256: createHash("sha256").update(ids.join("\n")).digest("hex"),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface MetricRow {
  key: string; // 对齐 approved baseline-registry 各 stratum 的规范键（回归对照用）
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
    metric("judge_accuracy", "校验器端到端三分类准确率", judgeAccuracy(judge), t.judgeAccuracy, ">=", "validator_classifier"),
    metric("judge_neg_recall", "校验器端到端负例召回率", judgeNegativeRecall(judge), t.judgeNegRecall, ">=", "validator_classifier"),
    metric("judge_completion", "校验器完成率", judgeCompletion(judge), 1, "info", "validator_classifier"),
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
  const provider = llmProvider();
  const apiKey = llmApiKey(provider);
  if (!apiKey) {
    console.error(
      provider === "volcengine-responses"
        ? "缺少 LLM_API_KEY（volcengine-responses）。请在 .env.local 设置 Coding Plan key 和 LLM_BASE_URL。"
        : "缺少 LLM_API_KEY（或兼容的 ANTHROPIC_API_KEY）。请在 .env.local 设置真实 key。",
    );
    process.exit(2);
  }
  if (provider === "anthropic" && !apiKey.startsWith("sk-ant-") && !llmBaseUrl(provider)) {
    console.warn(
      "⚠️ LLM_API_KEY / ANTHROPIC_API_KEY 不以 'sk-ant-' 开头，可能不是有效的 Anthropic key" +
        "（Anthropic key 形如 sk-ant-api03-...）。若实跑报 401/403，请先核对 key。\n",
    );
  }
  assertCoverageModelSeparation();
  activeWorkspace = beginA1Run(process.env.A1_RUNS_DIR?.trim() || undefined);
  activeQualityCheckpointPath = join(activeWorkspace.tempDir, "quality-checkpoint.json");
  installA1InterruptionHandlers();
  updateA1Progress({ state: "running", phase: "setup" });
  const topicTimeoutMs = a1TopicTimeoutMs();
  const judgeTimeoutMs = a1JudgeTimeoutMs();
  const coverageTimeoutMs = a1CoverageTimeoutMs();
  // 子集开关只服务于有界诊断。任何非零 A1_*_LIMIT（即使当前 fixture 恰好未被截断）
  // 都会成为不可晋升的 smoke run，避免未来 fixture 扩容后静默改变全量证据范围。

  // ── Part A：洞察提炼 + 引用双层校验（按 stratum 分组收集） ──
  // A1_QUALITY_FILE 可指向本地多源集（evals/dataset/*.local.jsonl，不入仓）；默认 arXiv 集
  const qualityFile = process.env.A1_QUALITY_FILE ?? "evals/dataset/insight-quality.jsonl";
  const qualityAll = readJsonl<QualityCase>(qualityFile);
  const qualitySelection = selectA1Cases(qualityAll, process.env.A1_QUALITY_LIMIT, "A1_QUALITY_LIMIT");
  const qualityCases = qualitySelection.cases;
  // A1_CONSISTENCY_FILE 可指向分形态集（如 transcript 专集），默认 arXiv 标注集。
  const consistencyFile = process.env.A1_CONSISTENCY_FILE ?? "evals/dataset/citation-consistency.jsonl";
  const consistencyAll = readJsonl<ConsistencyCase>(consistencyFile);
  const consistencySelection = selectA1Cases(consistencyAll, process.env.A1_CONSISTENCY_LIMIT, "A1_CONSISTENCY_LIMIT");
  const consistencyCases = consistencySelection.cases;
  const displayCoverageAll = readDisplayCoverageCases();
  const displayCoverageSelection = selectA1Cases(
    displayCoverageAll,
    process.env.A1_DISPLAY_COVERAGE_LIMIT,
    "A1_DISPLAY_COVERAGE_LIMIT",
  );
  const displayCoverageCases = displayCoverageSelection.cases;
  const quoteSelfContainedAll = readQuoteSelfContainedCases();
  const quoteSelfContainedSelection = selectA1Cases(
    quoteSelfContainedAll,
    process.env.A1_QUOTE_SELF_CONTAINED_LIMIT,
    "A1_QUOTE_SELF_CONTAINED_LIMIT",
  );
  const quoteSelfContainedCases = quoteSelfContainedSelection.cases;
  const datasetLockPath = process.env.A1_DATASET_LOCK ?? DEFAULT_DATASET_LOCK;
  let datasetLock: DatasetLockValidation;
  try {
    datasetLock = validateDatasetLock(datasetLockPath, {
      qualityFile,
      consistencyFile,
      displayCoverageFixture: DISPLAY_COVERAGE_FIXTURE,
      // Formal v2 locks additionally inspect the actual receipt bytes. Legacy fixtures remain
      // runnable without this optional controlled-runner input.
      consistencyReceiptFile: process.env.A1_CONSISTENCY_RECEIPT_FILE,
    });
  } catch (error) {
    // An unreadable lock cannot make a run comparable or promotable, but preserving the failed
    // inspection in artifacts is more useful than hiding a genuine model run behind setup noise.
    datasetLock = {
      lock_sha256: "unavailable",
      status: "invalid",
      promotion_eligible: false,
      issues: [`dataset lock 不可读取：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  // 任何非零 A1_*_LIMIT 都是冒烟；上限大于当前数据集也不能悄悄绕过全量质量门。
  const smoke = a1SmokeMode(
    process.env.A1_FORCE_SMOKE,
    qualitySelection,
    consistencySelection,
    displayCoverageSelection,
    quoteSelfContainedSelection,
  );
  const evalConfig = currentEvalConfig(qualityFile, consistencyFile, datasetLock);
  activeRunContext = {
    config: evalConfig,
    dataset: {
      quality_file: qualityFile,
      consistency_file: consistencyFile,
      display_coverage_fixture: DISPLAY_COVERAGE_FIXTURE,
      dataset_lock: { path: datasetLockPath, ...datasetLock },
      quality_cases: qualityCases.length,
      quality_cases_total: qualityAll.length,
      consistency_cases: consistencyCases.length,
      consistency_cases_total: consistencyAll.length,
      display_coverage_cases: displayCoverageCases.length,
      display_coverage_cases_total: displayCoverageAll.length,
      quote_self_contained_cases: quoteSelfContainedCases.length,
      quote_self_contained_cases_total: quoteSelfContainedAll.length,
      judge_timeout_ms: judgeTimeoutMs,
      coverage_timeout_ms: coverageTimeoutMs,
      smoke_forced: process.env.A1_FORCE_SMOKE === "1",
      smoke,
    },
    source: sourceState(),
  };
  const checkpointPlan = qualityCheckpointPlan(qualityCases);
  const checkpointContext: A1QualityCheckpointContext = {
    eval_config_sha256: a1QualityCheckpointConfigSha256(evalConfig),
    quality_dataset_sha256: evalConfig.quality_dataset_sha256,
  };
  const resumeSource = loadA1ResumeSource(process.env.A1_RESUME_FROM, checkpointContext, checkpointPlan);
  const qualityCheckpoint = resumeSource?.checkpoint ?? createA1QualityCheckpoint(checkpointContext);
  activeResumeCheckpointSha256 = resumeSource?.checkpoint_sha256 ?? null;
  writeA1QualityCheckpoint(activeQualityCheckpointPath, qualityCheckpoint);
  if (activeResumeCheckpointSha256) {
    activeRunContext.dataset = { ...activeRunContext.dataset, resumed_from_checkpoint_sha256: activeResumeCheckpointSha256 };
    console.log("A1 将恢复已哈希绑定的完整 analyzer 分块；本次仍保留原始全量样本与自动门口径。\n");
  }
  updateA1Progress({
    state: "running", phase: "setup", topic_timeout_ms: topicTimeoutMs,
    judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
  });
  console.log(
    `A1 验证实跑\n模型：分析=${MODELS.analyzer} / 校验=${MODELS.validator} / 反扩写复核=${MODELS.coverage}` +
      `\n配置：validator thinking=${evalConfig.validator_thinking ? "on" : "off"} / coverage thinking=${evalConfig.coverage_thinking ? "on" : "off"} (${evalConfig.coverage_thinking_source}) / batch=${evalConfig.validator_batch ? "on" : "off"} / independent calls=${evalConfig.independent_call_concurrency}` +
      `\n数据集锁：${datasetLock.status}（${datasetLock.promotion_eligible ? "可候选提升" : "不可提升"}）\n`,
  );
  console.log(
    `A1 单主题截止：${topicTimeoutMs}ms（超时将终止整次运行并写入失败 artifact）` +
      `\nA1 单条一致性判定截止：${judgeTimeoutMs}ms（覆盖 SDK 与应用重试；超时记为评测不完整）` +
      `\nA1 单条 Coverage 基准截止：${coverageTimeoutMs}ms（超时记为评测不完整）\n`,
  );
  if (smoke) {
    console.log(
      `⚠️ 子集冒烟模式：主题 ${qualityCases.length}/${qualityAll.length}` +
        `、一致性对 ${consistencyCases.length}/${consistencyAll.length}` +
        `、展示覆盖 ${displayCoverageCases.length}/${displayCoverageAll.length}` +
        `、quote 自足性 ${quoteSelfContainedCases.length}/${quoteSelfContainedAll.length}` +
        `${process.env.A1_FORCE_SMOKE === "1" ? "（已强制标记为 smoke）" : ""} —— 仅验证真模型链路与成本，不代表 A1 结论。\n`,
    );
  }
  const checksByStratum: Record<Stratum, CitationCheck[]> = { arxiv: [], transcript: [] };
  const insightsByStratum: Record<Stratum, Insight[]> = { arxiv: [], transcript: [] };
  const readerVisibleInsightsByStratum: Record<Stratum, Insight[]> = { arxiv: [], transcript: [] };
  const dcpTopicIds = [...new Set(qualityAll.map((quality) => quality.topic.id))];
  const coverageDecisionsByStratum: Record<Stratum, CoverageDecision[]> = { arxiv: [], transcript: [] };
  const qualityEvidence: Array<QualityEvidence & { error?: string }> = [];
  let qualitySucceeded = 0;
  const qualityFailures: Array<{ case_index: number; topic_id: string; error: string }> = [];
  for (const [caseIndex, c] of qualityCases.entries()) {
    const stratum: Stratum = c.stratum ?? "arxiv";
    updateA1Progress({
      state: "running", phase: "quality", topic_timeout_ms: topicTimeoutMs,
      judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
      current_case: { index: caseIndex, total: qualityCases.length, topic_id: c.topic.id },
      completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
    });
    process.stdout.write(`[分析] 主题「${c.topic.name}」(${stratum})… `);
    const coverageDecisions: CoverageDecision[] = [];
    try {
      const savedCase = qualityCheckpoint.cases[caseIndex];
      let batch: AnalysisBatch;
      let vr: ValidationResult;
      if (savedCase?.completed) {
        // The checkpoint loader has already bound every chunk, the complete topic result and the
        // source failed-run manifest to this exact EvalConfig + quality dataset.
        batch = savedCase.completed.batch;
        vr = savedCase.completed.validation;
        coverageDecisions.push(...savedCase.chunks.flatMap((chunk) => chunk.coverage_decisions));
        process.stdout.write("恢复完整主题… ");
      } else {
        const completedChunks = savedCase?.chunks ?? [];
        ({ batch, vr } = await runA1TopicWithDeadline(c.topic.id, topicTimeoutMs, async (signal) => {
          const batch = await analyze(c.topic, c.items, c.time_window, undefined, {
            completed_chunks: completedChunks,
            onCoverageDecision: (decision) => coverageDecisions.push(decision),
            onChunkComplete: (completion) => {
              // Promise.race may have already handed the deadline error to the outer runner even
              // when a defective upstream transport settles late. Never recreate a published
              // temporary workspace or append evidence after that terminal boundary.
              if (signal.aborted) throw signal.reason ?? new Error("A1 topic cancelled");
              appendA1QualityCheckpointChunk(qualityCheckpoint, checkpointPlan, caseIndex, {
                input_sha256: completion.input_sha256,
                insights: completion.insights,
                coverage_decisions: completion.coverage_decisions,
              });
              writeA1QualityCheckpoint(activeQualityCheckpointPath!, qualityCheckpoint);
              updateA1Progress({
                state: "running", phase: "quality", topic_timeout_ms: topicTimeoutMs,
                judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
                current_case: { index: caseIndex, total: qualityCases.length, topic_id: c.topic.id },
                current_chunk: { index: completion.chunk_index + 1, total: completion.chunk_total },
                completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
              });
            },
            signal,
          });
          const vr = await validateBatch(batch.insights, c.items, undefined, undefined, signal);
          if (signal.aborted) throw signal.reason ?? new Error("A1 topic cancelled");
          return { batch, vr };
        }));
        completeA1QualityCheckpointCase(qualityCheckpoint, checkpointPlan, caseIndex, { batch, validation: vr });
        writeA1QualityCheckpoint(activeQualityCheckpointPath!, qualityCheckpoint);
      }
      // DCP counts the same reader-visible derivative as production, rather than raw analyzer
      // yield. A topic whose citations are all blocked/flagged therefore contributes zero.
      const readerVisible = selectInsights(batch, vr);
      readerVisibleInsightsByStratum[stratum].push(...readerVisible.map((entry) => entry.insight));
      insightsByStratum[stratum].push(...batch.insights);
      checksByStratum[stratum].push(...vr.checks);
      coverageDecisionsByStratum[stratum].push(...coverageDecisions);
      qualitySucceeded++;
      qualityEvidence.push({
        case_index: caseIndex,
        topic_id: c.topic.id,
        topic_name: c.topic.name,
        stratum,
        insight_count: batch.insights.length,
        reader_visible_insight_count: readerVisible.length,
        checks: vr.checks,
        coverage_decisions: coverageDecisions,
      });
      updateA1Progress({
        state: "running", phase: "quality", topic_timeout_ms: topicTimeoutMs,
        judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
        current_case: { index: caseIndex, total: qualityCases.length, topic_id: c.topic.id },
        completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
      });
      console.log(`${batch.insights.length} 洞察 / ${vr.checks.length} 引用校验`);
    } catch (e) {
      const error = a1ErrorMessage(e);
      qualityFailures.push({ case_index: caseIndex, topic_id: c.topic.id, error });
      coverageDecisionsByStratum[stratum].push(...coverageDecisions);
      qualityEvidence.push({ case_index: caseIndex, topic_id: c.topic.id, topic_name: c.topic.name, stratum, insight_count: 0, reader_visible_insight_count: 0, checks: [], coverage_decisions: coverageDecisions, error });
      updateA1Progress({
        // A complete quality population is mandatory evidence.  A request timeout, malformed
        // structured response or any other execution error is terminal just like the outer
        // deadline; continuing would silently skip this topic and make the final run unusable.
        state: "failed",
        phase: "quality",
        topic_timeout_ms: topicTimeoutMs,
        judge_timeout_ms: judgeTimeoutMs,
        coverage_timeout_ms: coverageTimeoutMs,
        current_case: { index: caseIndex, total: qualityCases.length, topic_id: c.topic.id },
        completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
        last_failure: { phase: "quality", case_index: caseIndex, topic_id: c.topic.id, error },
      });
      if (e instanceof A1TopicDeadlineExceededError) {
        console.log(`截止超时，终止本次 A1（${error}）`);
        throw e;
      }
      console.log(`失败，终止本次 A1 并保留可恢复 checkpoint（${error}）`);
      throw terminalA1QualityCaseFailure(caseIndex, c.topic.id, e);
    }
  }

  // ── Part B：校验器一致性准召（标注集，按 stratum 分组） ──
  const judgeByStratum: Record<Stratum, JudgeStats> = { arxiv: emptyJudgeStats(), transcript: emptyJudgeStats() };
  const matrixByStratum: Record<Stratum, ConfusionMatrix> = { arxiv: emptyMatrix(), transcript: emptyMatrix() };
  const judgeEvidence: JudgeEvidence[] = [];
  let judgeSucceeded = 0;
  let judgeSettled = 0;
  const judgeFailures: Array<{ case_index: number; error: string; latency_ms: number }> = [];
  updateA1Progress({
    state: "running", phase: "consistency", topic_timeout_ms: topicTimeoutMs,
    judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
    completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
  });
  process.stdout.write(`[校验器准召] ${consistencyCases.length} 组标注对… `);
  // These single-claim judges do not share model context. The mapper preserves the original
  // dataset order so evidence, matrices and artifacts remain deterministic even when the
  // reviewed c=2 experiment is explicitly selected. Analyzer work is intentionally not here.
  const independentJudgeResults = await mapA1IndependentCalls<ConsistencyCase, IndependentJudgeResult>(
    consistencyCases,
    evalConfig.independent_call_concurrency,
    async (c, caseIndex) => {
      const stratum = c.stratum ?? "arxiv";
      const startedAt = Date.now();
      try {
        // 标注集是一条 claim 对一段 source_text，走生产单条路径的重试包装；直接调
        // judgeConsistency 会把瞬态/结构化输出抖动伪装成“跳过样本”。批量路径另由
        // validate-batch-judge.ts 覆盖，不能用本循环替代其验证。
        const judgment = await runA1JudgeWithDeadline(
          caseIndex,
          judgeTimeoutMs,
          (signal) => judgeWithRetry(c.statement, c.source_text, undefined, undefined, undefined, signal),
        );
        return { case_index: caseIndex, stratum, case: c, judgment, latency_ms: Date.now() - startedAt, error: null };
      } catch (error) {
        return {
          case_index: caseIndex,
          stratum,
          case: c,
          judgment: null,
          latency_ms: Date.now() - startedAt,
          error: a1ErrorMessage(error),
        };
      }
    },
    {
      onSettled: (caseIndex) => {
        judgeSettled++;
        updateA1Progress({
          state: "running", phase: "consistency", topic_timeout_ms: topicTimeoutMs,
          judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
          current_case: { index: caseIndex, total: consistencyCases.length },
          completed: { quality_cases: qualitySucceeded, consistency_cases: 0 },
          settled: { consistency_cases: judgeSettled },
        });
      },
    },
  );
  for (const result of independentJudgeResults) {
    const { case_index: caseIndex, stratum, case: c, judgment, latency_ms, error } = result;
    const st = judgeByStratum[stratum];
    if (!judgment) {
      judgeFailures.push({ case_index: caseIndex, error: error ?? "未知校验器错误", latency_ms });
      recordJudgeAttempt(st, c.expected_consistency, null);
      judgeEvidence.push({ case_index: caseIndex, stratum, expected: c.expected_consistency, predicted: null, rationale: null, latency_ms, error: error ?? "未知校验器错误" });
      continue;
    }
    recordJudgeAttempt(st, c.expected_consistency, judgment.consistency);
    judgeSucceeded++;
    matrixByStratum[stratum][c.expected_consistency][judgment.consistency]++;
    judgeEvidence.push({ case_index: caseIndex, stratum, expected: c.expected_consistency, predicted: judgment.consistency, rationale: judgment.rationale, latency_ms, error: null });
  }
  const judgedTotal = STRATA.reduce((n, s) => n + judgeByStratum[s].judged, 0);
  const errorsTotal = STRATA.reduce((n, s) => n + judgeByStratum[s].errors, 0);
  console.log(`done（完成 ${judgedTotal}/${consistencyCases.length}${errorsTotal ? `，重试耗尽 ${errorsTotal}（计未命中）` : ""}）`);
  const qualityAndJudgeComplete = qualityFailures.length === 0 && judgeFailures.length === 0;
  if (!qualityAndJudgeComplete) {
    console.log(
      `❌ 核心评测不完整：分析主题失败 ${qualityFailures.length} 个，校验标注对失败 ${judgeFailures.length} 个。` +
        " 不会将部分样本与基线比较或宣称自动门通过。",
    );
  }

  // ── 指标（按 stratum 分组打印 + 收集所有硬门行用于退出码） ──
  const activeStrata = STRATA.filter((s) => checksByStratum[s].length > 0 || judgeByStratum[s].attempted > 0);
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
  const rawInsights = STRATA.flatMap((s) => insightsByStratum[s]);
  // The queue and manifest are DCP evidence, so they contain exactly production reader-visible
  // insights—not pre-validation analyzer candidates retained below for informational coverage.
  const allInsights = STRATA.flatMap((s) => readerVisibleInsightsByStratum[s]);
  const readerVisibleByTopic = countReaderVisibleByTopic(dcpTopicIds, allInsights);
  const readerVisibleDuplicates = readerVisibleDuplicateEvidence(allInsights);
  const samplePrerequisite = dcpSamplePrerequisite({
    topics: dcpTopicIds.length,
    consistencyPairs: consistencyAll.length,
    readerVisibleInsightsByTopic: readerVisibleByTopic,
    duplicateInsightIds: readerVisibleDuplicates.duplicate_insight_ids,
    duplicateStatementQuoteKeys: readerVisibleDuplicates.duplicate_statement_quote_keys,
  });
  const dcpSample = {
    contract_version: DCP_SAMPLE_CONTRACT_VERSION,
    min_topics: DCP_MIN_TOPICS,
    min_consistency_pairs: DCP_MIN_CONSISTENCY_PAIRS,
    min_reader_visible_insights_per_topic: DCP_MIN_READER_VISIBLE_INSIGHTS_PER_TOPIC,
    unique_topic_count: dcpTopicIds.length,
    reader_visible_total: allInsights.length,
    reader_visible_by_topic: Object.fromEntries(readerVisibleByTopic.map(({ topic_id, count }) => [topic_id, count])),
    duplicate_insight_ids: readerVisibleDuplicates.duplicate_insight_ids,
    duplicate_statement_quote_count: readerVisibleDuplicates.duplicate_statement_quote_keys.length,
  };
  let claimsTotal = 0;
  let claimsCovered = 0;
  for (const it of rawInsights) {
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

  // ── 展示级引用覆盖基准（P0，独立于 analyzer 的最终 yield）──
  // 手标 reject 的任何一条若被放行就是 unsafe_accept，硬门必须为 0；false reject 暂作
  // 信息量，避免在未建立足够样本前把“保守”误报成安全放行。
  updateA1Progress({
    state: "running", phase: "coverage_benchmark", topic_timeout_ms: topicTimeoutMs,
    judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
    completed: { quality_cases: qualitySucceeded, consistency_cases: judgeSucceeded },
    benchmark: "display_coverage",
    settled: { consistency_cases: judgeSettled, display_coverage_cases: 0, quote_self_contained_cases: 0 },
  });
  process.stdout.write(`[展示引用覆盖] ${displayCoverageCases.length} 条手标反例/正例… `);
  let displayCoverageSettled = 0;
  let quoteSelfContainedSettled = 0;
  const displayCoverageResults = await runDisplayCoverageBenchmark(
    displayCoverageCases,
    evalConfig.independent_call_concurrency,
    coverageTimeoutMs,
    (caseIndex) => {
      displayCoverageSettled++;
      updateA1Progress({
        state: "running", phase: "coverage_benchmark", topic_timeout_ms: topicTimeoutMs,
        judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
        benchmark: "display_coverage",
        current_case: { index: caseIndex, total: displayCoverageCases.length },
        completed: { quality_cases: qualitySucceeded, consistency_cases: judgeSucceeded },
        settled: {
          consistency_cases: judgeSettled,
          display_coverage_cases: displayCoverageSettled,
          quote_self_contained_cases: quoteSelfContainedSettled,
        },
      });
    },
  );
  const expectedRejects = displayCoverageResults.filter((result) => result.expected === "reject");
  const expectedAccepts = displayCoverageResults.filter((result) => result.expected === "accept");
  // An accepted case whose rendered text differs from its manually pinned bound quote is also a
  // P0 unsafe acceptance: it would prove that an internal claim has leaked back to a reader.
  const projectionViolations = displayCoverageResults.filter((result) => result.actual === "accept" && !result.projection_matches_expected);
  const unsafeAccepts = [
    ...expectedRejects.filter((result) => result.actual === "accept"),
    ...projectionViolations,
  ];
  const falseRejects = expectedAccepts.filter((result) => result.actual === "reject");
  const unsafeAcceptRate = expectedRejects.length ? unsafeAccepts.length / expectedRejects.length : 1;
  const displayCoverageMetric = metric("display_unsafe_accept", "展示覆盖 unsafe_accept", unsafeAcceptRate, 0, "<=", "publish_safety");
  allRows.push(displayCoverageMetric);
  console.log(`${displayCoverageMetric.pass ? "✅" : "❌"} unsafe_accept ${unsafeAccepts.length}/${expectedRejects.length}；projection_violation ${projectionViolations.length}/${displayCoverageResults.length}；false_reject ${falseRejects.length}/${expectedAccepts.length}`);

  // ── Coverage 单角色校准（不能由主 validator 的先行拒绝代替）──
  updateA1Progress({
    state: "running", phase: "coverage_benchmark", topic_timeout_ms: topicTimeoutMs,
    judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
    benchmark: "quote_self_contained",
    completed: { quality_cases: qualitySucceeded, consistency_cases: judgeSucceeded },
    settled: {
      consistency_cases: judgeSettled,
      display_coverage_cases: displayCoverageSettled,
      quote_self_contained_cases: 0,
    },
  });
  process.stdout.write(`[Coverage quote-self-contained] ${quoteSelfContainedCases.length} 条手标 quote-only 用例… `);
  const quoteSelfContainedResults = await runQuoteSelfContainedBenchmark(
    quoteSelfContainedCases,
    evalConfig.independent_call_concurrency,
    coverageTimeoutMs,
    (caseIndex) => {
      quoteSelfContainedSettled++;
      updateA1Progress({
        state: "running", phase: "coverage_benchmark", topic_timeout_ms: topicTimeoutMs,
        judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
        benchmark: "quote_self_contained",
        current_case: { index: caseIndex, total: quoteSelfContainedCases.length },
        completed: { quality_cases: qualitySucceeded, consistency_cases: judgeSucceeded },
        settled: {
          consistency_cases: judgeSettled,
          display_coverage_cases: displayCoverageSettled,
          quote_self_contained_cases: quoteSelfContainedSettled,
        },
      });
    },
  );
  const quoteExpectedRejects = quoteSelfContainedResults.filter((result) => result.expected === "reject");
  const quoteUnsafeAccepts = quoteExpectedRejects.filter((result) => result.actual === "accept");
  const quoteFalseRejects = quoteSelfContainedResults.filter((result) => result.expected === "accept" && result.actual === "reject");
  const quoteUnsafeAcceptRate = quoteExpectedRejects.length ? quoteUnsafeAccepts.length / quoteExpectedRejects.length : 1;
  const quoteSelfContainedMetric = metric("quote_self_contained_unsafe_accept", "Coverage quote-self-contained unsafe_accept", quoteUnsafeAcceptRate, 0, "<=", "publish_safety");
  allRows.push(quoteSelfContainedMetric);
  console.log(`${quoteSelfContainedMetric.pass ? "✅" : "❌"} unsafe_accept ${quoteUnsafeAccepts.length}/${quoteExpectedRejects.length}；false_reject ${quoteFalseRejects.length}/${quoteSelfContainedResults.filter((result) => result.expected === "accept").length}`);
  const coverageBenchmarkFailures = [
    ...displayCoverageResults.filter((result) => result.error != null).map((result) => ({
      benchmark: "display_coverage" as const, case_id: result.id, latency_ms: result.latency_ms, error: result.error!,
    })),
    ...quoteSelfContainedResults.filter((result) => result.error != null).map((result) => ({
      benchmark: "quote_self_contained" as const, case_id: result.id, latency_ms: result.latency_ms, error: result.error!,
    })),
  ];
  const coreComplete = qualityAndJudgeComplete && coverageBenchmarkFailures.length === 0;
  if (coverageBenchmarkFailures.length) {
    console.log(
      `❌ Coverage 基准不完整：${coverageBenchmarkFailures.length} 条基础设施失败或超时。` +
        " 保守拒绝不等于该手标安全测试完成；不会比较基线或宣称自动门通过。",
    );
  }

  // ── 成本（估算，A5 成本可控） ──
  const cost = getCostReport();
  const roleTelemetry = getRoleCallTelemetry();
  const checksTotal = STRATA.reduce((n, s) => n + checksByStratum[s].length, 0);
  console.log("\n角色调用观测：");
  for (const [role, telemetry] of Object.entries(roleTelemetry)) {
    if (!telemetry.calls) continue;
    console.log(`  ${role}：${telemetry.calls} calls / ${telemetry.requests} requests / ${telemetry.failures} failures · p95 ${telemetry.latency_ms.p95.toFixed(0)}ms`);
    for (const [operation, operationTelemetry] of Object.entries(telemetry.by_operation)) {
      console.log(`    └ ${operation}：${operationTelemetry.calls} calls / ${operationTelemetry.requests} requests / ${operationTelemetry.failures} failures · p95 ${operationTelemetry.latency_ms.p95.toFixed(0)}ms`);
    }
  }
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
  // All files first land in this run's private temp directory. Only finalizeA1Run publishes it.
  const workspace = activeWorkspace!;
  const reviewGeneratedAt = new Date().toISOString();
  const recovery = relayRecoveryStats();
  const pipelineCoverage = Object.fromEntries(STRATA.map((stratum) => [stratum, coveragePipelineSummary(coverageDecisionsByStratum[stratum])]));
  const reviewQueuePath = join(workspace.tempDir, "review-queue.json");
  const a1RunPath = join(workspace.tempDir, "a1-run.json");
  const reviewCsvPath = join(workspace.tempDir, "review.csv");
  writeJson(
    reviewQueuePath,
    { run_id: workspace.runId, generated_at: reviewGeneratedAt, insights: allInsights },
  );
  // 可审计证据：避免只留下聚合率，导致无法区分 analyzer 过度声称、validator 误杀或评测标签问题。
  // CI 会把本文件作为 artifact 上传；其中不含 API 凭据，仅含仓内评测样本索引和模型输出。
  writeJson(
    a1RunPath,
    {
      run_id: workspace.runId,
      generated_at: reviewGeneratedAt,
      config: evalConfig,
      dataset: {
        quality_file: qualityFile,
        quality_cases: qualityCases.length,
        quality_cases_total: qualityAll.length,
        consistency_file: consistencyFile,
        consistency_cases: consistencyCases.length,
        consistency_cases_total: consistencyAll.length,
        display_coverage_cases: displayCoverageCases.length,
        display_coverage_cases_total: displayCoverageAll.length,
        quote_self_contained_cases: quoteSelfContainedCases.length,
        quote_self_contained_cases_total: quoteSelfContainedAll.length,
        judge_timeout_ms: judgeTimeoutMs,
        coverage_timeout_ms: coverageTimeoutMs,
        smoke_forced: process.env.A1_FORCE_SMOKE === "1",
        dataset_lock: { path: datasetLockPath, ...datasetLock },
        smoke,
      },
      completion: {
        core_complete: coreComplete,
        quality_succeeded: qualitySucceeded,
        quality_total: qualityCases.length,
        quality_failures: qualityFailures,
        judge_succeeded: judgeSucceeded,
        judge_total: consistencyCases.length,
        judge_failures: judgeFailures,
        coverage_benchmark_failures: coverageBenchmarkFailures,
      },
      dcp_sample: dcpSample,
      quality_cases: qualityEvidence,
      judge_cases: judgeEvidence,
      confusion_matrix: matrixByStratum,
      metrics: rowsByStratum,
      coverage: { claims_covered: claimsCovered, claims_total: claimsTotal, ratio: coverageRatio },
      display_coverage: {
        fixture: DISPLAY_COVERAGE_FIXTURE,
        fixture_sha256: evalConfig.display_coverage_dataset_sha256,
        unsafe_accept: { count: unsafeAccepts.length, total: expectedRejects.length, rate: unsafeAcceptRate },
        projection_violation: { count: projectionViolations.length, total: displayCoverageResults.length },
        false_reject: { count: falseRejects.length, total: expectedAccepts.length },
        results: displayCoverageResults,
      },
      quote_self_contained_coverage: {
        fixture: QUOTE_SELF_CONTAINED_FIXTURE,
        fixture_sha256: evalConfig.quote_self_contained_dataset_sha256,
        unsafe_accept: { count: quoteUnsafeAccepts.length, total: quoteExpectedRejects.length, rate: quoteUnsafeAcceptRate },
        false_reject: { count: quoteFalseRejects.length, total: quoteSelfContainedResults.filter((result) => result.expected === "accept").length },
        results: quoteSelfContainedResults,
      },
      pipeline_coverage: pipelineCoverage,
      llm_role_telemetry: roleTelemetry,
      relay_recovery: recovery,
    },
  );
  let reviewArtifactError: string | null = null;
  try {
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "evals/make-review-csv.ts", reviewQueuePath, reviewCsvPath], { stdio: "inherit" });
  } catch (error) {
    // Human-review convenience files are auxiliary. The durable queue remains available and a
    // malformed spreadsheet export must never convert a valid core A1 run into a false failure.
    reviewArtifactError = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ review CSV 未生成（核心评测不受影响）：${reviewArtifactError}`);
  }
  console.log(
    "\n人工指标（脚本无法自动算）：\n" +
      "  · 非显然洞察占比 ≥ 60%、幻觉率 ≤ 2%\n" +
      `  → 见 ${join(workspace.finalDir, "review-queue.json")}，逐条人评后回填。`,
  );

  // ── 样本量提示 ──
  if (smoke) {
    console.log(
      `\n⚠️ 子集冒烟：主题 ${qualityCases.length}/${qualityAll.length}、一致性对 ${consistencyCases.length}/${consistencyAll.length}` +
        `、展示覆盖 ${displayCoverageCases.length}/${displayCoverageAll.length}、quote 自足性 ${quoteSelfContainedCases.length}/${quoteSelfContainedAll.length}。\n` +
        "   结果仅用于验证真模型链路 + 标定成本，不作 A1 / DCP 判定依据。去掉 A1_*_LIMIT 跑全量才出结论。",
    );
  } else if (samplePrerequisite) {
    console.log(
      `\n⚠️ ${samplePrerequisite}。\n` +
        "   当前结论仅验证管线打通，不作 DCP 判定依据。请用真实采集数据扩充数据集后重跑。",
    );
  }

  // ── 回归门（eval-criteria：任一指标较基线降 >3pp 告警/阻断）。各 stratum 各比各的基线段。
  // baseline-registry.json is the executable two-run approval source. The legacy aggregate
  // baseline is historical context only and can never certify the changed contract. ──
  let regressed = false;
  let baselineComparison: "comparable" | "incomparable" | "not_evaluated" = "not_evaluated";
  if (!coreComplete) {
    console.log("\n（核心评测不完整，跳过 baseline 回归对照）");
  } else {
    let registryDoc: unknown = null;
    try {
      registryDoc = JSON.parse(readFileSync("evals/baseline-registry.json", "utf8"));
    } catch {
      console.log("\n（未读取到 baseline registry；正式回归对照不可比）");
    }
    baselineComparison = "incomparable";
    const TOL = 0.03;
    let everyActiveStratumComparable = activeStrata.length > 0;
    if (!activeStrata.length) console.log("\n回归对照：⚠️ 没有完成任何质量/一致性形态，不能作可比结论。");
    for (const s of activeStrata) {
      const expectedMetricKeys = rowsByStratum[s].map((row) => row.key);
      const base = comparableRegistryBaselineMetrics(registryDoc, s, evalConfig, expectedMetricKeys);
      if (!base) {
        everyActiveStratumComparable = false;
        console.log(`\n回归对照（${s}）：⚠️ 缺少已批准、同配置的基线指标，不能作回归结论。`);
        continue;
      }
      console.log(`\n回归对照（${s} · vs baseline-registry.json）：`);
      for (const r of rowsByStratum[s]) {
        const b = base[r.key];
        const delta = r.value - b;
        // info 指标仅打印漂移、不触回归门（其红线由 blocking 守，非本指标）
        const isReg = r.op !== "info" && (r.op === ">=" ? delta < -TOL : delta > TOL);
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
    if (everyActiveStratumComparable) baselineComparison = "comparable";
  }

  const failed = allRows.filter((r) => !r.pass);
  console.log(`\n自动门槛：${allRows.length - failed.length}/${allRows.length} 通过。`);
  // 空护栏：无任何可评指标（所有主题失败 + 零一致性对）= 跑批彻底失败，必须判红、不得当通过
  // （与重构前等价：原版恒 6 行、空数据下四项算 0 → FAIL → exit 1）。
  if (!allRows.length) console.log("❌ 无任何可评指标（所有主题失败 + 零一致性对）——判失败，非通过。");
  // 冒烟只证明链路能跑，刻意不把不完整子集的类别缺失当作质量失败；全量仍严格执行阈值与回归门。
  let exitCode: number;
  let autoGate: "pass" | "fail" | "smoke" | "not_evaluated";
  if (!coreComplete) {
    exitCode = 1;
    autoGate = "not_evaluated";
  } else if (smoke) {
    const qualityPathSucceeded = qualityCases.length === 0 || qualitySucceeded > 0;
    const judgePathSucceeded = consistencyCases.length === 0 || judgeSucceeded > 0;
    if (allRows.length && qualityPathSucceeded && judgePathSucceeded) {
      console.log("冒烟模式：忽略质量阈值退出码；请查看 artifact，不能据此更新基线或签发布门。");
      exitCode = 0;
      autoGate = "smoke";
    } else {
      console.log(
        `❌ 冒烟链路未完整跑通（analyzer+validator ${qualitySucceeded}/${qualityCases.length} 主题成功，` +
          `一致性校验 ${judgeSucceeded}/${consistencyCases.length} 对成功）。`,
      );
      exitCode = 1;
      autoGate = "fail";
    }
  } else {
    // A green automatic threshold result may be promoted into the two-run registry, but it is
    // not an Eval-Gate pass until a comparable approved baseline exists.
    const automaticThresholdsPass = activeStrata.length > 0 && Boolean(allRows.length) && failed.length === 0 && !regressed;
    autoGate = automaticThresholdsPass ? "pass" : "fail";
    exitCode = formalA1GateExitCode(automaticThresholdsPass, activeStrata.length, baselineComparison === "comparable" ? "comparable" : "incomparable");
    if (automaticThresholdsPass && baselineComparison !== "comparable") {
      console.log("❌ 自动阈值已通过，但缺少已批准的同配置 baseline；正式 Eval-Gate 仍阻断，不能据此合入。");
    }
  }

  const dcpPrerequisites = [
    ...(baselineComparison !== "comparable" ? ["缺少同配置的可比 baseline"] : []),
    ...(smoke ? ["当前为 smoke 子集运行"] : []),
    ...(samplePrerequisite ? [samplePrerequisite] : []),
    ...(!datasetLock.promotion_eligible ? [`dataset lock 不具备 v2 提升资格：${datasetLock.issues.join("；") || datasetLock.status}`] : []),
    "人工 review queue 尚未完成",
  ];
  const dcpEligibleForManualReview = autoGate === "pass" && dcpPrerequisites.length === 1;

  const artifactPaths = {
    "a1-run.json": a1RunPath,
    "review-queue.json": reviewQueuePath,
    "quality-checkpoint.json": activeQualityCheckpointPath!,
    ...(reviewArtifactError ? {} : { "review.csv": reviewCsvPath }),
  };
  updateA1Progress({
    state: "completed", phase: "finalizing", topic_timeout_ms: topicTimeoutMs,
    judge_timeout_ms: judgeTimeoutMs, coverage_timeout_ms: coverageTimeoutMs,
    completed: { quality_cases: qualitySucceeded, consistency_cases: judgeSucceeded },
  });
  const progressPath = join(workspace.tempDir, "progress.json");
  finalizeA1Run(workspace, {
    run_id: workspace.runId,
    status: "completed",
    auto_gate: autoGate,
    manual_review: "pending",
    dcp_eligibility: dcpEligibleForManualReview ? "pending_manual_review" : "ineligible",
    started_at: workspace.startedAt,
    ended_at: new Date().toISOString(),
    config: activeRunContext.config,
    dataset: activeRunContext.dataset,
    source: activeRunContext.source,
    ...(activeResumeCheckpointSha256 ? { resumed_from_checkpoint_sha256: activeResumeCheckpointSha256 } : {}),
    baseline_comparison: baselineComparison,
    dcp_sample: dcpSample,
    dcp_prerequisites: dcpPrerequisites,
    relay_recovery: recovery,
    llm_role_telemetry: roleTelemetry,
    insights: insightManifest(allInsights),
    artifacts: {
      ...Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, sha256File(path)])),
      "progress.json": sha256File(progressPath),
    },
    ...(reviewArtifactError ? { review_artifact_error: reviewArtifactError } : {}),
  });
  activeWorkspace = null;
  activeProgress = null;
  activeQualityCheckpointPath = null;
  activeResumeCheckpointSha256 = null;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("A1 验证运行出错：", err);
  finalizeActiveA1Failure(err);
  process.exit(1);
});

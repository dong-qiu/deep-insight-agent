/** 定时管线编排（architecture「系统 cron + 容器内进程」的被触发端）。
 *  一次完整跑：采集所有启用 Source → 源健康自愈 → 按启用 Topic 切窗口内 ContentItem → 分析→校验→生成 brief。
 *  每个 Source / Topic 独立 try/catch，单点失败不连累其余（与 collector / validateBatch 的韧性一致）。
 *  由 /api/cron 触发（系统 cron / supercronic 定时 curl）；含真模型调用，需 ANTHROPIC_API_KEY。
 *  待分析项选择见 analysis-selection.ts；源健康自愈（熔断/半开/零产出）见 source-health.ts。 */
import { getEffectiveSources, loadStaticConfig } from "../config/index.js";
import type { DB } from "../db/index.js";
import { finishRun, getTopic, listTopics } from "../db/repos.js";
import { freezeDueMetricDay } from "../db/p1-metrics-facts.js";
import { claimSourceCollectTrace, createScheduledSourceCollectTrace, createScheduledTraceRequest, sourceCollectTracingAvailable } from "../db/provenance.js";
import { appendGenerationEvent } from "../db/provenance-facts.js";
import { listRecentBriefEvents, previousReportForTopic, topicHasReport, type ReportAnchorPublication } from "../db/reports.js";
import { notifyBudget } from "../runtime/alert.js";
import { getBudgetStatus } from "../runtime/cost-guard.js";
import { runLogger } from "../runtime/logger.js";
import type { Report } from "../types.js";
import { collectSource } from "./collector.js";
import { briefFreshHours, briefFreshQuota, contentObservedAt, selectAnalysisItems } from "./analysis-selection.js";
import { runCircuitCheck, runHalfOpenProbe, runZeroYieldWatch } from "./source-health.js";
import { runAnalysis, runReportGen, runTechLeadExtraction, runValidation } from "./pipeline.js";

export interface ScheduleSummary {
  startedAt: string;
  finishedAt: string;
  windowHours: number;
  collected: Array<{ source: string; traceId?: string; status?: "done" | "replayed" | "conflict"; fetched?: number; inserted?: number; updated?: number; error?: string }>;
  topics: Array<{ topic: string; items: number; traceId?: string; reportId?: string; included?: number; status: string; type?: Report["type"] }>;
  errors: string[];
  /** 成本预算触顶 → 本轮剩余 topic 被自动熔断跳过（A5）；未配预算或未触顶时省略。 */
  budgetStopped?: boolean;
  /** 本轮被系统熔断停采的源 id（ADR-0008 决定②）：正常处置、不计入 errors（评审）。 */
  circuitOpened?: string[];
  /** 本轮半开探测成功、自动复活的源 id（切片3b-2）。 */
  circuitRevived?: string[];
  /** 本轮触发零产出告警的源 id（切片3b-3）。 */
  zeroYield?: string[];
}

/** 可独立触发的采集周期。日报在出刊前仍会采一次，额外周期只执行这一段，绝不重复 LLM 分析/出刊。 */
export interface CollectionSummary {
  startedAt: string;
  finishedAt: string;
  collected: ScheduleSummary["collected"];
  errors: string[];
  circuitOpened?: string[];
  circuitRevived?: string[];
  zeroYield?: string[];
}

export interface GenerationExecutionOptions {
  traceId?: string;
  rootRunId?: string;
  /** durable scheduled dispatch 固化的选择窗口右边界；完整重跑不得改用当前时间。 */
  windowEnd?: string;
  assertWrite?: () => void;
  /** Supplied only by the deployment composition root. */
  anchor?: ReportAnchorPublication;
}

/** 冷启动决策（纯函数，可测）：topic 无历史报告 → 首版综述 initial_digest（更宽窗口 / 更多条，
 *  给新主题一份有份量的首报）；否则按常规 reportType（brief / deep_dive）。 */
export function reportPlan(
  cold: boolean,
  warm: { type: "brief" | "deep_dive"; windowHours: number; items: number },
  coldCfg: { windowHours: number; items: number },
): { type: Report["type"]; windowHours: number; items: number } {
  return cold
    ? { type: "initial_digest", windowHours: coldCfg.windowHours, items: coldCfg.items }
    : { type: warm.type, windowHours: warm.windowHours, items: warm.items };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function utcIsoWeek(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = Math.ceil((((date.getTime() - firstThursday.getTime()) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 采集 + 源健康自愈（熔断 / 半开 / 零产出）。“collect” cron 调此函数，保证每 6h 数据更新
 * 不会把同一天的 Brief 反复重新生成。 */
export async function runCollectionCycle(db: DB): Promise<CollectionSummary> {
  const startedAt = new Date().toISOString();
  const summary: CollectionSummary = { startedAt, finishedAt: startedAt, collected: [], errors: [] };
  // P1b-2 daily buckets freeze exactly once on the first scheduler cycle at/after UTC 02:00.
  freezeDueMetricDay(db, startedAt);
  const sources = getEffectiveSources(db, loadStaticConfig()).filter((s) => s.enabled);
  const traceEnabled = sourceCollectTracingAvailable(db);
  for (const s of sources) {
    try {
      if (!traceEnabled) {
        const r = await collectSource(db, s);
        summary.collected.push({ source: s.id, fetched: r.fetched, inserted: r.inserted, updated: r.updated });
        continue;
      }
      const accepted = createScheduledSourceCollectTrace(db, { sourceId: s.id });
      if (accepted.kind === "replayed") {
        summary.collected.push({ source: s.id, traceId: accepted.traceId, status: "replayed" });
        continue;
      }
      if (accepted.kind === "conflict") {
        summary.collected.push({ source: s.id, traceId: accepted.activeTraceId, status: "conflict" });
        continue;
      }
      const claim = claimSourceCollectTrace(db, accepted.traceId);
      if (!claim) throw new Error("source_collect_claim_lost");
      const r = await collectSource(db, s, { traceClaim: claim });
      summary.collected.push({ source: s.id, traceId: accepted.traceId, status: "done", fetched: r.fetched, inserted: r.inserted, updated: r.updated });
    } catch (e) {
      summary.collected.push({ source: s.id, error: errMsg(e) });
      summary.errors.push(`collect ${s.id}: ${errMsg(e)}`);
    }
  }

  const circuit = runCircuitCheck(db, sources);
  if (circuit.opened.length) summary.circuitOpened = circuit.opened;
  summary.errors.push(...circuit.errors);
  const halfOpen = await runHalfOpenProbe(db, collectSource);
  if (halfOpen.revived.length) summary.circuitRevived = halfOpen.revived;
  summary.errors.push(...halfOpen.errors);
  const zeroYield = runZeroYieldWatch(db, sources);
  if (zeroYield.zeroYield.length) summary.zeroYield = zeroYield.zeroYield;
  summary.errors.push(...zeroYield.errors);
  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** 触发一次完整管线。库为空时 getEffectiveSources 会先播种默认 Topic/Source（首跑自举）。 */
export async function runScheduledPipeline(
  db: DB,
  opts: { windowHours?: number; itemsPerTopic?: number; reportType?: "brief" | "deep_dive" } = {},
): Promise<ScheduleSummary> {
  const startedAt = new Date().toISOString();
  const windowHours = opts.windowHours ?? Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const itemsPerTopic = opts.itemsPerTopic ?? (Number(process.env.PIPELINE_ITEMS_PER_TOPIC) || 15);
  const reportType = opts.reportType ?? "brief"; // 每日 brief / 周报 deep_dive（cron 按周期传入）
  // 冷启动（topic 无历史报告）→ 首版综述：更宽窗口 + 更多条，给新主题有份量的首报
  const coldWindowHours = Number(process.env.INITIAL_DIGEST_WINDOW_HOURS) || 720; // 30 天
  const coldItems = Number(process.env.INITIAL_DIGEST_ITEMS) || 25;
  const end = Date.now();
  const endIso = new Date(end).toISOString();

  const summary: ScheduleSummary = {
    startedAt,
    finishedAt: startedAt,
    windowHours,
    collected: [],
    topics: [],
    errors: [],
  };

  // 1. 出刊前先采一轮；额外 collect cron 复用同一函数但不会走后续 LLM/report 路径。
  const collection = await runCollectionCycle(db);
  summary.collected = collection.collected;
  summary.errors.push(...collection.errors);
  summary.circuitOpened = collection.circuitOpened;
  summary.circuitRevived = collection.circuitRevived;
  summary.zeroYield = collection.zeroYield;

  // 2-4. 每个启用 Topic：冷启动决策 → 分析→校验→生成报告（首版综述 / brief / deep_dive）
  // A5 自动熔断：每个 topic 前查预算，触顶则跳过本 topic 及之后全部（过冲上界 = 单 topic 一轮）。
  // 成本在每段 Run 完成后即落库，故此处拿到的是近实时已花额。告警每进程去重（cron 每 6h 一跑 → ≤4 条/天）。
  let budgetStopped = false;
  let budgetAlerted = false;
  for (const topic of listTopics(db, { enabledOnly: true })) {
    if (!budgetStopped) {
      const budget = getBudgetStatus(db);
      if (budget.verdict === "exceeded") {
        budgetStopped = true;
        summary.budgetStopped = true;
        notifyBudget({
          verdict: "exceeded", reason: budget.reason ?? "成本预算触顶",
          spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "auto",
        });
      } else if (budget.verdict === "alert" && !budgetAlerted) {
        budgetAlerted = true;
        notifyBudget({
          verdict: "alert", reason: budget.reason ?? "成本预算接近上限",
          spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "auto",
        });
      }
    }
    if (budgetStopped) {
      summary.topics.push({ topic: topic.id, items: 0, status: "skipped-budget-exceeded" });
      continue;
    }
    const plan = reportPlan(
      !topicHasReport(db, topic.id),
      { type: reportType, windowHours, items: itemsPerTopic },
      { windowHours: coldWindowHours, items: coldItems },
    );
    try {
      const period = plan.type === "brief" ? endIso.slice(0, 10) : plan.type === "deep_dive" ? utcIsoWeek(new Date(end)) : "initial";
      const accepted = createScheduledTraceRequest(db, {
        topicId: topic.id, reportType: plan.type, period,
        windowHours: plan.windowHours, items: plan.items,
      });
      summary.topics.push({
        topic: topic.id, items: 0, traceId: accepted.kind === "conflict" ? accepted.activeTraceId : accepted.traceId,
        status: accepted.kind === "accepted" ? "queued" : accepted.kind, type: plan.type,
      });
    } catch (e) {
      summary.topics.push({ topic: topic.id, items: 0, status: `failed: ${errMsg(e)}`, type: plan.type });
      summary.errors.push(`pipeline ${topic.id}: ${errMsg(e)}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

/** Worker 执行一个已登记的 cron topic pipeline；collection 仍由 cron 先完成，
 * 此处只消费被持久化的计划，从而避免 cron Web 请求与报告生成脱离 trace。 */
export async function runScheduledTopicPipeline(
  db: DB,
  topicId: string,
  input: { reportType: "brief" | "deep_dive" | "initial_digest"; windowHours: number; items: number } & GenerationExecutionOptions,
): Promise<Report | null> {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error(`topic ${topicId} 不存在`);
  if (!topic.enabled) throw new Error(`topic ${topicId} 已停用`);
  const end = input.windowEnd == null ? Date.now() : Date.parse(input.windowEnd);
  if (!Number.isFinite(end)) throw new Error("invalid_scheduled_dispatch_window_end");
  const endIso = new Date(end).toISOString();
  const since = new Date(end - input.windowHours * 3_600_000).toISOString();
  const freshnessSince = new Date(end - briefFreshHours() * 3_600_000).toISOString();
  const items = selectAnalysisItems(db, topic, {
    since, until: endIso, limit: input.items, coldStart: input.reportType === "initial_digest",
    freshness: input.reportType === "brief" ? { since: freshnessSince, quota: briefFreshQuota() } : undefined,
  });
  if (!items.length) {
    if (!input.rootRunId) throw new Error("scheduled dispatch missing root Run");
    db.transaction(() => {
      input.assertWrite?.();
      finishRun(db, input.rootRunId!, { status: "done", cost: null, duration_ms: 0 });
      if (input.traceId) {
        appendGenerationEvent(db, {
          trace_id: input.traceId, stage: "select", event_type: "skipped", reason_code: "no_content",
          metrics: { selected_count: 0 },
        });
      }
    })();
    return null;
  }
  if (input.traceId) {
    input.assertWrite?.();
    appendGenerationEvent(db, {
      trace_id: input.traceId, stage: "select", event_type: "completed",
      metrics: { selected_count: items.length },
    });
  }
  const history = input.reportType === "brief" ? listRecentBriefEvents(db, topic.id) : [];
  const batch = await runAnalysis(db, topic, items, { start: since, end: endIso }, {
    history, traceId: input.traceId, rootRunId: input.rootRunId, assertWrite: input.assertWrite,
  });
  const validation = await runValidation(db, batch, items, { traceId: input.traceId, assertWrite: input.assertWrite });
  try {
    runTechLeadExtraction(db, batch, validation, endIso, { traceId: input.traceId, assertWrite: input.assertWrite });
  } catch (e) {
    runLogger({ stage: "tech-leads" }).warn({ topicId: topic.id, batchId: batch.id, err: errMsg(e) }, "技术线索派生失败，继续生成报告");
  }
  const prevReportId = previousReportForTopic(db, topic.id, input.reportType);
  const freshItems = input.reportType === "brief" ? items.filter((item) => contentObservedAt(item) >= freshnessSince) : [];
  const freshestCandidateAt = freshItems.map(contentObservedAt).sort().at(-1) ?? null;
  return runReportGen(db, {
    topic, batch, validation, type: input.reportType, prevReportId, traceId: input.traceId, assertWrite: input.assertWrite,
    briefFreshness: freshItems.length ? { since: freshnessSince, content_item_ids: freshItems.map((item) => item.id), freshest_candidate_at: freshestCandidateAt } : undefined,
    anchor: input.anchor,
  });
}

/** 单主题端到端跑（C-1 用户触发深挖）：
 *  - 不做全局 collect（cron 已每 6h 跑，深挖不应再灌全源）；
 *  - 强制 reportType=deep_dive（不走冷启动 initial_digest 重写，"深挖"语义就要深，不要首版综述）；
 *  - 窗口默认更宽 / 条数更多（与默认 brief 区分）；
 *  - 单步失败 → 抛出（不像 runScheduledPipeline 包裹），让调用方决定告警/记录。
 *  - 复用 runAnalysis/runValidation/runReportGen 三个 Job Runner——管理看板 /admin 自然能看进度。
 *
 *  @throws
 *  - `Error("topic X 不存在")` —— topicId 找不到对应 topic；
 *  - `Error("topic X 已停用")` —— topic.enabled=false；
 *  - `Error("窗口 Nh 内无可分析内容…")` —— selectAnalysisItems 返空；
 *  - runAnalysis/runValidation/runReportGen 内部任一 runJob 抛出的错误（被 runJob 落 failed Run + notifyFailure）。
 *
 *  @remark
 *  fire-and-forget 调用方（如 `/api/topics/[id]/deep-dive`）**必须** `void p.then(_, e => log)`
 *  显式 catch reject，否则 Node runtime 下未处理 promise rejection 会触发 unhandledRejection 警告。 */
export async function runPipelineForTopic(
  db: DB,
  topicId: string,
  opts: { windowHours?: number; items?: number } & GenerationExecutionOptions = {},
): Promise<Report> {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error(`topic ${topicId} 不存在`);
  if (!topic.enabled) throw new Error(`topic ${topicId} 已停用，启用后再深挖`);

  // A5 手动路径：预算触顶不硬拦（深挖是用户主动意图，保留应急能力），但记日志 + 告警一次（放行但提示，见 decisions）。
  const budget = getBudgetStatus(db);
  if (budget.verdict === "exceeded") {
    runLogger({ stage: "deep-dive" }).warn(
      { spentToday: budget.spentToday, spentMonth: budget.spentMonth },
      `成本预算已触顶仍放行手动深挖：${budget.reason ?? ""}`,
    );
    notifyBudget({
      verdict: "exceeded", reason: budget.reason ?? "成本预算触顶",
      spentToday: budget.spentToday, spentMonth: budget.spentMonth, context: "manual",
    });
  }

  // 深挖窗口对齐 spec report-generation.md:27「最近 90 天」（#19 / ADR-0004）。成本由 itemsLimit
  // 封顶（selectAnalysisItems 排序后取前 N，候选池更大只是选得更准），不随窗口宽度线性涨，故可放宽。
  const windowHours = opts.windowHours ?? (Number(process.env.DEEP_DIVE_WINDOW_HOURS) || 2160); // 90 天
  const itemsLimit = opts.items ?? (Number(process.env.DEEP_DIVE_ITEMS) || 25);
  const end = Date.now();
  const endIso = new Date(end).toISOString();
  const since = new Date(end - windowHours * 3_600_000).toISOString();

  // ADR-0010：与定时路径口径一致——topic 首报（无历史报告）豁免 archetype 硬下限，给足份量首报；
  // 已有历史的深挖则套用 horizontal 相关性过滤（用户要的是相关深挖、非噪声）。floor-empty 保护防 0 条。
  const items = selectAnalysisItems(db, topic, {
    since, limit: itemsLimit, coldStart: !topicHasReport(db, topic.id),
  });
  if (items.length === 0) {
    throw new Error(`窗口 ${windowHours}h 内无可分析内容（请先触发 /api/cron 采集或扩大窗口）`);
  }

  const batch = await runAnalysis(db, topic, items, { start: since, end: endIso }, { traceId: opts.traceId, rootRunId: opts.rootRunId, assertWrite: opts.assertWrite });
  const validation = await runValidation(db, batch, items, { traceId: opts.traceId, assertWrite: opts.assertWrite });
  // 规划派生是 non-blocking：保留报告主链路，即使线索阶段失败也由 trace 记录为可解释的 partial。
  try { runTechLeadExtraction(db, batch, validation, endIso, { traceId: opts.traceId, assertWrite: opts.assertWrite }); } catch (error) {
    runLogger({ stage: "tech-leads" }).warn({ topicId: topic.id, batchId: batch.id, err: errMsg(error) }, "深挖技术线索派生失败，继续生成报告");
  }
  const prevReportId = previousReportForTopic(db, topic.id, "deep_dive");
  return runReportGen(db, { topic, batch, validation, type: "deep_dive", prevReportId, traceId: opts.traceId, assertWrite: opts.assertWrite, anchor: opts.anchor });
}

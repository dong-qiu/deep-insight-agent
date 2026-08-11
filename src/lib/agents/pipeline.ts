/** 管线编排：把 analyzer / validator 接进 Job Runner 并落库（architecture 数据流 2→3）。
 *  纯落库与状态机逻辑见 db/analysis.ts、runtime/jobs.ts（可无 key 测）；本文件含真模型调用，
 *  端到端需 ANTHROPIC_API_KEY，由团队/定时任务跑。 */
import type { DB } from "../db/index.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import {
  analysisCacheEnabled, analysisCacheReadEnabled, instantiateCachedInsights,
  isFullReanalyzeToday, lookupCachedInsights, recordAnalysisCache,
} from "../db/analysis-cache.js";
import { makeConsistencyCache } from "../db/consistency-cache.js";
import { getContentItem, getSource } from "../db/repos.js";
import { listRecentPublishedEventEvidence, saveFailedReport, saveReport } from "../db/reports.js";
import { notifyBriefAcceptance, notifyFailure, notifyReport } from "../runtime/alert.js";
import { runJob } from "../runtime/jobs.js";
import type { AnalysisBatch, ContentItem, Report, TechLead, Topic, ValidationResult } from "../types.js";
import { upsertTechLeads } from "../db/tech-leads.js";
import { listTopicDirections, seedDefaultDirections, upsertTechnologyOpportunities } from "../db/planning.js";
import { analyze, analyzerCacheVersion, type HistoricalEvent } from "./analyzer.js";
import { buildReport, reportHighlights, summarizeBriefSelection, type BriefFreshness, type CitationDisplay } from "./report-gen.js";
import { consistencyCacheVersion, isValidationDegraded, validateBatch } from "./validator.js";
import { extractLeadCandidates } from "./tech-leads.js";
import { deriveOpportunityCandidates } from "./opportunity-planning.js";
import { appendGenerationEvent, captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import {
  contentItemRef, contentItemRevisionSnapshot, techLeadRef, techLeadRevisionSnapshot,
  technologyOpportunityRef, technologyOpportunityRevisionSnapshot, topicDirectionRef, topicDirectionRevisionSnapshot,
} from "../db/provenance-revisions.js";

function contentRefs(items: ContentItem[]): EntityRef[] {
  return items.map((item) => contentItemRef(item));
}

/** 只在阶段已开始且可被失败事件包住后，才固化输入快照。
 * revision 冲突必须让 trace 留下 started + failed，而不是在阶段开始前静默中断。 */
function captureContentRevisions(db: DB, items: ContentItem[], refs: EntityRef[], assertWrite?: () => void): void {
  db.transaction(() => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const ref = refs[index];
      assertWrite?.();
      captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot: {
        ...contentItemRevisionSnapshot(item),
      } });
    }
  })();
}

function traceFailureReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message === "provenance_revision_conflict"
    ? "provenance_revision_conflict"
    : fallback;
}

function emitTrace(db: DB, traceId: string | undefined, input: Omit<Parameters<typeof appendGenerationEvent>[1], "trace_id">, assertWrite?: () => void): void {
  if (traceId) {
    assertWrite?.();
    appendGenerationEvent(db, { ...input, trace_id: traceId });
  }
}

/** 分析某主题某窗口的 ContentItem → AnalysisBatch 落库；包一条 analyze Run（含成本）。
 *  成本经 analyze 的 onCost 回调按返回值透传给本 Run 的 ctx.recordCost —— 并发隔离，不读全局 meter 做差。 */
export async function runAnalysis(
  db: DB,
  topic: Topic,
  items: ContentItem[],
  window: { start: string; end: string },
  opts: { history?: HistoricalEvent[]; traceId?: string; rootRunId?: string; assertWrite?: () => void } = {},
): Promise<AnalysisBatch> {
  const inputs = opts.traceId ? contentRefs(items) : [];
  emitTrace(db, opts.traceId, { stage: "analyze", event_type: "started", input_refs: inputs }, opts.assertWrite);
  try {
  if (opts.traceId) captureContentRevisions(db, items, inputs, opts.assertWrite);
  const { result } = await runJob(db, { kind: "analyze", target: { topic_id: topic.id }, traceId: opts.traceId, existingRunId: opts.rootRunId, assertWrite: opts.assertWrite }, async (ctx) => {
    const version = analyzerCacheVersion();
    const history = opts.history ?? [];
    let batch: AnalysisBatch;
    let newInsightsForCache: AnalysisBatch["insights"];
    // 切片2c：读路径已开 **且** 今天不是周期全析日 → 走增量；全析日临时绕过读路径全量析（兜底捞跨条综合）。
    if (analysisCacheReadEnabled() && !isFullReanalyzeToday()) {
      // ADR-0009 切片2（据缓存跳过重析）：只把**未命中**（新 item / content_hash 变了）喂 analyzer；
      // 命中的复用缓存洞察、实例化进本 batch（重生 id + 按当前 history 重判 is_followup）。LLM 只跑 miss。
      // ⚠️ 跨条综合（新 item × 旧 item）会丢——靠周期性全析兜底（切片2c：FULL_REANALYZE 时关闭读路径全析）。
      const { hits, missItems } = lookupCachedInsights(db, topic.id, items, version);
      batch = await analyze(topic, missItems, window, ctx.recordCost, { history });
      newInsightsForCache = [...batch.insights]; // 本轮真析产出（写缓存用），须在追加复用洞察前快照
      const instantiated = instantiateCachedInsights(hits, batch.id, history, batch.insights.length);
      batch.insights.push(...instantiated);
      batch.no_significant_event = batch.insights.length === 0;
    } else {
      batch = await analyze(topic, items, window, ctx.recordCost, { history });
      newInsightsForCache = batch.insights;
    }
    if (opts.traceId) {
      const ref: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: batch.id }, revision: batch.id, role: "output" };
      saveAnalysisBatch(db, batch, () => {
        opts.assertWrite?.();
        captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot: { topic_id: batch.topic_id, time_window: batch.time_window, no_significant_event: batch.no_significant_event, insight_count: batch.insights.length } });
        emitTrace(db, opts.traceId, { stage: "analyze", event_type: "completed", input_refs: inputs, output_refs: [ref], metrics: {
          input_content_count: items.length, analysis_insight_count: batch.insights.length,
          no_significant_event: batch.no_significant_event ? 1 : 0,
        } }, opts.assertWrite);
      });
    } else { opts.assertWrite?.(); saveAnalysisBatch(db, batch); }
    // 写缓存（切片1，写路径默认开）：对全部 item 按键 upsert（命中++ 计度量 + 刷 last_seen），
    // insights_json 取**本轮真析产出**（miss 的新洞察；命中键 ON CONFLICT 不覆写、复用洞察不重记）。
    // recordAnalysisCache 内部全捕获、绝不连累管线。
    if (analysisCacheEnabled()) {
      opts.assertWrite?.();
      recordAnalysisCache(db, topic.id, items, newInsightsForCache, version);
    }
    return batch;
  });
  return result;
  } catch (error) {
    emitTrace(db, opts.traceId, { stage: "analyze", event_type: "failed", input_refs: inputs, error: { reason_code: traceFailureReason(error, "analysis_failed") } }, opts.assertWrite);
    throw error;
  }
}

/** 校验某批次洞察 → ValidationResult 落库；包一条 validate Run（含成本，按返回值透传）。 */
export async function runValidation(
  db: DB,
  batch: AnalysisBatch,
  items: ContentItem[],
  opts: { traceId?: string; assertWrite?: () => void } = {},
): Promise<ValidationResult> {
  const batchRef: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: batch.id }, revision: batch.id, role: "input" };
  const inputs = [batchRef, ...(opts.traceId ? contentRefs(items) : [])];
  emitTrace(db, opts.traceId, { stage: "validate", event_type: "started", input_refs: inputs }, opts.assertWrite);
  try {
  if (opts.traceId) captureContentRevisions(db, items, inputs.slice(1), opts.assertWrite);
  const { result } = await runJob(db, { kind: "validate", target: { batch_id: batch.id }, traceId: opts.traceId, assertWrite: opts.assertWrite }, async (ctx) => {
    // 跨批一致性缓存：relay 抖动重跑 / 报告重生成时复用已判定，省重复 Opus 校验（只缓存成功判定）。
    // 按 (模型+prompt) 版本隔离 + TTL（见 db/consistency-cache.ts）；CONSISTENCY_CACHE=0 可整体关闭（出事时的运维开关）。
    const cache =
      process.env.CONSISTENCY_CACHE === "0" ? undefined : makeConsistencyCache(db, consistencyCacheVersion());
    const vr = await validateBatch(batch.insights, items, ctx.recordCost, cache);
    if (opts.traceId) {
      const ref: EntityRef = { type: "validation_result", locator: { kind: "composite", key: { batch_id: batch.id } }, revision: batch.id, role: "output" };
      saveValidationResult(db, batch.id, vr, () => {
        opts.assertWrite?.();
        captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot: { batch_id: batch.id, releasable: vr.report.releasable, total: vr.report.total, pass: vr.report.pass, blocked: vr.report.blocked, flagged: vr.report.flagged, checks: vr.checks.map(({ insight_id, citation_index, verdict }) => ({ insight_id, citation_index, verdict })) } });
        emitTrace(db, opts.traceId, { stage: "validate", event_type: "completed", input_refs: inputs, output_refs: [ref], metrics: {
          citation_total: vr.report.total, citation_pass: vr.report.pass, citation_blocked: vr.report.blocked,
          citation_flagged: vr.report.flagged, citation_errored: vr.report.errored,
          includable_insight_count: vr.report.insights_includable, releasable: vr.report.releasable ? 1 : 0,
        } }, opts.assertWrite);
      });
    } else { opts.assertWrite?.(); saveValidationResult(db, batch.id, vr); }
    // 抗抖告警：一致性调用大面积失败（疑似 LLM/中转站抖动）→ 主动告警，别让一整轮失败默默缺刊/记假数据。
    // 非致命：Run 仍 done（部分校验结果有效、已落库）；运维收到告警后重跑整管线即恢复（见 validator-uncertain-storms）。
    if (isValidationDegraded(vr.checks)) {
      notifyFailure({
        runId: ctx.runId, kind: "validate", target: { batch_id: batch.id },
        errorType: "ValidationDegraded",
        message: `一致性校验大面积失败：${vr.report.errored} 条调用失败（疑似 LLM/中转站抖动）；本批多数洞察未成功校验，重跑管线恢复。`,
      });
    }
    return vr;
  });
  return result;
  } catch (error) {
    emitTrace(db, opts.traceId, { stage: "validate", event_type: "failed", input_refs: inputs, error: { reason_code: traceFailureReason(error, "validation_failed") } }, opts.assertWrite);
    throw error;
  }
}

/** 技术线索 V1：从本批已成功校验的引用确定性派生。没有 LLM 调用、没有新事实文本；
 * 与 report-gen 同样只消费校验白名单，但独立持久化，日报空刊也不会丢失合格线索。 */
export function runTechLeadExtraction(
  db: DB,
  batch: AnalysisBatch,
  validation: ValidationResult,
  now = new Date().toISOString(),
  opts: { traceId?: string; assertWrite?: () => void } = {},
): TechLead[] {
  const items = new Map<string, ContentItem>();
  for (const insight of batch.insights) for (const citation of insight.citations) {
    if (!items.has(citation.content_item_id)) {
      const item = getContentItem(db, citation.content_item_id);
      if (item) items.set(item.id, item);
    }
  }
  const batchRef: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: batch.id }, revision: batch.id, role: "input" };
  emitTrace(db, opts.traceId, { stage: "derive_lead", event_type: "started", input_refs: [batchRef] }, opts.assertWrite);
  let leads: TechLead[];
  try {
    opts.assertWrite?.();
    leads = db.transaction(() => {
      const written = upsertTechLeads(db, extractLeadCandidates(batch, validation, items, now), now);
      if (opts.traceId) {
        const refs = written.map((lead) => techLeadRef(lead, "output"));
        opts.assertWrite?.();
        for (let i = 0; i < written.length; i += 1) captureRevision(db, { entity_type: refs[i].type, entity_key: entityKey(refs[i]), revision: refs[i].revision, snapshot: techLeadRevisionSnapshot(written[i]) });
        emitTrace(db, opts.traceId, { stage: "derive_lead", event_type: "completed", input_refs: [batchRef], output_refs: refs }, opts.assertWrite);
      }
      return written;
    })();
  } catch (error) {
    emitTrace(db, opts.traceId, { stage: "derive_lead", event_type: "failed", input_refs: [batchRef], error: { reason_code: "derive_lead_failed" } }, opts.assertWrite);
    throw error;
  }
  // 两个投影阶段均 non-blocking：失败不回滚已提交 Lead，也不阻断日报。
  const leadRefs = opts.traceId ? leads.map((lead) => techLeadRef(lead)) : [];
  let candidates: ReturnType<typeof deriveOpportunityCandidates>;
  let directionRefs: EntityRef[] = [];
  try {
    emitTrace(db, opts.traceId, { stage: "map_direction", event_type: "started", input_refs: leadRefs }, opts.assertWrite);
    opts.assertWrite?.();
    seedDefaultDirections(db);
    const directions = listTopicDirections(db, { topic: batch.topic_id });
    directionRefs = opts.traceId ? directions.map((direction) => topicDirectionRef(direction)) : [];
    candidates = deriveOpportunityCandidates(leads, directions, now);
    if (opts.traceId) db.transaction(() => {
      opts.assertWrite?.();
      for (let i = 0; i < directions.length; i += 1) captureRevision(db, { entity_type: directionRefs[i].type, entity_key: entityKey(directionRefs[i]), revision: directionRefs[i].revision, snapshot: topicDirectionRevisionSnapshot(directions[i]) });
      emitTrace(db, opts.traceId, { stage: "map_direction", event_type: "completed", input_refs: [...leadRefs, ...directionRefs], metrics: { candidate_count: candidates.length } }, opts.assertWrite);
    })();
  } catch (error) {
    emitTrace(db, opts.traceId, { stage: "map_direction", event_type: "failed", error: { reason_code: "map_direction_failed" } }, opts.assertWrite);
    console.warn("⚠️ 技术机会投影失败（不影响技术线索与报告）", error);
    return leads;
  }
  try {
    const inputs = [...leadRefs, ...directionRefs];
    emitTrace(db, opts.traceId, { stage: "derive_opportunity", event_type: "started", input_refs: inputs }, opts.assertWrite);
    opts.assertWrite?.();
    const opportunities = db.transaction(() => {
      const written = upsertTechnologyOpportunities(db, candidates, new Map(leads.map((lead) => [lead.id, lead])), now);
      if (opts.traceId) {
        const refs = written.map((opportunity) => technologyOpportunityRef(opportunity, "output"));
        for (let i = 0; i < written.length; i += 1) captureRevision(db, { entity_type: refs[i].type, entity_key: entityKey(refs[i]), revision: refs[i].revision, snapshot: technologyOpportunityRevisionSnapshot(written[i]) });
        emitTrace(db, opts.traceId, { stage: "derive_opportunity", event_type: "completed", input_refs: inputs, output_refs: refs, metrics: { opportunity_count: written.length } }, opts.assertWrite);
      }
      return written;
    })();
  } catch (error) {
    emitTrace(db, opts.traceId, { stage: "derive_opportunity", event_type: "failed", error: { reason_code: "derive_opportunity_failed" } }, opts.assertWrite);
    console.warn("⚠️ 技术机会投影失败（不影响技术线索与报告）", error);
  }
  return leads;
}

/** 生成报告 → 落库（FS 正文 + 索引 + FTS）；包一条 report-gen Run。确定性，无 LLM 成本。 */
export async function runReportGen(
  db: DB,
  opts: {
    topic: Topic;
    batch: AnalysisBatch;
    validation: ValidationResult;
    type: Report["type"];
    prevReportId?: string | null;
    briefFreshness?: BriefFreshness;
    traceId?: string;
    assertWrite?: () => void;
  },
): Promise<Report> {
  const batchRef: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: opts.batch.id }, revision: opts.batch.id, role: "input" };
  const validationRef: EntityRef = { type: "validation_result", locator: { kind: "composite", key: { batch_id: opts.batch.id } }, revision: opts.batch.id, role: "input" };
  emitTrace(db, opts.traceId, { stage: "generate_report", event_type: "started", input_refs: [batchRef, validationRef] }, opts.assertWrite);
  // 为被引内容建展示元数据查找表：source_id / tags（派生 source_ids / tags）
  // + source_name / url / published_at（dogfood feedback：渲染时给用户可读源名 + 可点 quote）
  const contentLookup = new Map<string, CitationDisplay>();
  for (const ins of opts.batch.insights) {
    for (const c of ins.citations) {
      if (contentLookup.has(c.content_item_id)) continue;
      const ci = getContentItem(db, c.content_item_id);
      if (!ci) continue;
      const src = getSource(db, ci.source_id);
      contentLookup.set(c.content_item_id, {
        source_id: ci.source_id,
        source_name: src?.name ?? ci.source_id,
        tags: ci.tags,
        url: ci.url,
        published_at: ci.published_at,
        observed_at: ci.published_at ?? ci.fetched_at,
      });
    }
  }
  try {
  const { result } = await runJob(
    db,
    { kind: "report-gen", target: { topic_id: opts.topic.id, batch_id: opts.batch.id }, traceId: opts.traceId, assertWrite: opts.assertWrite },
    async () => {
      // 质量红线：非空批次没有任何 support/pass 引用时，不得把"无重要事件"伪装成成功。
      // 失败尝试保留独立 Report（无正文/index/FTS），随后抛出使 report-gen Run 与 trace 都进入 failed。
      if (!opts.validation.report.releasable && !opts.batch.no_significant_event) {
        opts.assertWrite?.();
        saveFailedReport(db, {
          type: opts.type, topic_id: opts.topic.id, generated_at: new Date().toISOString(),
          title: `${opts.topic.name} · 报告生成失败`, insight_ids: opts.batch.insights.map((insight) => insight.id),
          event_ids: opts.batch.insights.flatMap((insight) => insight.event_id ? [insight.event_id] : []),
          prev_report_id: opts.prevReportId ?? null, citation_count: 0, cost: { tokens: 0, amount: 0 },
          reasonCode: "no_releasable_insight",
          afterSave: opts.traceId ? (id) => {
            opts.assertWrite?.();
            const ref: EntityRef = { type: "report", locator: { kind: "id", id }, revision: id, role: "output" };
            captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot: { id, type: opts.type, topic_id: opts.topic.id, status: "failed", reason_code: "no_releasable_insight", insight_count: opts.batch.insights.length } });
            emitTrace(db, opts.traceId, { stage: "generate_report", event_type: "failed", input_refs: [batchRef, validationRef], output_refs: [ref], error: { reason_code: "no_releasable_insight" } }, opts.assertWrite);
          } : undefined,
        });
        throw new Error("no_releasable_insight");
      }
      // 只对 Daily Brief 读取已发布基线：缓存命中洞察仍会重校验，
      // 但同 event 无新增成功证据时不得再次进入用户可见报告。
      const publishedEventEvidence = opts.type === "brief"
        ? listRecentPublishedEventEvidence(db, opts.topic.id)
        : [];
      const selection = summarizeBriefSelection(
        opts.batch, opts.validation, opts.type, publishedEventEvidence, opts.briefFreshness,
      );
      const { report, index } = buildReport({
        topic: opts.topic,
        batch: opts.batch,
        validation: opts.validation,
        type: opts.type,
        contentLookup,
        publishedEventEvidence,
        briefFreshness: opts.briefFreshness,
        prevReportId: opts.prevReportId,
      });
      let traceOutputCaptured = false;
      const emptyReason = report.insight_ids.length === 0
        ? opts.batch.no_significant_event
          ? "no_significant_event"
          : selection.summary.freshness_filtered_insight_count > 0 || selection.summary.already_published_filtered_insight_count > 0
            ? "no_new_publishable_insight"
            : "no_publishable_insight"
        : undefined;
      opts.assertWrite?.();
      saveReport(db, report, index, {
        afterPublish: opts.traceId ? () => {
          opts.assertWrite?.();
          const ref: EntityRef = { type: "report", locator: { kind: "id", id: report.id }, revision: report.id, role: "output", visibility_class: "public_evidence" };
          captureRevision(db, { entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision, snapshot: { id: report.id, type: report.type, topic_id: report.topic_id, status: "done", insight_ids: report.insight_ids, citation_count: report.citation_count, event_ids: report.event_ids } });
          emitTrace(db, opts.traceId, { stage: "generate_report", event_type: "completed", reason_code: emptyReason, input_refs: [batchRef, validationRef], output_refs: [ref], metrics: { ...selection.summary } }, opts.assertWrite);
          traceOutputCaptured = true;
        } : undefined,
      });
      notifyBriefAcceptance({
        report, traceId: opts.traceId, traceOutputCaptured,
        expectedInsightIds: selection.included.map((x) => x.insight.id),
        expectedCitationCount: selection.summary.published_citation_count,
        reasonCode: emptyReason,
      });
      // 报告推送（B）：落库后主动推给用户（REPORT_PUSH=1 opt-in；空 brief 自动跳过）。
      // 非阻塞、永不抛——放 saveReport 之后，推送失败绝不影响已落库报告 / Run done。
      // 推送要点（复用报告选取/排序，与 index.highlights 同源同序）：让邮件/webhook 展示可扫读的
      // 分级要点，取代扁平 summary。只取 text/key（渲染够用），importance 排序已在 reportHighlights 内完成。
      const highlights = reportHighlights(opts.batch, opts.validation, {
        type: opts.type, publishedEventEvidence, freshness: opts.briefFreshness,
      }).map(({ text, key }) => ({ text, key }));
      notifyReport({
        id: report.id,
        type: report.type,
        title: report.title,
        summary: index.summary,
        topicName: opts.topic.name,
        citationCount: report.citation_count,
        insightCount: report.insight_ids.length,
        highlights,
      });
      return report;
    },
  );
  return result;
  } catch (error) {
    // no_releasable_insight 已和 failed Report 在同一事务写入，避免二次 event 造成不同 payload 的幂等冲突。
    if (!(error instanceof Error) || error.message !== "no_releasable_insight") {
      emitTrace(db, opts.traceId, { stage: "generate_report", event_type: "failed", input_refs: [batchRef, validationRef], error: { reason_code: "report_generation_failed" } }, opts.assertWrite);
    }
    throw error;
  }
}

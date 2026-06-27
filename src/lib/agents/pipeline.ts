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
import { saveReport } from "../db/reports.js";
import { notifyFailure, notifyReport } from "../runtime/alert.js";
import { runJob } from "../runtime/jobs.js";
import type { AnalysisBatch, ContentItem, Report, Topic, ValidationResult } from "../types.js";
import { analyze, analyzerCacheVersion, type HistoricalEvent } from "./analyzer.js";
import { buildReport, type CitationDisplay } from "./report-gen.js";
import { consistencyCacheVersion, isValidationDegraded, validateBatch } from "./validator.js";

/** 分析某主题某窗口的 ContentItem → AnalysisBatch 落库；包一条 analyze Run（含成本）。
 *  成本经 analyze 的 onCost 回调按返回值透传给本 Run 的 ctx.recordCost —— 并发隔离，不读全局 meter 做差。 */
export async function runAnalysis(
  db: DB,
  topic: Topic,
  items: ContentItem[],
  window: { start: string; end: string },
  opts: { history?: HistoricalEvent[] } = {},
): Promise<AnalysisBatch> {
  const { result } = await runJob(db, { kind: "analyze", target: { topic_id: topic.id } }, async (ctx) => {
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
    saveAnalysisBatch(db, batch);
    // 写缓存（切片1，写路径默认开）：对全部 item 按键 upsert（命中++ 计度量 + 刷 last_seen），
    // insights_json 取**本轮真析产出**（miss 的新洞察；命中键 ON CONFLICT 不覆写、复用洞察不重记）。
    // recordAnalysisCache 内部全捕获、绝不连累管线。
    if (analysisCacheEnabled()) {
      recordAnalysisCache(db, topic.id, items, newInsightsForCache, version);
    }
    return batch;
  });
  return result;
}

/** 校验某批次洞察 → ValidationResult 落库；包一条 validate Run（含成本，按返回值透传）。 */
export async function runValidation(
  db: DB,
  batch: AnalysisBatch,
  items: ContentItem[],
): Promise<ValidationResult> {
  const { result } = await runJob(db, { kind: "validate", target: { batch_id: batch.id } }, async (ctx) => {
    // 跨批一致性缓存：relay 抖动重跑 / 报告重生成时复用已判定，省重复 Opus 校验（只缓存成功判定）。
    // 按 (模型+prompt) 版本隔离 + TTL（见 db/consistency-cache.ts）；CONSISTENCY_CACHE=0 可整体关闭（出事时的运维开关）。
    const cache =
      process.env.CONSISTENCY_CACHE === "0" ? undefined : makeConsistencyCache(db, consistencyCacheVersion());
    const vr = await validateBatch(batch.insights, items, ctx.recordCost, cache);
    saveValidationResult(db, batch.id, vr);
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
  },
): Promise<Report> {
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
      });
    }
  }
  const { result } = await runJob(
    db,
    { kind: "report-gen", target: { topic_id: opts.topic.id, batch_id: opts.batch.id } },
    async () => {
      const { report, index } = buildReport({
        topic: opts.topic,
        batch: opts.batch,
        validation: opts.validation,
        type: opts.type,
        contentLookup,
        prevReportId: opts.prevReportId,
      });
      saveReport(db, report, index);
      // 报告推送（B）：落库后主动推给用户（REPORT_PUSH=1 opt-in；空 brief 自动跳过）。
      // 非阻塞、永不抛——放 saveReport 之后，推送失败绝不影响已落库报告 / Run done。
      notifyReport({
        id: report.id,
        type: report.type,
        title: report.title,
        summary: index.summary,
        topicName: opts.topic.name,
        citationCount: report.citation_count,
        insightCount: report.insight_ids.length,
      });
      return report;
    },
  );
  return result;
}

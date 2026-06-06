/** 管线编排：把 analyzer / validator 接进 Job Runner 并落库（architecture 数据流 2→3）。
 *  纯落库与状态机逻辑见 db/analysis.ts、runtime/jobs.ts（可无 key 测）；本文件含真模型调用，
 *  端到端需 ANTHROPIC_API_KEY，由团队/定时任务跑。 */
import type { DB } from "../db/index.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { getContentItem, getSource } from "../db/repos.js";
import { saveReport } from "../db/reports.js";
import { runJob } from "../runtime/jobs.js";
import type { AnalysisBatch, ContentItem, Report, Topic, ValidationResult } from "../types.js";
import { analyze } from "./analyzer.js";
import { buildReport, type CitationDisplay } from "./report-gen.js";
import { validateBatch } from "./validator.js";

/** 分析某主题某窗口的 ContentItem → AnalysisBatch 落库；包一条 analyze Run（含成本）。
 *  成本经 analyze 的 onCost 回调按返回值透传给本 Run 的 ctx.recordCost —— 并发隔离，不读全局 meter 做差。 */
export async function runAnalysis(
  db: DB,
  topic: Topic,
  items: ContentItem[],
  window: { start: string; end: string },
): Promise<AnalysisBatch> {
  const { result } = await runJob(db, { kind: "analyze", target: { topic_id: topic.id } }, async (ctx) => {
    const batch = await analyze(topic, items, window, ctx.recordCost);
    saveAnalysisBatch(db, batch);
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
    const vr = await validateBatch(batch.insights, items, ctx.recordCost);
    saveValidationResult(db, batch.id, vr);
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
      return report;
    },
  );
  return result;
}

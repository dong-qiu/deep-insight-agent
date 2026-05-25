/** 管线编排：把 analyzer / validator 接进 Job Runner 并落库（architecture 数据流 2→3）。
 *  纯落库与状态机逻辑见 db/analysis.ts、runtime/jobs.ts（可无 key 测）；本文件含真模型调用，
 *  端到端需 ANTHROPIC_API_KEY，由团队/定时任务跑。 */
import type { DB } from "../db/index.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { getContentItem } from "../db/repos.js";
import { saveReport } from "../db/reports.js";
import { type CostReport, getCostReport } from "../runtime/llm.js";
import { runJob } from "../runtime/jobs.js";
import type { AnalysisBatch, ContentItem, Report, Topic, ValidationResult } from "../types.js";
import { analyze } from "./analyzer.js";
import { buildReport } from "./report-gen.js";
import { validateBatch } from "./validator.js";

const totalTokens = (r: CostReport): number => r.byModel.reduce((s, m) => s + m.input + m.output, 0);

/** 本次跑相对快照的成本增量（Cost Meter 是累计值）。 */
function costSince(before: CostReport) {
  const after = getCostReport();
  return { tokens: totalTokens(after) - totalTokens(before), amount: after.totalUSD - before.totalUSD };
}

/** 分析某主题某窗口的 ContentItem → AnalysisBatch 落库；包一条 analyze Run（含成本）。 */
export async function runAnalysis(
  db: DB,
  topic: Topic,
  items: ContentItem[],
  window: { start: string; end: string },
): Promise<AnalysisBatch> {
  const { result } = await runJob(db, { kind: "analyze", target: { topic_id: topic.id } }, async (ctx) => {
    const before = getCostReport();
    const batch = await analyze(topic, items, window);
    ctx.recordCost(costSince(before));
    saveAnalysisBatch(db, batch);
    return batch;
  });
  return result;
}

/** 校验某批次洞察 → ValidationResult 落库；包一条 validate Run（含成本）。 */
export async function runValidation(
  db: DB,
  batch: AnalysisBatch,
  items: ContentItem[],
): Promise<ValidationResult> {
  const { result } = await runJob(db, { kind: "validate", target: { batch_id: batch.id } }, async (ctx) => {
    const before = getCostReport();
    const vr = await validateBatch(batch.insights, items);
    ctx.recordCost(costSince(before));
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
  // 为被引内容建 source_id / tags 查找表（派生 source_ids / tags 用）
  const contentLookup = new Map<string, { source_id: string; tags: string[] }>();
  for (const ins of opts.batch.insights) {
    for (const c of ins.citations) {
      if (contentLookup.has(c.content_item_id)) continue;
      const ci = getContentItem(db, c.content_item_id);
      if (ci) contentLookup.set(c.content_item_id, { source_id: ci.source_id, tags: ci.tags });
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

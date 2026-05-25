/** 管线编排：把 analyzer / validator 接进 Job Runner 并落库（architecture 数据流 2→3）。
 *  纯落库与状态机逻辑见 db/analysis.ts、runtime/jobs.ts（可无 key 测）；本文件含真模型调用，
 *  端到端需 ANTHROPIC_API_KEY，由团队/定时任务跑。 */
import type { DB } from "../db/index.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { type CostReport, getCostReport } from "../runtime/llm.js";
import { runJob } from "../runtime/jobs.js";
import type { AnalysisBatch, ContentItem, Topic, ValidationResult } from "../types.js";
import { analyze } from "./analyzer.js";
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

/** PPT 导出 orchestrator：从 reportId 一次性读齐 PPT 所需输入，跑 buildPptx 拿 Buffer 给 API route。
 *
 *  纳入口径与 selectInsights 一致——只取明确 support 的 verdict=pass 引用——
 *  保证导出页面与报告正文同口径，避免"PPT 显示了报告里看不到的引用"这种倒挂。 */
import type { DB } from "../db/index.js";
import { getAnalysisBatch, getValidationResult } from "../db/analysis.js";
import { getReport } from "../db/reports.js";
import { getSource, getTopic } from "../db/repos.js";
import type { AnalysisBatch, Report, Topic, ValidationResult } from "../types.js";
import { DISPLAY_PROJECTION_VERSION } from "../utils/source-quote-projection.js";
import { selectInsights } from "../agents/report-gen.js";
import { buildPptx, type IncludedInsightLite, type PptGenOutput } from "./ppt-gen.js";

export interface PptExportResult extends PptGenOutput {
  report: Report;
  topic: Topic;
  /** 响应兼容字段；v6 不运行 LLM 润色，恒为 0。 */
  polishCost: { tokens: number; amount: number };
  /** v6 恒为 "none"：自由 LLM 改写不属于 reader-visible 原文。 */
  polishCache: "none" | "hit" | "miss";
  /** v6 恒为 "none"。 */
  polishStatus: "none" | "complete" | "no-executive" | "partial";
  /** v6 恒为零覆盖。 */
  polishCoverage: { perInsightDone: number; perInsightTotal: number; hasExecutive: boolean };
  /** v6 恒为 false。 */
  polishAborted: boolean;
  /** v6 不运行 polish，恒为 0。 */
  polishCostCapUsd: number;
  /** 文件名：`{topic.name} · {generated_at[:10]}.pptx`（替换文件系统非法字符） */
  fileName: string;
}

export interface PptExportOptions {
  /** 兼容旧 API；v6 忽略，以避免把自由 LLM 改写显示为来源事实。 */
  usePolish?: boolean;
  /** 兼容旧 API；v6 忽略。 */
  refresh?: boolean;
}

/** 一次性读齐 report + insights + citations + checks + sources + topic，
 *  按报告 `insight_ids` 过滤并应用 pass/support 白名单，返 PPT 输入所需结构。 */
function loadPptInput(
  db: DB,
  reportId: string,
): { report: Report; topic: Topic; insights: IncludedInsightLite[]; citationSourceByCi: Map<string, { sourceName: string; url: string }> } | null {
  const report = getReport(db, reportId);
  if (!report) return null;
  const topic = getTopic(db, report.topic_id);
  if (!topic) throw new Error(`报告 ${reportId} 的 topic ${report.topic_id} 不存在`);

  const insights: IncludedInsightLite[] = [];
  const readerVisibleByBatch = new Map<string, Map<string, IncludedInsightLite>>();
  for (const id of report.insight_ids) {
    const row = db.prepare("SELECT batch_id FROM insight WHERE id = ?").get(id) as { batch_id: string } | undefined;
    if (!row) continue; // 防御：报告引用了已删除的 insight，跳过不抛
    let readerVisible = readerVisibleByBatch.get(row.batch_id);
    if (!readerVisible) {
      const batch: AnalysisBatch | null = getAnalysisBatch(db, row.batch_id);
      const validation: ValidationResult | null = getValidationResult(db, row.batch_id);
      // PPT is a new public derivative. Historical report text may remain readable, but a legacy
      // batch must not be re-exported as a fresh, v6-verified deck.
      const selected = batch?.display_coverage_state === "audited" && batch.display_projection_version === DISPLAY_PROJECTION_VERSION && validation
        ? selectInsights(batch, validation)
        : [];
      readerVisible = new Map(selected.map((entry) => [entry.insight.id, {
        insight: entry.insight, citationIndices: entry.citationIndices,
        flaggedUncertain: entry.flaggedUncertain, flaggedError: entry.flaggedError,
      }]));
      readerVisibleByBatch.set(row.batch_id, readerVisible);
    }
    const reader = readerVisible.get(id);
    if (reader) insights.push(reader);
  }

  // Every deck-visible quote needs its own content-item URL, not merely a de-duplicated source
  // label.  Invalid URLs are intentionally omitted; buildPptx then fail-closes that item.
  const citationSourceByCi = new Map<string, { sourceName: string; url: string }>();
  const usedCi = new Set<string>(
    insights.flatMap((x) => x.citationIndices.map((i) => x.insight.citations[i].content_item_id)),
  );
  for (const ciId of usedCi) {
    const ciRow = db.prepare("SELECT source_id,url FROM content_item WHERE id = ?").get(ciId) as
      | { source_id: string; url: string }
      | undefined;
    if (!ciRow) continue;
    const src = getSource(db, ciRow.source_id);
    if (!src) continue;
    if (/^https?:\/\//i.test(ciRow.url)) citationSourceByCi.set(ciId, { sourceName: src.name, url: ciRow.url });
  }

  return { report, topic, insights, citationSourceByCi };
}

/** 生成安全文件名：替换跨平台禁用字符（/ \\ : * ? " < > |）+ 折叠多余空白 + 长度上限。
 *  空格、中文、emoji 在 Win/macOS/Linux 上都合法，无需替换。 */
function safeFileName(topicName: string, generatedAt: string): string {
  const date = generatedAt.slice(0, 10);
  const safe = topicName
    .replace(/[\\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${safe} · ${date}.pptx`;
}

/** PPT 导出主入口：只输出审核过的一条原文与受控重要性判断；不运行或显示 LLM 润色。 */

export async function exportReportPptx(
  db: DB,
  reportId: string,
  opts: PptExportOptions = {},
): Promise<PptExportResult | null> {
  // `usePolish`/`refresh` remain accepted for API compatibility, but reader-visible v6 decks
  // cannot show free LLM rewrites as if they were source facts.
  void opts;
  const loaded = loadPptInput(db, reportId);
  if (!loaded) return null;
  const { report, topic, insights, citationSourceByCi } = loaded;

  const out = await buildPptx({
    report,
    insights,
    topic,
    citationSourceByCi,
  });

  return {
    ...out,
    report,
    topic,
    polishCost: { tokens: 0, amount: 0 },
    polishCache: "none",
    polishStatus: "none",
    polishCoverage: { perInsightDone: 0, perInsightTotal: 0, hasExecutive: false },
    polishAborted: false,
    polishCostCapUsd: 0,
    fileName: safeFileName(topic.name, report.generated_at),
  };
}

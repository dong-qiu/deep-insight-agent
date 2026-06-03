/** PPT 导出 orchestrator（C 阶段）：从 reportId 一次性读齐 PPT 所需输入，可选 LLM 润色，
 *  跑 buildPptx 拿 Buffer 给 API route。
 *
 *  纳入口径与 selectInsights 一致——只取 verdict=pass / flagged 的引用；blocked/未校验一律剔除——
 *  保证导出页面与报告正文同口径，避免"PPT 显示了报告里看不到的引用"这种倒挂。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DB } from "../db/index.js";
import { getReport } from "../db/reports.js";
import { getSource, getTopic } from "../db/repos.js";
import type { Insight, Report, Topic } from "../types.js";
import { buildPptx, type IncludedInsightLite, type PptGenOutput } from "./ppt-gen.js";
import { polishForPpt, type PolishResult } from "./ppt-polish.js";

export interface PptExportResult extends PptGenOutput {
  report: Report;
  topic: Topic;
  /** LLM 润色累计成本（usePolish=false 或全失败时 amount=0） */
  polishCost: { tokens: number; amount: number };
  /** 文件名：`{topic.name} · {generated_at[:10]}.pptx`（替换文件系统非法字符） */
  fileName: string;
}

export interface PptExportOptions {
  /** 启用 B 阶段 LLM 润色（§1 凝练 + §3 启示 + Executive 页）；缺省 false（A 即时导出） */
  usePolish?: boolean;
}

/** 一次性读齐 report + insights + citations + checks + sources + topic，
 *  按报告 `insight_ids` 过滤并应用 pass/flagged 白名单，返 PPT 输入所需结构。 */
function loadPptInput(
  db: DB,
  reportId: string,
): { report: Report; topic: Topic; insights: IncludedInsightLite[]; sourceNameByCi: Map<string, string>; sourceNameById: Map<string, string> } | null {
  const report = getReport(db, reportId);
  if (!report) return null;
  const topic = getTopic(db, report.topic_id);
  if (!topic) throw new Error(`报告 ${reportId} 的 topic ${report.topic_id} 不存在`);

  const insights: IncludedInsightLite[] = [];
  for (const id of report.insight_ids) {
    const row = db.prepare("SELECT * FROM insight WHERE id = ?").get(id) as any;
    if (!row) continue; // 防御：报告引用了已删除的 insight，跳过不抛
    const cits = db
      .prepare("SELECT * FROM citation WHERE insight_id = ? ORDER BY citation_index")
      .all(id) as any[];
    const insight: Insight = {
      id: row.id,
      topic_id: row.topic_id,
      type: row.type,
      event_id: row.event_id ?? null,
      statement: row.statement,
      importance: row.importance,
      importance_basis: row.importance_basis,
      citations: cits.map((c) => ({
        content_item_id: c.content_item_id,
        quote: c.quote,
        locator: JSON.parse(c.locator),
      })),
      source_count: row.source_count,
      multi_source: !!row.multi_source,
      time_window: JSON.parse(row.time_window),
      confidence: row.confidence,
      language: row.language,
    };
    // 白名单（与 selectInsights 同口径）：pass/flagged 纳入；blocked/无 check 剔除
    const checks = db
      .prepare("SELECT citation_index, verdict FROM citation_check WHERE insight_id = ?")
      .all(id) as { citation_index: number; verdict: string }[];
    const vMap = new Map(checks.map((c) => [c.citation_index, c.verdict]));
    const kept: number[] = [];
    let flagged = false;
    insight.citations.forEach((_, i) => {
      const v = vMap.get(i);
      if (v === "pass" || v === "flagged") {
        kept.push(i);
        if (v === "flagged") flagged = true;
      }
    });
    if (kept.length > 0) insights.push({ insight, citationIndices: kept, flagged });
  }

  // 源名映射：ci → source_id → source.name；同时建 source_id → name（供"源与方法"页）
  const sourceNameByCi = new Map<string, string>();
  const sourceNameById = new Map<string, string>();
  const usedCi = new Set<string>(
    insights.flatMap((x) => x.citationIndices.map((i) => x.insight.citations[i].content_item_id)),
  );
  for (const ciId of usedCi) {
    const ciRow = db.prepare("SELECT source_id FROM content_item WHERE id = ?").get(ciId) as
      | { source_id: string }
      | undefined;
    if (!ciRow) continue;
    const src = getSource(db, ciRow.source_id);
    if (!src) continue;
    sourceNameByCi.set(ciId, src.name);
    sourceNameById.set(src.id, src.name);
  }

  return { report, topic, insights, sourceNameByCi, sourceNameById };
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

/** PPT 导出主入口：load → optional polish → buildPptx → return result。
 *  - usePolish=false（默认）：即时返、零 LLM 成本；§1/§3 走 A 确定性 fallback；
 *  - usePolish=true：N 条重点 + 1 executive 并发跑 LLM，~10s + ~\$0.07/PPT；
 *    任一 LLM 失败 → 该项 A fallback、不阻断导出（polishForPpt 内部已 try/catch）。 */
export async function exportReportPptx(
  db: DB,
  reportId: string,
  opts: PptExportOptions = {},
): Promise<PptExportResult | null> {
  const loaded = loadPptInput(db, reportId);
  if (!loaded) return null;
  const { report, topic, insights, sourceNameByCi, sourceNameById } = loaded;

  let polish: PolishResult | undefined;
  let polishCost = { tokens: 0, amount: 0 };
  if (opts.usePolish) {
    const KEY_IMPORTANCE = 4;
    const key = insights.filter((x) => x.insight.importance >= KEY_IMPORTANCE);
    const result = await polishForPpt(key, topic);
    polish = result;
    polishCost = result.cost;
  }

  const out = await buildPptx({
    report,
    insights,
    topic,
    sourceNameByCi,
    sourceNameById,
    polish: polish ? { perInsight: polish.perInsight, executive: polish.executive } : undefined,
  });

  return {
    ...out,
    report,
    topic,
    polishCost,
    fileName: safeFileName(topic.name, report.generated_at),
  };
}

/** PPT 导出 orchestrator（C 阶段）：从 reportId 一次性读齐 PPT 所需输入，可选 LLM 润色，
 *  跑 buildPptx 拿 Buffer 给 API route。
 *
 *  纳入口径与 selectInsights 一致——只取 verdict=pass / flagged 的引用；blocked/未校验一律剔除——
 *  保证导出页面与报告正文同口径，避免"PPT 显示了报告里看不到的引用"这种倒挂。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DB } from "../db/index.js";
import {
  computePolishInputsHash,
  getPolishCacheEntry,
  upsertPolishCacheEntry,
} from "../db/ppt-cache.js";
import { getReport } from "../db/reports.js";
import { getSource, getTopic } from "../db/repos.js";
import type { CitationCheck, Insight, Report, Topic } from "../types.js";
import { isIncludableCheck, isValidationError } from "../utils/citation-verdict.js";
import { buildPptx, type IncludedInsightLite, type PptGenOutput } from "./ppt-gen.js";
import { polishForPpt, type PolishResult } from "./ppt-polish.js";

export interface PptExportResult extends PptGenOutput {
  report: Report;
  topic: Topic;
  /** 本次 LLM 净支出（cache hit → 0）。不含历史已支付的 polish 成本（见 polishCacheOriginalCost） */
  polishCost: { tokens: number; amount: number };
  /** "none"=未启用 polish；"miss"=本次跑了 LLM；"hit"=复用上次缓存 */
  polishCache: "none" | "hit" | "miss";
  /** 当前生效的 polish 完整度（用于决定是否提示 refresh）：
   *  - "complete": 所有重点条 + executive 全有；
   *  - "no-executive": 重点条全有、executive 缺；
   *  - "partial": 部分重点条缺；
   *  - "none": 未启用 polish。 */
  polishStatus: "none" | "complete" | "no-executive" | "partial";
  /** polish 覆盖度 N/M 透传——complete 时 N=M、有 executive */
  polishCoverage: { perInsightDone: number; perInsightTotal: number; hasExecutive: boolean };
  /** 本次 polish 是否因为累计成本越过 PPT_POLISH_COST_CAP_USD 被硬停（cache hit / 未启用 polish 时恒 false） */
  polishAborted: boolean;
  /** 触发硬停的成本上限（透传给 header，方便用户知道阈值在哪）；usePolish=false 时 0 */
  polishCostCapUsd: number;
  /** 文件名：`{topic.name} · {generated_at[:10]}.pptx`（替换文件系统非法字符） */
  fileName: string;
}

export interface PptExportOptions {
  /** 启用 B 阶段 LLM 润色（§1 凝练 + §3 启示 + Executive 页）；缺省 false（A 即时导出） */
  usePolish?: boolean;
  /** 强制重跑 LLM（忽略既有缓存条目；新结果完整则覆盖写入）。缺省 false。 */
  refresh?: boolean;
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
      .prepare("SELECT citation_index, verdict, consistency FROM citation_check WHERE insight_id = ?")
      .all(id) as Pick<CitationCheck, "citation_index" | "verdict" | "consistency">[];
    const cMap = new Map(checks.map((c) => [c.citation_index, c]));
    const kept: number[] = [];
    let flaggedUncertain = false;
    let flaggedError = false;
    let includable = false;
    insight.citations.forEach((_, i) => {
      const c = cMap.get(i);
      if (c?.verdict === "pass" || c?.verdict === "flagged") {
        kept.push(i);
        // flagged 两类（验证器约定）：校验失败（isValidationError）vs genuine uncertain
        if (c.verdict === "flagged") {
          if (isValidationError(c)) flaggedError = true;
          else flaggedUncertain = true;
        }
        if (isIncludableCheck(c)) includable = true; // 校验失败不计入纳入闸门（与 selectInsights 同口径）
      }
    });
    if (includable) insights.push({ insight, citationIndices: kept, flaggedUncertain, flaggedError });
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
const KEY_IMPORTANCE = 4;
const COST_CAP_DEFAULT_USD = 0.30;

function resolveCostCap(): number {
  const raw = Number(process.env.PPT_POLISH_COST_CAP_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : COST_CAP_DEFAULT_USD;
}

export async function exportReportPptx(
  db: DB,
  reportId: string,
  opts: PptExportOptions = {},
): Promise<PptExportResult | null> {
  const loaded = loadPptInput(db, reportId);
  if (!loaded) return null;
  const { report, topic, insights, sourceNameByCi, sourceNameById } = loaded;

  let polish: { perInsight: PolishResult["perInsight"]; executive: PolishResult["executive"] } | undefined;
  let polishCost = { tokens: 0, amount: 0 };
  let polishCache: "none" | "hit" | "miss" = "none";
  let perInsightTotal = 0;
  let polishAborted = false;
  const costCap = resolveCostCap();

  if (opts.usePolish) {
    polishCache = "miss";
    const key = insights.filter((x) => x.insight.importance >= KEY_IMPORTANCE);
    perInsightTotal = key.length;
    const inputsHash = computePolishInputsHash(topic, key.map((x) => x.insight));

    // 1) 命中缓存（refresh=false 时）：直接复用，零成本
    if (!opts.refresh) {
      const cached = getPolishCacheEntry(db, reportId);
      if (cached && cached.inputsHash === inputsHash) {
        polish = cached.polish;
        polishCache = "hit";
      }
    }

    // 2) 未命中 / refresh：跑 LLM；累计成本越过 costCap → abort 未启动 + in-flight；
    //    与既有缓存 merge（同 hash）后写回；中转站偶发截断时多次 refresh 渐进收敛。
    if (!polish) {
      const controller = new AbortController();
      let running = 0;
      const result = await polishForPpt(key, topic, {
        signal: controller.signal,
        onCost: (delta) => {
          running += delta.amount;
          if (running >= costCap && !controller.signal.aborted) {
            polishAborted = true;
            controller.abort();
            console.warn(
              `  ⚠️ ppt-polish 累计成本 $${running.toFixed(4)} ≥ cap $${costCap.toFixed(2)}（PPT_POLISH_COST_CAP_USD）→ abort 未启动 + in-flight；已成功子结果保留`,
            );
          }
        },
      });
      polishCost = result.cost;

      const existing = getPolishCacheEntry(db, reportId);
      const baseline = existing && existing.inputsHash === inputsHash ? existing.polish : null;
      const merged = {
        perInsight: new Map(baseline?.perInsight ?? []),
        executive: baseline?.executive ?? null,
      };
      for (const [id, p] of result.perInsight) merged.perInsight.set(id, p);
      if (result.executive) merged.executive = result.executive;

      polish = merged;
      const mergedCost = {
        tokens: (existing?.originalCost.tokens ?? 0) + result.cost.tokens,
        amount: (existing?.originalCost.amount ?? 0) + result.cost.amount,
      };
      upsertPolishCacheEntry(db, reportId, inputsHash, merged, mergedCost);
    }
  }

  const perInsightDone = polish?.perInsight.size ?? 0;
  const hasExecutive = polish?.executive != null;
  const polishStatus: PptExportResult["polishStatus"] = !opts.usePolish
    ? "none"
    : perInsightDone < perInsightTotal
      ? "partial"
      : hasExecutive
        ? "complete"
        : "no-executive";

  const out = await buildPptx({
    report,
    insights,
    topic,
    sourceNameByCi,
    sourceNameById,
    polish,
  });

  return {
    ...out,
    report,
    topic,
    polishCost,
    polishCache,
    polishStatus,
    polishCoverage: { perInsightDone, perInsightTotal, hasExecutive },
    polishAborted,
    polishCostCapUsd: opts.usePolish ? costCap : 0,
    fileName: safeFileName(topic.name, report.generated_at),
  };
}

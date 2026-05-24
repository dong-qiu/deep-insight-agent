/**
 * 数据模型 —— 落 `docs/plan/architecture.md`「数据模型」节。
 * 本文件是 A1 验证切片用到的实体子集 + analyzer/validator 的结构化输出 Zod schema。
 * 完整数据模型（Source / Report / ReportIndexEntry / Run 等）待 A1 通过后建骨架时补齐。
 */
import { z } from "zod/v4";

export type Language = "zh" | "en" | "mixed";

/** 采集产出的标准化内容（architecture 数据模型 · ContentItem，A1 切片用子集） */
export interface ContentItem {
  id: string;
  source_id: string;
  url: string;
  title: string;
  published_at: string | null; // ISO；源未提供为 null
  language: Language;
  topic_ids: string[];
  body: string;
}

/** 用户订阅主题（architecture 数据模型 · Topic，A1 切片用子集） */
export interface Topic {
  id: string;
  name: string;
  keywords: string[];
  language: Language;
}

/** 可溯源最小单位（architecture 数据模型 · Citation） */
export interface Citation {
  content_item_id: string;
  quote: string;
  locator: { paragraph_index: number; char_start: number; char_end: number };
}

/** 洞察对象（architecture 数据模型 · Insight） */
export interface Insight {
  id: string;
  topic_id: string;
  type: "aggregation" | "trend";
  event_id: string | null;
  statement: string;
  importance: number; // 1–5
  importance_basis: string;
  citations: Citation[];
  source_count: number;
  multi_source: boolean;
  time_window: { start: string; end: string };
  confidence: "high" | "medium" | "low" | null;
  language: Language;
}

/** 分析批次（architecture 数据模型 · AnalysisBatch） */
export interface AnalysisBatch {
  id: string;
  topic_id: string;
  time_window: { start: string; end: string };
  status: "done" | "failed";
  no_significant_event: boolean;
  insights: Insight[];
}

/** 逐引用校验项（architecture 数据模型 · CitationCheck） */
export interface CitationCheck {
  insight_id: string;
  citation_index: number;
  reachability: "pass" | "fail";
  reachability_reason:
    | "ok"
    | "source_not_found"
    | "source_unreachable"
    | "quote_not_in_source";
  consistency: "support" | "not_support" | "uncertain" | "not_evaluated";
  consistency_reason:
    | "ok"
    | "out_of_context"
    | "exaggeration"
    | "misattribution"
    | "uncertain"
    | "not_evaluated";
  verdict: "pass" | "blocked" | "flagged";
}

/** 整体校验报告（architecture 数据模型 · ValidationReport） */
export interface ValidationReport {
  total: number;
  pass: number;
  blocked: number;
  flagged: number;
  consistency_failure_rate: number; // not_support / total
  flagged_rate: number; // uncertain / total
  releasable: boolean;
}

export interface ValidationResult {
  checks: CitationCheck[];
  report: ValidationReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 结构化输出 schema（只含模型产出的字段；id / locator / source_count /
// multi_source / time_window / language 等在代码侧派生，不让模型编造）
// ─────────────────────────────────────────────────────────────────────────────

/** analyzer 产出的单条引用（仅 content_item_id + 逐字 quote；locator 代码侧算） */
export const LlmCitationSchema = z.object({
  content_item_id: z.string().describe("被引 ContentItem 的 id（必须来自输入清单）"),
  quote: z
    .string()
    .describe("被引原文片段，必须逐字摘录自该 ContentItem 的 body，不得改写"),
});

/** analyzer 产出的单条洞察 */
export const LlmInsightSchema = z.object({
  statement: z.string().describe("结论文本，中性叙述，不预测、不评论"),
  type: z.enum(["aggregation", "trend"]).describe("aggregation=主题聚合 / trend=趋势识别"),
  importance: z.number().int().min(1).max(5).describe("重要性 1–5"),
  importance_basis: z.string().describe("评分依据，须可追溯到证据或规则"),
  confidence: z
    .enum(["high", "medium", "low"])
    .nullable()
    .describe("trend 类必填、aggregation 类填 null"),
  citations: z.array(LlmCitationSchema).min(1).describe("≥1 条引用，无引用不输出该洞察"),
});

/** analyzer 整体输出 */
export const AnalyzerOutputSchema = z.object({
  no_significant_event: z
    .boolean()
    .describe("该窗口无重要事件则为 true，且 insights 为空（诚实兜底，不凑数）"),
  insights: z.array(LlmInsightSchema),
});
export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

/** validator 一致性评判输出 */
export const ConsistencyJudgeSchema = z.object({
  consistency: z
    .enum(["support", "not_support", "uncertain"])
    .describe("原文是否支持该结论"),
  consistency_reason: z
    .enum(["ok", "out_of_context", "exaggeration", "misattribution", "uncertain"])
    .describe("support→ok；not_support→断章取义/夸大/张冠李戴；uncertain→uncertain"),
  rationale: z.string().describe("简短判定理由"),
});
export type ConsistencyJudge = z.infer<typeof ConsistencyJudgeSchema>;

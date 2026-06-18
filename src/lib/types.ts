/**
 * 数据模型 —— 落 `docs/plan/architecture.md`「数据模型」节（单一事实来源）。
 * analyzer/validator 的结构化输出 Zod schema 见文件末。
 */
import { z } from "zod/v4";

export type Language = "zh" | "en" | "mixed";
export type Industry = "ai-swe" | "ai-security";

/** 数据源配置（architecture 数据模型 · Source） */
export interface Source {
  id: string;
  name: string;
  type: "rss" | "arxiv" | "api";
  endpoint: string;
  industry: Industry;
  topic_ids: string[];
  fetch_interval: string; // duration，如 "1h" / "30m"
  backfill: { depth: string; max_cost: number } | null;
  enabled: boolean;
}

/** 用户订阅主题（architecture 数据模型 · Topic） */
export interface Topic {
  id: string;
  name: string;
  keywords: string[];
  industry: Industry;
  language: Language;
  brief_schedule: "daily" | "weekly";
  enabled: boolean;
}

/** 采集产出的标准化内容（architecture 数据模型 · ContentItem） */
export interface ContentItem {
  id: string;
  source_id: string;
  url: string;
  title: string;
  author: string | null;
  published_at: string | null; // ISO；源未提供为 null
  fetched_at: string;
  language: Language;
  topic_ids: string[];
  tags: string[];
  body: string;
  raw_ref: string;
  content_hash: string;
  fetch_status: "ok" | "partial";
}

/** 可溯源最小单位（architecture 数据模型 · Citation） */
export interface Citation {
  content_item_id: string;
  quote: string;
  locator: { paragraph_index: number; char_start: number; char_end: number };
}

/** 实体（product-definition 洞察「实体追踪」：组织/人物/项目/产品维度的动态聚合）。
 *  挂在 Insight 上，由 analyzer 抽取；report-gen 跨洞察聚合进 ReportIndexEntry.entity_names，
 *  主题页按频次展示「关键实体」。 */
export type EntityType = "organization" | "person" | "project" | "product";
export interface Entity {
  name: string;
  type: EntityType;
}

/** 洞察对象（architecture 数据模型 · Insight） */
export interface Insight {
  id: string;
  topic_id: string;
  type: "aggregation" | "trend";
  event_id: string | null;
  statement: string;
  /** 一句话要点（headline 方案）：statement 的 ≤40 字浓缩，结论/数字/主体前置，供列表卡片扫读。
   *  analyzer 产出；缺省 ""（旧库 migration 默认 ''，渲染端回退到 statement）。 */
  headline?: string;
  importance: number; // 1–5
  importance_basis: string;
  citations: Citation[];
  source_count: number;
  multi_source: boolean;
  time_window: { start: string; end: string };
  confidence: "high" | "medium" | "low" | null;
  language: Language;
  /** P1 不复报（2026-06-06）：analyzer 判定本条与历史 brief 同 event_id 时设 true。
   *  spec："同事件的后续进展可作为'更新'再次出现"——is_followup 区分新事件 vs 续报。
   *  缺省 false（旧库 migration 默认 0）。 */
  is_followup?: boolean;
  /** 实体追踪：analyzer 抽取的关键实体（缺省 []；旧库 migration 默认 '[]'）。 */
  entities?: Entity[];
  /** 主题标签：analyzer 抽取的简短主题标签，供报告库「标签」维度筛选（缺省 []；旧库 migration 默认 '[]'）。 */
  tags?: string[];
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
  // consistency=not_evaluated 有两义，按 reachability 区分：
  //  - reachability=fail → 可达性短路未判（verdict=blocked）；
  //  - reachability=pass → 一致性「调用失败」（verdict=flagged，报告标「校验失败·待重试」，
  //    与判官真说 uncertain 区分；见 validator.validateBatch 的 catch 分支）。
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
  total: number; // 引用级（CitationCheck）总数
  pass: number;
  blocked: number;
  // 注意：flagged 与 flagged_rate 度量不同——
  //  flagged = verdict='flagged' 的引用数（含 genuine uncertain + 校验失败两类）；
  //  flagged_rate = consistency='uncertain'/total，只算 genuine uncertain，不含校验失败。
  //  故一般 flagged ≥ flagged_rate×total，两者不应被当作等价（校验失败被刻意排除出 rate，
  //  让 rate 纯表"原文不确定性"而非基础设施抖动）。
  flagged: number;
  errored: number; // 一致性「调用失败」引用数（reachability=pass + consistency=not_evaluated）——高值=LLM/中转站抖动，非内容问题
  consistency_failure_rate: number; // not_support / total
  flagged_rate: number; // genuine uncertain（consistency='uncertain'）/ total——不含校验失败
  insights_total: number; // 有引用被校验的洞察数
  insights_includable: number; // ≥1 条「已成功校验」引用（pass/genuine uncertain）的洞察数（= report-gen 实际纳入数；校验失败不算）
  releasable: boolean; // 洞察级：insights_includable ≥ 1（空批次诚实放行）
}

export interface ValidationResult {
  checks: CitationCheck[];
  report: ValidationReport;
}

export interface Cost {
  tokens: number;
  amount: number;
}

/** 报告对象（architecture 数据模型 · Report） */
export interface Report {
  id: string;
  type: "brief" | "deep_dive" | "initial_digest";
  topic_id: string;
  status: "draft" | "generating" | "done" | "failed" | "archived" | "deleted";
  generated_at: string;
  title: string;
  body_md: string;
  body_html: string;
  insight_ids: string[];
  event_ids: string[];
  prev_report_id: string | null;
  citation_count: number;
  cost: Cost;
}

/** 追问回答里的一条已校验引用（followup-qa spec）。
 *  ref = 引用池编号（保留池序，被剥离的 ref 不出现，编号可有空位）。 */
export interface FollowupCitation {
  ref: number;
  content_item_id: string;
  quote: string;
  source_name: string;
  url: string;
  published_at: string | null;
}

/** 报告页内追问的一问一答（architecture：报告页 A4 入口；DB 表 followup_qa）。
 *  thread_id / turn_index 为多轮升级预留（v1 单轮：thread_id=自身id，turn_index=0）。 */
export interface FollowupQA {
  id: string;
  report_id: string;
  thread_id: string;
  turn_index: number;
  question: string;
  answer_md: string;
  citations_used: FollowupCitation[];
  /** 引用级校验计数（透明信任信号） */
  validation: {
    total: number;
    reachable: number;
    consistent: number;
    blocked: number;
    errored: number;
  };
  cost: Cost;
  status: "done" | "failed";
  created_at: string;
}

/** 报告索引项（architecture 数据模型 · ReportIndexEntry）—— 落 SQLite 行 + FTS5 */
export interface ReportIndexEntry {
  report_id: string;
  type: Report["type"];
  topic_id: string;
  industry: Industry;
  date: string;
  source_ids: string[];
  title: string;
  summary: string;
  /** 卡片要点列表（headline 方案）：纳入洞察的一句话 headline，按重要性降序取前 N，供列表卡片
   *  分点扫读（取代把多条 statement 拼成一坨的 summary）。空数组 → 渲染端回退到 summary。
   *  旧报告 migration 默认 '[]'（重生报告写正确值）。 */
  highlights: string[];
  tags: string[];
  entity_names: string[];
  importance: number;
  event_ids: string[];
  /** 里程碑洞察计数（ADR-0006）：本报告纳入的洞察中 importance≥5 + 非追加 + aggregation 的条数。
   *  >0 即在主题页标「里程碑」徽标 + 进里程碑时间线。旧报告 migration 默认 0。 */
  milestone_count: number;
  /** 全文搜索命中片段（仅 queryReportIndex 带 q 时填充，瞬时展示字段、不落库）：
   *  来自 FTS5 snippet()，命中词以 … 标记包裹，渲染端拆出加 <mark>。 */
  snippet?: string;
}

/** 运行实体（architecture 数据模型 · Run）—— Job Runner 状态追踪 */
export interface Run {
  id: string;
  kind: "ingest" | "analyze" | "validate" | "report-gen";
  target: { topic_id?: string; source_id?: string; batch_id?: string; report_id?: string };
  status: "running" | "done" | "failed";
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  cost: Cost | null;
  error: { type: string; message: string; stack?: string } | null;
  retry_of: string | null;
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
  headline: z
    .string()
    .describe(
      "一句话要点（≤40 字），供列表卡片快速扫读：把最关键的结论/数字/主体放句首，去掉铺垫与从句；须是 statement 的忠实浓缩，不得引入 statement 没有的事实、不得放大。",
    ),
  type: z.enum(["aggregation", "trend"]).describe("aggregation=主题聚合 / trend=趋势识别"),
  importance: z.number().int().min(1).max(5).describe("重要性 1–5"),
  importance_basis: z.string().describe("评分依据，须可追溯到证据或规则"),
  confidence: z
    .enum(["high", "medium", "low"])
    .nullable()
    .describe("trend 类必填、aggregation 类填 null"),
  citations: z.array(LlmCitationSchema).min(1).describe("≥1 条引用，无引用不输出该洞察"),
  event_id: z
    .string()
    .nullable()
    .describe(
      "事件标识。判定与历史 brief（user 消息后附『已报告事件』清单）的某个 event 同一现实事件时，复用该 event_id 字符串并设 is_followup=true；否则置 null（代码侧生成新 event_id）。",
    ),
  is_followup: z
    .boolean()
    .describe(
      "true=本条是已报告事件的『新进展/更新』（必须复用历史 event_id 且包含实质新信息）；false=新事件（必置 event_id=null）。",
    ),
  entities: z
    .array(
      z.object({
        name: z.string().describe("实体规范名称（用最常见/官方写法，如 OpenAI、Anthropic、Cursor）"),
        type: z
          .enum(["organization", "person", "project", "product"])
          .describe("organization=组织/公司 · person=人物 · project=项目/研究 · product=产品/模型"),
      }),
    )
    .default([])
    .describe("本条洞察涉及的关键实体（组织/人物/项目/产品），无则空数组；只列 statement 真实提及的，不臆造"),
  tags: z
    .array(z.string())
    .default([])
    .describe(
      "本条洞察的 1–4 个主题标签（领域子方向/技术主题/事件类型，如 code-agent、供应链安全、benchmark、监管、开源模型），简洁名词短语，无则空数组；宁缺毋滥、不堆砌泛词（如 AI、技术）",
    ),
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

/** validator 批量一致性评判输出（成本归并：同一源被多条结论引用时，源文只发一遍、一次调用逐条判）。
 *  judgments 每项挂 index（=输入清单序号，从 1 起），代码侧按 index 对齐回各结论；要求逐条独立判定、
 *  每条都有、不遗漏不合并（缺项由 validator 判残缺→重试/记校验失败，绝不默认成 support）。 */
export const ConsistencyBatchJudgeSchema = z.object({
  judgments: z
    .array(
      z.object({
        index: z.number().int().describe("对应待校验结论的序号（从 1 起，与输入清单一致）"),
        consistency: z.enum(["support", "not_support", "uncertain"]),
        consistency_reason: z.enum(["ok", "out_of_context", "exaggeration", "misattribution", "uncertain"]),
        rationale: z.string().describe("简短判定理由"),
      }),
    )
    .describe("对清单里每一条结论各输出一项，逐条独立判断 untrusted_source 是否支持它"),
});
export type ConsistencyBatchJudge = z.infer<typeof ConsistencyBatchJudgeSchema>;

/** 跨批/跨run 一致性判定缓存的共享契约（DB 实现见 db/consistency-cache.ts，消费方 validator.validateBatch）。
 *  放共享 types 而非 validator——避免 db 层反向依赖 agents 层。
 *  缓存命中即跳过 Opus 调用、不计成本；只存成功判定（调用失败绝不缓存）。
 *  版本隔离（model + prompt 哈希）与 TTL 由实现侧保证——见 makeConsistencyCache。 */
export interface ConsistencyCache {
  get(statement: string, body: string): ConsistencyJudge | undefined;
  set(statement: string, body: string, judge: ConsistencyJudge): void;
}

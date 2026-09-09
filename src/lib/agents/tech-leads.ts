/** 技术线索 V1：把“已成功校验”的洞察确定性投影成可追踪对象。
 * 不调用 LLM、不新增事实文本；推荐理由只由已审计字段拼装。 */
import type { AnalysisBatch, ContentItem, TechLeadKind, TechLeadScoreDetail, ValidationResult } from "../types.js";
import { DISPLAY_PROJECTION_VERSION } from "../utils/source-quote-projection.js";
import { classifyTechLead } from "../utils/tech-lead-classify.js";
import { selectInsights } from "./report-gen.js";

export { classifyTechLead } from "../utils/tech-lead-classify.js";

export interface LeadCandidate {
  topic_id: string;
  canonical_key: string;
  kind: TechLeadKind;
  title: string;
  summary: string;
  /** 证据下标必须与其所属 insight 绑定，不能在同一事件的不同洞察间混用。 */
  evidence: Array<{ insight_id: string; citation_index: number }>;
  observed_at: string;
  score: number;
  score_detail: TechLeadScoreDetail;
}

const normalize = (value: string): string => value.toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, "-").slice(0, 160);

/** 技术线索不是行业新闻的别名：必须在洞察正文中有明确技术动作/对象，不能仅靠宽泛标签或厂商名入选。 */
const DIRECT_TECHNICAL_SIGNAL = /\b(benchmark|eval(?:uation)?|swe-bench|sdk|mcp|library|open[ -]source|security|vulnerability|attack|cve|paper|arxiv|robotics?|tool|agent|copilot|cursor)\b|评测|基准|协议|开源|安全|漏洞|攻击|论文|工具|代理|机器人/iu;
const MODEL_WORK_SIGNAL = /\b(model|llm|claude|gpt|gemini)\b.*\b(release|launch|train(?:ing)?|deploy(?:ment)?|evaluat(?:e|ion)|capabilit(?:y|ies)|architecture|upgrade|open[ -]weight)\b|(?:模型|Claude|GPT|Gemini).*(?:发布|推出|训练|部署|评测|性能|能力|架构|升级|开源|自适配)/iu;
const BUSINESS_OR_POLICY_CONTEXT = /\b(ipo|fund(?:ing)?|donat(?:ion|e)|acqui(?:re|sition)|investment|shareholder|lobby(?:ing)?|grant)\b|融资|捐赠|收购|投资|股东|资助|政策倡导|游说/iu;

export function isTechnicalLead(text: string): boolean {
  if (BUSINESS_OR_POLICY_CONTEXT.test(text)) return false;
  return DIRECT_TECHNICAL_SIGNAL.test(text) || MODEL_WORK_SIGNAL.test(text);
}

/** 分数 0–100：近期性 35、证据强度 25、重要性 20、主题相关性 20。
 * sourceCount stays an internal scoring signal; reader-visible prose must not turn it into an
 * unsupported “N independent sources” fact. */
export function scoreLead(input: {
  observedAt: string;
  now: string;
  sourceCount: number;
  importance: number;
  tags: string[];
}): TechLeadScoreDetail {
  const ageHours = Math.max(0, (new Date(input.now).getTime() - new Date(input.observedAt).getTime()) / 3_600_000);
  const freshness = Math.max(0, Math.round(35 * (1 - Math.min(ageHours, 48) / 48)));
  const evidence = Math.min(25, input.sourceCount * 12 + (input.sourceCount >= 2 ? 1 : 0));
  const importance = Math.round((Math.max(1, Math.min(5, input.importance)) / 5) * 20);
  const relevance = input.tags.length ? 20 : 12;
  const total = freshness + evidence + importance + relevance;
  const action = input.sourceCount >= 2 && input.importance >= 4 ? "建议深挖" : "建议关注";
  return { freshness, evidence, importance, relevance, total, reason: `${action}：系统综合近期性、证据强度与重要性评分（重要性 ${input.importance}/5）。` };
}

/** 仅保留明确 support 的 pass 引用。event_id 是最可靠的跨日报归并键；无 event 时用首实体/标题的规范化键。 */
export function extractLeadCandidates(
  batch: AnalysisBatch,
  validation: ValidationResult,
  items: Map<string, ContentItem>,
  now = new Date().toISOString(),
): LeadCandidate[] {
  // Leads are a new reader-visible derivative, not a historical renderer. Do not revive legacy
  // or merely validator-passing rows; the report selector verifies the persisted v6 binding/hash
  // and returns only that one reader evidence citation.
  if (batch.display_coverage_state !== "audited" || batch.display_projection_version !== DISPLAY_PROJECTION_VERSION) return [];
  const readerVisible = new Map(selectInsights(batch, validation).map((entry) => [entry.insight.id, entry]));
  const grouped = new Map<string, LeadCandidate>();
  for (const insight of batch.insights) {
    const reader = readerVisible.get(insight.id);
    if (!reader) continue;
    const citationIndices = reader.citationIndices;
    if (!citationIndices.length) continue;
    const cited = citationIndices.map((index) => items.get(insight.citations[index].content_item_id)).filter((x): x is ContentItem => !!x);
    if (!cited.length) continue;
    const observedAt = cited.map((item) => item.published_at ?? item.fetched_at).sort().at(-1)!;
    // A v6 reader projection has no generated title. Reusing a historical headline here would
    // make a lead look verified even though only the bound source quote was audited.
    const title = insight.statement;
    const technicalText = `${title} ${insight.statement}`;
    if (!isTechnicalLead(technicalText)) continue;
    const entity = insight.entities?.[0]?.name;
    const canonical_key = insight.event_id ? `event:${insight.event_id}` : `lead:${normalize(entity || title)}`;
    const sourceCount = new Set(cited.map((item) => item.source_id)).size;
    // Tags are analyzer metadata rather than bound source wording.  Do not let them affect the
    // reader-visible score (or turn a quote without “security” into a “security” lead).
    const score_detail = scoreLead({ observedAt, now, sourceCount, importance: insight.importance, tags: [] });
    const candidate: LeadCandidate = {
      // Classification remains a planner-only selection aid. It is derived from the binding
      // quote alone (never tags) and is projected to a generic reader label on read.
      topic_id: insight.topic_id, canonical_key, kind: classifyTechLead(title, []), title: "已核验技术线索",
      summary: insight.statement,
      evidence: citationIndices.map((citation_index) => ({ insight_id: insight.id, citation_index })),
      observed_at: observedAt,
      score: score_detail.total, score_detail,
    };
    const prior = grouped.get(canonical_key);
    // 同一批次同事件可能有多条洞察：保留评分高的摘要，同时合并所有成功校验证据。
    if (!prior) grouped.set(canonical_key, candidate);
    else {
      const better = candidate.score > prior.score ? candidate : prior;
      const evidence = new Map<string, { insight_id: string; citation_index: number }>();
      for (const item of [...prior.evidence, ...candidate.evidence]) evidence.set(`${item.insight_id}:${item.citation_index}`, item);
      grouped.set(canonical_key, { ...better, evidence: [...evidence.values()] });
    }
  }
  return [...grouped.values()];
}

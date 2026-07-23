/** 技术线索 V1：把“已成功校验”的洞察确定性投影成可追踪对象。
 * 不调用 LLM、不新增事实文本；推荐理由只由已审计字段拼装。 */
import type { AnalysisBatch, ContentItem, TechLeadKind, TechLeadScoreDetail, ValidationResult } from "../types.js";

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

export function classifyTechLead(text: string, tags: string[]): TechLeadKind {
  const value = `${text} ${tags.join(" ")}`.toLowerCase();
  if (/\b(arxiv|paper)\b|论文|研究/.test(value)) return "paper";
  if (/\b(benchmark|eval|swe-bench)\b|基准|评测/.test(value)) return "benchmark";
  if (/\b(security|vulnerability|attack|cve)\b|安全|漏洞|攻击/.test(value)) return "security";
  if (/\b(framework|sdk|mcp|library)\b|框架|协议/.test(value)) return "framework";
  if (/\b(model|llm|claude|gpt|gemini)\b|模型/.test(value)) return "model";
  if (/\b(tool|agent|ide|copilot|cursor)\b|工具|代理/.test(value)) return "tool";
  if (/\b(method|workflow|practice)\b|方法|实践/.test(value)) return "method";
  return "other";
}

/** 分数 0–100：近期性 35、独立来源证据 25、重要性 20、主题标签相关性 20。 */
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
  return { freshness, evidence, importance, relevance, total, reason: `${action}：${input.sourceCount} 个独立来源 · 重要性 ${input.importance}/5 · 最近证据 ${Math.round(ageHours)}h 前` };
}

/** 仅保留 pass 引用。event_id 是最可靠的跨日报归并键；无 event 时用首实体/标题的规范化键。 */
export function extractLeadCandidates(
  batch: AnalysisBatch,
  validation: ValidationResult,
  items: Map<string, ContentItem>,
  now = new Date().toISOString(),
): LeadCandidate[] {
  const pass = new Map(validation.checks.filter((c) => c.verdict === "pass").map((c) => [`${c.insight_id}:${c.citation_index}`, c]));
  const grouped = new Map<string, LeadCandidate>();
  for (const insight of batch.insights) {
    const citationIndices = insight.citations.flatMap((citation, index) => pass.has(`${insight.id}:${index}`) ? [index] : []);
    if (!citationIndices.length) continue;
    const cited = citationIndices.map((index) => items.get(insight.citations[index].content_item_id)).filter((x): x is ContentItem => !!x);
    if (!cited.length) continue;
    const observedAt = cited.map((item) => item.published_at ?? item.fetched_at).sort().at(-1)!;
    const title = insight.headline?.trim() || insight.statement;
    const technicalText = `${title} ${insight.statement}`;
    if (!isTechnicalLead(technicalText)) continue;
    const entity = insight.entities?.[0]?.name;
    const canonical_key = insight.event_id ? `event:${insight.event_id}` : `lead:${normalize(entity || title)}`;
    const sourceCount = new Set(cited.map((item) => item.source_id)).size;
    const score_detail = scoreLead({ observedAt, now, sourceCount, importance: insight.importance, tags: insight.tags ?? [] });
    const candidate: LeadCandidate = {
      topic_id: insight.topic_id, canonical_key, kind: classifyTechLead(technicalText, insight.tags ?? []), title,
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

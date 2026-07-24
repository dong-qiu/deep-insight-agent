/**
 * 技术规划 V2 的确定性投影。
 *
 * 这是 TechLead（已经由 pass Citation 支撑的事实对象）到机会候选的映射，
 * 绝不产生新事实，也不自动改变方向或立项状态。文字中的“假设”均明确待人工验证。
 */
import type {
  OpportunityLane, OpportunityScoreDetail, PlanningEffect, TechLead, TopicDirection,
} from "../types.js";

export interface OpportunityCandidate {
  lead_id: string;
  topic_id: string;
  direction_id: string | null;
  canonical_key: string;
  lane: OpportunityLane;
  planning_effect: PlanningEffect;
  title: string;
  hypothesis: string;
  proposed_validation: string;
  uncertainties: string[];
  priority_score: number;
  score_detail: OpportunityScoreDetail;
  fit_score: number;
  rationale: string;
}

const normalize = (value: string): string => value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
const matchingTerms = (text: string, terms: string[]): string[] => terms.filter((term) => normalize(text).includes(normalize(term)));

function validationFor(lead: TechLead): string {
  if (["paper", "benchmark"].includes(lead.kind)) return "在代表性任务集复现结论，并与现有基线对照。";
  if (lead.kind === "security") return "在隔离环境复现攻击/防护路径，记录误报、漏报和影响范围。";
  if (["framework", "tool"].includes(lead.kind)) return "选取一个受控工作流做小范围试点，度量成功率、成本和人工接管。";
  if (lead.kind === "model") return "以固定任务集和成本上限验证能力、稳定性与可替代性。";
  return "收集至少一条独立证据，并用明确任务验证可复现性与边界。";
}

function verifiabilityFor(kind: TechLead["kind"]): number {
  if (["paper", "benchmark", "security", "framework", "tool"].includes(kind)) return 15;
  if (kind === "model") return 12;
  return 8;
}

export function scoreOpportunity(lead: TechLead, lane: OpportunityLane, now = new Date().toISOString()): OpportunityScoreDetail {
  const alignment = lane === "core" || lane === "challenge" ? 30 : lane === "adjacent" ? 20 : 10;
  const evidence = Math.min(25, lead.score_detail.evidence);
  const leverage = Math.min(20, lead.score_detail.importance);
  const verifiability = verifiabilityFor(lead.kind);
  const ageHours = Math.max(0, (new Date(now).getTime() - new Date(lead.latest_evidence_at).getTime()) / 3_600_000);
  const timing = Math.max(0, Math.round(10 * (1 - Math.min(ageHours, 14 * 24) / (14 * 24))));
  const total = alignment + evidence + leverage + verifiability + timing;
  return {
    alignment, evidence, leverage, verifiability, timing, total,
    reason: `方向匹配 ${alignment}/30 · 已校验证据 ${evidence}/25 · 重要性 ${leverage}/20 · 可验证性 ${verifiability}/15 · 时效 ${timing}/10`,
  };
}

function effectFor(lane: OpportunityLane): PlanningEffect {
  return lane === "core" ? "reinforce" : lane === "adjacent" ? "expand" : lane === "challenge" ? "challenge" : "new_direction";
}

function candidateFor(lead: TechLead, lane: OpportunityLane, direction: TopicDirection | null, matches: string[], now: string): OpportunityCandidate {
  const score_detail = scoreOpportunity(lead, lane, now);
  const planning_effect = effectFor(lane);
  const scope = direction ? `方向「${direction.name}」` : "现有方向之外";
  const matchDescription = matches.length ? `命中词：${matches.join("、")}。` : "未命中已有方向词，满足高证据外部观察阈值。";
  return {
    lead_id: lead.id,
    topic_id: lead.topic_id,
    direction_id: direction?.id ?? null,
    canonical_key: direction ? `direction:${direction.id}:lead:${lead.id}` : `horizon:lead:${lead.id}`,
    lane,
    planning_effect,
    title: lead.title,
    hypothesis: `待验证假设：该线索可对${scope}形成${planning_effect === "challenge" ? "约束或反证" : "可研究的技术输入"}，但尚不构成立项结论。`,
    proposed_validation: validationFor(lead),
    uncertainties: ["线索事实仅以关联 TechLead 的成功校验引用为准。", "方向匹配为显式词表规则，需人工确认语义与适用边界。", "候选状态不代表项目批准或方向变更。"],
    priority_score: score_detail.total,
    score_detail,
    fit_score: Math.min(100, 35 + matches.length * 20 + (lane === "core" || lane === "challenge" ? 20 : 0)),
    rationale: `${matchDescription} 自动归入 ${lane} 通道；${score_detail.reason}`,
  };
}

/** 返回每条线索的最多一个方向内候选；挑战 > 核心 > 相邻，避免同一事实在方向内重复排队。 */
export function deriveOpportunityCandidates(leads: TechLead[], directions: TopicDirection[], now = new Date().toISOString()): OpportunityCandidate[] {
  const candidates: OpportunityCandidate[] = [];
  for (const lead of leads) {
    if (lead.kind === "other") continue;
    const text = `${lead.title}\n${lead.summary}`;
    const active = directions.filter((direction) => direction.topic_id === lead.topic_id && direction.status === "active");
    for (const direction of active) {
      const challenge = matchingTerms(text, direction.challenge_terms);
      const core = matchingTerms(text, direction.match_terms);
      const adjacent = matchingTerms(text, direction.adjacent_terms);
      if (challenge.length) candidates.push(candidateFor(lead, "challenge", direction, challenge, now));
      else if (core.length) candidates.push(candidateFor(lead, "core", direction, core, now));
      else if (adjacent.length) candidates.push(candidateFor(lead, "adjacent", direction, adjacent, now));
    }
    // 高证据但未能映射至任何 active direction 的信号进入视野池，供人工校准方向；不自动建方向。
    if (!candidates.some((candidate) => candidate.lead_id === lead.id) && lead.score >= 60 && lead.score_detail.evidence >= 12 && lead.score_detail.importance >= 12) {
      candidates.push(candidateFor(lead, "horizon", null, [], now));
    }
  }
  return candidates;
}

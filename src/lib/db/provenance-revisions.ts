/** P0b revision registry 的共享实现。
 *
 * 采集与主题流水线都引用 ContentItem；把 revision 规则收在 DB 边界，避免两条链路
 * 对同一 content_hash 生成不兼容的历史版本。snapshot 只保留可解释元数据，不含正文或 raw_ref。 */
import type { ContentItem, Source, TechLead, TechnologyOpportunity, TopicDirection } from "../types.js";
import { canonicalHash, type EntityRef } from "./provenance-facts.js";

const CONTENT_REVISION_V2 = "content-v2";

export function contentItemRevision(item: ContentItem): string {
  return `${CONTENT_REVISION_V2}:${item.content_hash}`;
}

export function contentItemRevisionSnapshot(item: ContentItem): Record<string, unknown> {
  return {
    url: item.url,
    source_id: item.source_id,
    published_at: item.published_at,
    body_length: item.body.length,
    content_hash: item.content_hash,
  };
}

export function contentItemRef(item: ContentItem, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "content_item", locator: { kind: "id", id: item.id }, revision: contentItemRevision(item), role };
}

/** Source 没有业务 version 字段，故由脱敏、规范化配置生成 revision；topic_ids 的先后不影响配置语义。 */
export function sourceConfigSnapshot(source: Source): Record<string, unknown> {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    endpoint: source.endpoint,
    topic_ids: [...source.topic_ids].sort(),
    fetch_interval: source.fetch_interval,
    // canonical JSON v1 intentionally仅接受整数；预算可以是小数，故以稳定十进制字符串进入脱敏 snapshot。
    backfill: source.backfill == null ? null : { depth: source.backfill.depth, max_cost: String(source.backfill.max_cost) },
    enabled: source.enabled,
    fetch_mode: source.fetch_mode ?? "feed",
    content_container: source.content_container ?? null,
  };
}

export function sourceConfigRevision(source: Source): string {
  return `source-v1:${canonicalHash(sourceConfigSnapshot(source))}`;
}

export function sourceConfigRef(source: Source, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "source", locator: { kind: "id", id: source.id }, revision: sourceConfigRevision(source), role };
}

/** provenance canonical JSON 只接受整数；规划分数为小数时固定为十进制字符串，不丢精度也不引入浮点序列化漂移。 */
function scoreSnapshot(score: object): Record<string, string> {
  return Object.fromEntries(Object.entries(score as Record<string, number | string>).map(([key, value]) => [key, typeof value === "number" ? String(value) : value]));
}

export function techLeadRevisionSnapshot(lead: TechLead): Record<string, unknown> {
  return {
    id: lead.id, topic_id: lead.topic_id, canonical_key: lead.canonical_key, kind: lead.kind, title: lead.title,
    summary: lead.summary, status: lead.status, score: String(lead.score), score_detail: scoreSnapshot(lead.score_detail),
    first_seen_at: lead.first_seen_at, last_seen_at: lead.last_seen_at, latest_evidence_at: lead.latest_evidence_at,
  };
}
export function techLeadRef(lead: TechLead, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "tech_lead", locator: { kind: "id", id: lead.id }, revision: `tech-lead-v1:${canonicalHash(techLeadRevisionSnapshot(lead))}`, role };
}

export function topicDirectionRevisionSnapshot(direction: TopicDirection): Record<string, unknown> {
  return {
    id: direction.id, topic_id: direction.topic_id, name: direction.name, objective: direction.objective,
    problem_statement: direction.problem_statement, in_scope: direction.in_scope, out_of_scope: direction.out_of_scope,
    key_questions: direction.key_questions, constraints: direction.constraints, success_signals: direction.success_signals,
    match_terms: direction.match_terms, adjacent_terms: direction.adjacent_terms, challenge_terms: direction.challenge_terms,
    horizon: direction.horizon, status: direction.status, version: direction.version,
  };
}
export function topicDirectionRef(direction: TopicDirection, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "topic_direction", locator: { kind: "id", id: direction.id }, revision: `direction-v1:${canonicalHash(topicDirectionRevisionSnapshot(direction))}`, role };
}

export function technologyOpportunityRevisionSnapshot(opportunity: TechnologyOpportunity): Record<string, unknown> {
  return {
    id: opportunity.id, topic_id: opportunity.topic_id, direction_id: opportunity.direction_id, canonical_key: opportunity.canonical_key,
    lane: opportunity.lane, planning_effect: opportunity.planning_effect, title: opportunity.title, hypothesis: opportunity.hypothesis,
    proposed_validation: opportunity.proposed_validation, uncertainties: opportunity.uncertainties, status: opportunity.status,
    mapping_state: opportunity.mapping_state, mapping_direction_version: opportunity.mapping_direction_version,
    priority_score: String(opportunity.priority_score), score_detail: scoreSnapshot(opportunity.score_detail),
    first_seen_at: opportunity.first_seen_at, last_seen_at: opportunity.last_seen_at, latest_evidence_at: opportunity.latest_evidence_at,
  };
}
export function technologyOpportunityRef(opportunity: TechnologyOpportunity, role: EntityRef["role"] = "input"): EntityRef {
  return { type: "technology_opportunity", locator: { kind: "id", id: opportunity.id }, revision: `opportunity-v1:${canonicalHash(technologyOpportunityRevisionSnapshot(opportunity))}`, role };
}

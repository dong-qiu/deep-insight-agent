/** 技术方向与机会持久化。机会只链接 TechLead，事实读取继续走其 pass 引用链。 */
import { randomUUID } from "node:crypto";
import { DEFAULT_TOPIC_DIRECTIONS } from "../planning/default-directions.js";
import type { OpportunityLane, PlanningEffect, TechnologyOpportunity, TechnologyOpportunityStatus, TopicDirection, TopicDirectionInput, TopicDirectionStatus } from "../types.js";
import type { OpportunityCandidate } from "../agents/opportunity-planning.js";
import type { TechLead } from "../types.js";
import type { DB } from "./index.js";
import { deriveOpportunityCandidates } from "../agents/opportunity-planning.js";
import { listTechLeads } from "./tech-leads.js";

const json = (value: unknown): string => JSON.stringify(value);
const parse = (value: unknown): string[] => value ? JSON.parse(value as string) : [];

const toDirection = (r: any): TopicDirection => ({
  id: r.id, topic_id: r.topic_id, name: r.name, objective: r.objective, problem_statement: r.problem_statement,
  in_scope: parse(r.in_scope), out_of_scope: parse(r.out_of_scope), key_questions: parse(r.key_questions), constraints: parse(r.constraints_json),
  success_signals: parse(r.success_signals), match_terms: parse(r.match_terms), adjacent_terms: parse(r.adjacent_terms), challenge_terms: parse(r.challenge_terms),
  horizon: r.horizon, status: r.status, version: r.version, created_at: r.created_at, updated_at: r.updated_at,
});
const toOpportunity = (r: any): TechnologyOpportunity => ({
  id: r.id, topic_id: r.topic_id, direction_id: r.direction_id, canonical_key: r.canonical_key, lane: r.lane, planning_effect: r.planning_effect,
  title: r.title, hypothesis: r.hypothesis, proposed_validation: r.proposed_validation, uncertainties: parse(r.uncertainties), status: r.status, mapping_state: r.mapping_state, mapping_direction_version: r.mapping_direction_version,
  priority_score: r.priority_score, score_detail: JSON.parse(r.score_detail), first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, latest_evidence_at: r.latest_evidence_at,
});

export function seedDefaultDirections(db: DB): number {
  const exists = db.prepare("SELECT 1 FROM topic_direction WHERE id=?");
  const topicExists = db.prepare("SELECT 1 FROM topic WHERE id=?");
  let added = 0;
  db.transaction(() => {
    for (const direction of DEFAULT_TOPIC_DIRECTIONS) {
      // 首次打开空库时，默认 topic 可能尚未由配置层播种；跳过而不是触发 FK 失败。
      // getEffectiveSources() 在播种 topic 后会再次调用本函数。
      if (topicExists.get(direction.topic_id) && !exists.get(direction.id)) {
        createTopicDirection(db, direction);
        added++;
      }
    }
  })();
  return added;
}

export function createTopicDirection(db: DB, direction: TopicDirectionInput, now = new Date().toISOString()): TopicDirection {
  db.prepare(`INSERT INTO topic_direction (id,topic_id,name,objective,problem_statement,in_scope,out_of_scope,key_questions,constraints_json,success_signals,match_terms,adjacent_terms,challenge_terms,horizon,status,created_at,updated_at)
    VALUES (@id,@topic_id,@name,@objective,@problem_statement,@in_scope,@out_of_scope,@key_questions,@constraints_json,@success_signals,@match_terms,@adjacent_terms,@challenge_terms,@horizon,@status,@now,@now)`).run({
    ...direction, in_scope: json(direction.in_scope), out_of_scope: json(direction.out_of_scope), key_questions: json(direction.key_questions), constraints_json: json(direction.constraints),
    success_signals: json(direction.success_signals), match_terms: json(direction.match_terms), adjacent_terms: json(direction.adjacent_terms), challenge_terms: json(direction.challenge_terms), now,
  });
  return getTopicDirection(db, direction.id)!;
}

export function getTopicDirection(db: DB, id: string): TopicDirection | null {
  const row = db.prepare("SELECT * FROM topic_direction WHERE id=?").get(id) as any;
  return row ? toDirection(row) : null;
}
export function listTopicDirections(db: DB, opts: { topic?: string; includeRetired?: boolean } = {}): TopicDirection[] {
  const where: string[] = []; const args: unknown[] = [];
  if (opts.topic) { where.push("topic_id=?"); args.push(opts.topic); }
  if (!opts.includeRetired) where.push("status <> 'retired'");
  return (db.prepare(`SELECT * FROM topic_direction${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY horizon,name`).all(...args) as any[]).map(toDirection);
}
export function setTopicDirectionStatus(db: DB, id: string, status: TopicDirectionStatus): boolean {
  return db.prepare("UPDATE topic_direction SET status=?,version=version+1,updated_at=? WHERE id=?").run(status, new Date().toISOString(), id).changes === 1;
}

export type UpdateDirectionResult = { kind: "updated"; direction: TopicDirection } | { kind: "conflict"; current: TopicDirection } | { kind: "not_found" };
/** 完整更新方向档案。topic/id 不可在编辑中迁移，词表是否变化由调用方决定是否标 stale。 */
export function updateTopicDirection(db: DB, direction: TopicDirectionInput, expectedVersion: number, now = new Date().toISOString()): UpdateDirectionResult {
  const current = getTopicDirection(db, direction.id);
  if (!current) return { kind: "not_found" };
  if (current.version !== expectedVersion) return { kind: "conflict", current };
  if (current.topic_id !== direction.topic_id) throw new Error("direction_topic_immutable");
  const ruleChanged = ["match_terms", "adjacent_terms", "challenge_terms"].some((key) => JSON.stringify(current[key as keyof TopicDirection]) !== JSON.stringify(direction[key as keyof TopicDirectionInput]));
  let changed = 0;
  db.transaction(() => {
    changed = db.prepare(`UPDATE topic_direction SET name=@name,objective=@objective,problem_statement=@problem_statement,in_scope=@in_scope,out_of_scope=@out_of_scope,key_questions=@key_questions,constraints_json=@constraints_json,success_signals=@success_signals,match_terms=@match_terms,adjacent_terms=@adjacent_terms,challenge_terms=@challenge_terms,horizon=@horizon,status=@status,version=version+1,updated_at=@now WHERE id=@id AND version=@expectedVersion`).run({
      ...direction, in_scope: json(direction.in_scope), out_of_scope: json(direction.out_of_scope), key_questions: json(direction.key_questions), constraints_json: json(direction.constraints), success_signals: json(direction.success_signals), match_terms: json(direction.match_terms), adjacent_terms: json(direction.adjacent_terms), challenge_terms: json(direction.challenge_terms), now, expectedVersion,
    }).changes;
    if (changed && ruleChanged) db.prepare("UPDATE technology_opportunity SET mapping_state='stale' WHERE direction_id=? AND mapping_state='current'").run(direction.id);
  })();
  if (!changed) return { kind: "conflict", current: getTopicDirection(db, direction.id)! };
  return { kind: "updated", direction: getTopicDirection(db, direction.id)! };
}

export interface DirectionPreviewItem {
  lead_id: string;
  title: string;
  before: { lane: OpportunityLane; rationale: string } | null;
  after: { lane: OpportunityLane; rationale: string } | null;
}

const candidatesForDirection = (leads: TechLead[], direction: TopicDirection, now: string): Map<string, OpportunityCandidate> =>
  new Map(deriveOpportunityCandidates(leads, [direction], now).filter((candidate) => candidate.direction_id === direction.id).map((candidate) => [candidate.lead_id, candidate]));

/** 不落库地比较当前规则与草案规则，供工作台在保存前展示受影响线索。 */
export function previewTopicDirectionMapping(leads: TechLead[], current: TopicDirection, draft: TopicDirectionInput, now = new Date().toISOString()): DirectionPreviewItem[] {
  const before = candidatesForDirection(leads, current, now);
  const proposed: TopicDirection = { ...draft, version: current.version, created_at: current.created_at, updated_at: current.updated_at };
  const after = candidatesForDirection(leads, proposed, now);
  const leadNames = new Map(leads.map((lead) => [lead.id, lead.title]));
  return [...new Set([...before.keys(), ...after.keys()])].map((leadId) => ({
    lead_id: leadId, title: leadNames.get(leadId) ?? leadId,
    before: before.has(leadId) ? { lane: before.get(leadId)!.lane, rationale: before.get(leadId)!.rationale } : null,
    after: after.has(leadId) ? { lane: after.get(leadId)!.lane, rationale: after.get(leadId)!.rationale } : null,
  })).filter((item) => item.before?.lane !== item.after?.lane);
}

/** 显式重投影：先把旧映射标 stale，再仅刷新仍符合当前方向的候选；人工状态不被改写。 */
export function reprojectTopicDirection(db: DB, id: string, now = new Date().toISOString()): { kind: "done"; refreshed: number; stale: number; direction: TopicDirection } | { kind: "not_found" } {
  const direction = getTopicDirection(db, id);
  if (!direction) return { kind: "not_found" };
  const leads = listTechLeads(db, { topic: direction.topic_id, limit: 500 });
  db.prepare("UPDATE technology_opportunity SET mapping_state='stale' WHERE direction_id=? AND mapping_state='current'").run(id);
  const candidates = candidatesForDirection(leads, direction, now);
  const refreshed = upsertTechnologyOpportunities(db, [...candidates.values()], new Map(leads.map((lead) => [lead.id, lead])), now).length;
  const stale = (db.prepare("SELECT count(*) AS n FROM technology_opportunity WHERE direction_id=? AND mapping_state='stale'").get(id) as { n: number }).n;
  return { kind: "done", refreshed, stale, direction };
}

export function upsertTechnologyOpportunities(db: DB, candidates: OpportunityCandidate[], leads: Map<string, TechLead>, now = new Date().toISOString()): TechnologyOpportunity[] {
  const find = db.prepare("SELECT * FROM technology_opportunity WHERE topic_id=? AND canonical_key=?");
  const insert = db.prepare(`INSERT INTO technology_opportunity (id,topic_id,direction_id,canonical_key,lane,planning_effect,title,hypothesis,proposed_validation,uncertainties,status,mapping_state,mapping_direction_version,priority_score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
    VALUES (@id,@topic_id,@direction_id,@canonical_key,@lane,@planning_effect,@title,@hypothesis,@proposed_validation,@uncertainties,'observed','current',@mapping_direction_version,@priority_score,@score_detail,@now,@now,@latest_evidence_at)`);
  const update = db.prepare(`UPDATE technology_opportunity SET direction_id=@direction_id,lane=@lane,planning_effect=@planning_effect,title=@title,hypothesis=@hypothesis,proposed_validation=@proposed_validation,uncertainties=@uncertainties,priority_score=@priority_score,score_detail=@score_detail,mapping_state='current',mapping_direction_version=@mapping_direction_version,last_seen_at=@now,latest_evidence_at=CASE WHEN latest_evidence_at < @latest_evidence_at THEN @latest_evidence_at ELSE latest_evidence_at END WHERE id=@id`);
  const link = db.prepare("INSERT OR IGNORE INTO opportunity_lead (opportunity_id,lead_id,added_at) VALUES (?,?,?)");
  const map = db.prepare(`INSERT INTO tech_lead_direction_map (lead_id,direction_id,lane,planning_effect,fit_score,rationale,created_at,updated_at)
    VALUES (@lead_id,@direction_id,@lane,@planning_effect,@fit_score,@rationale,@now,@now)
    ON CONFLICT(lead_id,direction_id) DO UPDATE SET lane=excluded.lane,planning_effect=excluded.planning_effect,fit_score=excluded.fit_score,rationale=excluded.rationale,updated_at=excluded.updated_at`);
  const out: TechnologyOpportunity[] = [];
  db.transaction(() => {
    for (const candidate of candidates) {
      const lead = leads.get(candidate.lead_id); if (!lead) continue;
      if (candidate.direction_id) map.run({ ...candidate, now });
      let row = find.get(candidate.topic_id, candidate.canonical_key) as any;
      const values = { ...candidate, id: `opp_${randomUUID().slice(0, 12)}`, uncertainties: json(candidate.uncertainties), score_detail: json(candidate.score_detail), now, latest_evidence_at: lead.latest_evidence_at };
      if (!row) { insert.run(values); row = find.get(candidate.topic_id, candidate.canonical_key); }
      else { update.run({ ...values, id: row.id }); row = find.get(candidate.topic_id, candidate.canonical_key); }
      link.run(row.id, candidate.lead_id, now);
      out.push(toOpportunity(row));
    }
  })();
  return out;
}

export function listTechnologyOpportunities(db: DB, opts: { topic?: string; direction?: string; lane?: OpportunityLane; status?: TechnologyOpportunityStatus; includeClosed?: boolean; limit?: number } = {}): TechnologyOpportunity[] {
  const where: string[] = []; const args: unknown[] = [];
  if (opts.topic) { where.push("topic_id=?"); args.push(opts.topic); }
  if (opts.direction) { where.push("direction_id=?"); args.push(opts.direction); }
  if (opts.lane) { where.push("lane=?"); args.push(opts.lane); }
  if (opts.status) { where.push("status=?"); args.push(opts.status); }
  else if (!opts.includeClosed) where.push("status NOT IN ('rejected','archived')");
  return (db.prepare(`SELECT * FROM technology_opportunity${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY priority_score DESC,latest_evidence_at DESC LIMIT ?`).all(...args, opts.limit ?? 100) as any[]).map(toOpportunity);
}
export function getTechnologyOpportunity(db: DB, id: string): TechnologyOpportunity | null {
  const row = db.prepare("SELECT * FROM technology_opportunity WHERE id=?").get(id) as any;
  return row ? toOpportunity(row) : null;
}
export function setTechnologyOpportunityStatus(db: DB, id: string, status: TechnologyOpportunityStatus): boolean {
  return db.prepare("UPDATE technology_opportunity SET status=?,last_seen_at=? WHERE id=?").run(status, new Date().toISOString(), id).changes === 1;
}
export function listOpportunityLeads(db: DB, opportunityId: string): TechLead[] {
  const rows = db.prepare(`SELECT l.* FROM opportunity_lead ol JOIN tech_lead l ON l.id=ol.lead_id WHERE ol.opportunity_id=? ORDER BY l.score DESC`).all(opportunityId) as any[];
  return rows.map((r) => ({ id:r.id,topic_id:r.topic_id,canonical_key:r.canonical_key,kind:r.kind,title:r.title,summary:r.summary,status:r.status,score:r.score,score_detail:JSON.parse(r.score_detail),first_seen_at:r.first_seen_at,last_seen_at:r.last_seen_at,latest_evidence_at:r.latest_evidence_at }));
}

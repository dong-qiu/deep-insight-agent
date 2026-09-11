/** 技术线索持久化与查询。证据始终关联 citation 的复合主键，读取时只联明确 support 的 pass。 */
import { randomUUID } from "node:crypto";
import type { TechLead, TechLeadEvidence, TechLeadStatus } from "../types.js";
import type { LeadCandidate } from "../agents/tech-leads.js";
import { auditSupportsStatementBinding, hasSafeReaderMetadata } from "../utils/display-coverage-audit.js";
import { classifyTechLead } from "../utils/tech-lead-classify.js";
import type { DB } from "./index.js";

const toLead = (r: any): TechLead => ({
  id: r.id, topic_id: r.topic_id, canonical_key: r.canonical_key, kind: r.kind, title: r.title, summary: r.summary,
  status: r.status, score: r.score, score_detail: JSON.parse(r.score_detail), first_seen_at: r.first_seen_at,
  last_seen_at: r.last_seen_at, latest_evidence_at: r.latest_evidence_at,
});

const READER_LEAD_TITLE = "已核验技术线索";
const READER_LEAD_REASON = "系统优先级评分：基于当前已核验原文与时间信息。";
const READER_LEAD_SUMMARY = "请展开下方已核验原文与来源。";

/** A durable lead is a cache, not reader evidence.  Rebuild its visible copy from one live v6
 * binding so a title/summary/reason written by an older candidate can never hitch a ride on a
 * newly valid evidence row. */
export function projectReaderVisibleTechLead(lead: TechLead, evidence: TechLeadEvidence[]): TechLead {
  const primary = evidence[0];
  if (!primary) throw new Error("reader_visible_lead_requires_evidence");
  return {
    ...lead,
    kind: "other",
    title: READER_LEAD_TITLE,
    // The actual quote belongs exclusively to listTechLeadEvidence.  API detail responses and
    // the UI combine a lead with that list, so duplicating it here would make one source quote
    // appear twice in the same reader payload.
    summary: READER_LEAD_SUMMARY,
    score_detail: { ...lead.score_detail, reason: READER_LEAD_REASON },
  };
}

/** 写入候选并追加新 pass 证据。用户主动状态不会被每日管线覆盖。 */
export function upsertTechLeads(db: DB, candidates: LeadCandidate[], now = new Date().toISOString()): TechLead[] {
  const find = db.prepare("SELECT * FROM tech_lead WHERE topic_id=? AND canonical_key=?");
  const insert = db.prepare(`INSERT INTO tech_lead (id,topic_id,canonical_key,kind,title,summary,status,score,score_detail,first_seen_at,last_seen_at,latest_evidence_at)
    VALUES (@id,@topic_id,@canonical_key,@kind,@title,@summary,'recommended',@score,@score_detail,@now,@now,@latest_evidence_at)`);
  const update = db.prepare(`UPDATE tech_lead SET kind=@kind,title=@title,summary=@summary,score=@score,score_detail=@score_detail,last_seen_at=@now,
    latest_evidence_at=CASE WHEN latest_evidence_at < @latest_evidence_at THEN @latest_evidence_at ELSE latest_evidence_at END WHERE id=@id`);
  const evidence = db.prepare("INSERT OR IGNORE INTO tech_lead_evidence (lead_id,insight_id,citation_index,added_at) VALUES (?,?,?,?)");
  const out: TechLead[] = [];
  db.transaction(() => {
    for (const candidate of candidates) {
      let row = find.get(candidate.topic_id, candidate.canonical_key) as any;
      if (!row) {
        const id = `lead_${randomUUID().slice(0, 12)}`;
        insert.run({ ...candidate, id, score_detail: JSON.stringify(candidate.score_detail), now, latest_evidence_at: candidate.observed_at });
        row = find.get(candidate.topic_id, candidate.canonical_key);
      } else {
        update.run({ ...candidate, id: row.id, score_detail: JSON.stringify(candidate.score_detail), now, latest_evidence_at: candidate.observed_at });
        row = find.get(candidate.topic_id, candidate.canonical_key);
      }
      for (const item of candidate.evidence) evidence.run(row.id, item.insight_id, item.citation_index, now);
      out.push(toLead(row));
    }
  })();
  return out;
}

export function listTechLeads(db: DB, opts: { topic?: string; status?: TechLeadStatus; includeDismissed?: boolean; since?: string; limit?: number } = {}): TechLead[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.topic) { where.push("topic_id=?"); args.push(opts.topic); }
  if (opts.status) { where.push("status=?"); args.push(opts.status); }
  else if (!opts.includeDismissed) where.push("status <> 'dismissed'");
  if (opts.since) { where.push("latest_evidence_at >= ?"); args.push(opts.since); }
  const sql = `SELECT * FROM tech_lead${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY score DESC, latest_evidence_at DESC LIMIT ?`;
  // `tech_lead` is a durable cache, not a new evidence authority. A batch can later be
  // downgraded or found to contain unsafe display metadata, so every reader list rechecks that
  // at least one of its persisted evidence bindings is still publishable.
  return (db.prepare(sql).all(...args, opts.limit ?? 50) as any[])
    .map(toLead)
    .map((lead) => {
      const evidence = listTechLeadEvidence(db, lead.id);
      return evidence.length ? projectReaderVisibleTechLead(lead, evidence) : null;
    })
    .filter((lead): lead is TechLead => lead !== null);
}

export function getTechLead(db: DB, id: string): TechLead | null {
  const row = db.prepare("SELECT * FROM tech_lead WHERE id=?").get(id) as any;
  const lead = row ? toLead(row) : null;
  if (!lead) return null;
  const evidence = listTechLeadEvidence(db, lead.id);
  return evidence.length ? projectReaderVisibleTechLead(lead, evidence) : null;
}

/** Internal-only planning projection.  It reuses the same current v6 evidence gate as reader
 * lists, then derives matching/classification text from the bound quote alone.  Do not expose
 * this function through a route: generic reader lead fields intentionally omit this text. */
export function listPlanningTechLeads(
  db: DB,
  opts: { topic?: string; includeDismissed?: boolean; limit?: number } = {},
): TechLead[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.topic) { where.push("topic_id=?"); args.push(opts.topic); }
  if (!opts.includeDismissed) where.push("status <> 'dismissed'");
  const sql = `SELECT * FROM tech_lead${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY score DESC, latest_evidence_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, opts.limit ?? 500) as any[])
    .map(toLead)
    .map((lead) => {
      const evidence = listTechLeadEvidence(db, lead.id);
      const quote = evidence[0]?.quote;
      if (!quote) return null;
      return {
        ...lead,
        kind: classifyTechLead(quote, []),
        title: quote,
        summary: "",
        score_detail: { ...lead.score_detail, reason: READER_LEAD_REASON },
      };
    })
    .filter((lead): lead is TechLead => lead !== null);
}

export function setTechLeadStatus(db: DB, id: string, status: TechLeadStatus): boolean {
  return db.prepare("UPDATE tech_lead SET status=? WHERE id=?").run(status, id).changes === 1;
}

type PersistedLeadEvidenceRow = TechLeadEvidence & {
  statement: string;
  statement_citation_index: number | null;
  statement_citation_ref: string | null;
  headline: string | null;
  importance_basis: string;
  display_coverage_decision: string;
};

function isReaderVisibleLeadEvidence(row: PersistedLeadEvidenceRow): boolean {
  let decision: unknown;
  try { decision = JSON.parse(row.display_coverage_decision); } catch { return false; }
  return auditSupportsStatementBinding(decision, {
    citation_index: row.statement_citation_index,
    citation_ref: row.statement_citation_ref,
    statement: row.statement,
    quote: row.quote,
  }) && hasSafeReaderMetadata({
    headline: row.headline ?? undefined,
    importance_basis: row.importance_basis,
    importance_facts: [],
  });
}

export function listTechLeadEvidence(db: DB, leadId: string): TechLeadEvidence[] {
  const rows = db.prepare(`SELECT e.lead_id,e.insight_id,e.citation_index,s.name AS source_name,c.url,ci.quote,
      COALESCE(c.published_at,c.fetched_at) AS observed_at
      ,i.statement,i.statement_citation_index,ci.citation_ref AS statement_citation_ref,
      i.headline,i.importance_basis,d.decision AS display_coverage_decision
    FROM tech_lead_evidence e
    JOIN citation ci ON ci.insight_id=e.insight_id AND ci.citation_index=e.citation_index
    JOIN insight i ON i.id=ci.insight_id
    JOIN analysis_batch b ON b.id=i.batch_id
    JOIN display_coverage_audit d ON d.batch_id=b.id AND d.insight_id=i.id
      AND d.terminal_reason IN ('kept', 'kept_degraded')
    JOIN citation_check cc ON cc.batch_id=b.id AND cc.insight_id=ci.insight_id AND cc.citation_index=ci.citation_index
    JOIN content_item c ON c.id=ci.content_item_id AND c.reader_eligible=1 JOIN source s ON s.id=c.source_id
    WHERE e.lead_id=?
      AND b.status='done' AND b.display_coverage_state='audited' AND b.display_projection_version='source_quote_v1'
      AND e.citation_index=i.statement_citation_index - 1
      AND cc.verdict='pass' AND cc.consistency='support' AND cc.reachability='pass'
    ORDER BY observed_at DESC`).all(leadId) as PersistedLeadEvidenceRow[];
  return rows.filter(isReaderVisibleLeadEvidence).map(({
    statement: _statement, statement_citation_index: _statementCitationIndex,
    statement_citation_ref: _statementCitationRef, headline: _headline,
    importance_basis: _importanceBasis, display_coverage_decision: _decision, ...evidence
  }) => evidence);
}

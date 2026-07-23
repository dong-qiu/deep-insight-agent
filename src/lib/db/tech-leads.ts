/** 技术线索持久化与查询。证据始终关联 citation 的复合主键，读取时只联 pass verdict。 */
import { randomUUID } from "node:crypto";
import type { TechLead, TechLeadEvidence, TechLeadStatus } from "../types.js";
import type { LeadCandidate } from "../agents/tech-leads.js";
import type { DB } from "./index.js";

const toLead = (r: any): TechLead => ({
  id: r.id, topic_id: r.topic_id, canonical_key: r.canonical_key, kind: r.kind, title: r.title, summary: r.summary,
  status: r.status, score: r.score, score_detail: JSON.parse(r.score_detail), first_seen_at: r.first_seen_at,
  last_seen_at: r.last_seen_at, latest_evidence_at: r.latest_evidence_at,
});

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
  return (db.prepare(sql).all(...args, opts.limit ?? 50) as any[]).map(toLead);
}

export function getTechLead(db: DB, id: string): TechLead | null {
  const row = db.prepare("SELECT * FROM tech_lead WHERE id=?").get(id) as any;
  return row ? toLead(row) : null;
}

export function setTechLeadStatus(db: DB, id: string, status: TechLeadStatus): boolean {
  return db.prepare("UPDATE tech_lead SET status=? WHERE id=?").run(status, id).changes === 1;
}

export function listTechLeadEvidence(db: DB, leadId: string): TechLeadEvidence[] {
  return db.prepare(`SELECT e.lead_id,e.insight_id,e.citation_index,s.name AS source_name,c.url,ci.quote,
      COALESCE(c.published_at,c.fetched_at) AS observed_at
    FROM tech_lead_evidence e
    JOIN citation ci ON ci.insight_id=e.insight_id AND ci.citation_index=e.citation_index
    JOIN insight i ON i.id=ci.insight_id
    JOIN analysis_batch b ON b.id=i.batch_id
    JOIN citation_check cc ON cc.batch_id=b.id AND cc.insight_id=ci.insight_id AND cc.citation_index=ci.citation_index
    JOIN content_item c ON c.id=ci.content_item_id JOIN source s ON s.id=c.source_id
    WHERE e.lead_id=? AND cc.verdict='pass' ORDER BY observed_at DESC`).all(leadId) as TechLeadEvidence[];
}

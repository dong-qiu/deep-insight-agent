/** Export the only permitted sampling input: the complete current planning-reader cohort. */
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { listPlanningTechLeads, listTechLeadEvidence } from "../src/lib/db/tech-leads.js";
import { listTopicDirections } from "../src/lib/db/planning.js";
import { QUALIFIED_SNAPSHOT_VERSION, validateQualifiedTechLeadSnapshot, type QualifiedTechLeadSnapshot } from "./technology-opportunities/dogfood-v2.js";

const [outputPath, snapshotAt = new Date().toISOString()] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: tsx evals/export-qualified-tech-leads-v2.ts <qualified-snapshot.json> [snapshot-at-utc]");
const dbPath = process.env.DB_PATH;
if (!dbPath || !isAbsolute(dbPath)) throw new Error("DB_PATH must be an explicit absolute path to an existing offline SQLite snapshot");
// Never use getDb(): application bootstrap can mutate both records and archived artifacts.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
let snapshot: QualifiedTechLeadSnapshot;
try {
  snapshot = db.transaction(() => {
    // Preserve the planning reader's qualification and avoid its UI-oriented default (500).
    const leads = listPlanningTechLeads(db, { limit: 2_147_483_647 });
    const result: QualifiedTechLeadSnapshot = {
      snapshot_version: QUALIFIED_SNAPSHOT_VERSION, snapshot_at: snapshotAt,
      source: "listPlanningTechLeads", qualification: "current_pass_evidence_and_not_dismissed",
      pagination: "unbounded", total_count: leads.length,
      leads: leads.map((lead) => {
        const passEvidenceCount = listTechLeadEvidence(db, lead.id).length;
        if (lead.status === "dismissed") throw new Error("qualified_export_contains_dismissed_lead");
        return {
          lead_id: lead.id, topic_id: lead.topic_id, lead_kind: lead.kind,
          evidence_count: passEvidenceCount, pass_evidence_count: passEvidenceCount, status: lead.status,
          latest_evidence_at: lead.latest_evidence_at, title: lead.title, summary: lead.summary,
          score: lead.score, evidence_score: lead.score_detail.evidence, importance_score: lead.score_detail.importance,
        };
      }),
      mapping_directions: listTopicDirections(db, { includeRetired: true }).map((direction) => ({
        direction_id: direction.id, topic_id: direction.topic_id, status: direction.status, version: direction.version,
        match_terms: direction.match_terms, adjacent_terms: direction.adjacent_terms, challenge_terms: direction.challenge_terms,
      })),
    };
    validateQualifiedTechLeadSnapshot(result);
    return result;
  })();
} finally {
  db.close();
}
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

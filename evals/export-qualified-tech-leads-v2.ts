/** Export the only permitted sampling input: the complete current planning-reader cohort. */
import { writeFileSync } from "node:fs";
import { getDb } from "../src/lib/db/index.js";
import { listPlanningTechLeads, listTechLeadEvidence } from "../src/lib/db/tech-leads.js";
import { QUALIFIED_SNAPSHOT_VERSION, type QualifiedTechLeadSnapshot } from "./technology-opportunities/dogfood-v2.js";

const [outputPath, snapshotAt = new Date().toISOString()] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: tsx evals/export-qualified-tech-leads-v2.ts <qualified-snapshot.json> [snapshot-at-utc]");
// Explicitly avoid listPlanningTechLeads' UI-oriented default (500). This tool never mutates DB.
const db = getDb();
const leads = listPlanningTechLeads(db, { limit: 2_147_483_647 });
const snapshot: QualifiedTechLeadSnapshot = {
  snapshot_version: QUALIFIED_SNAPSHOT_VERSION, snapshot_at: snapshotAt, source: "listPlanningTechLeads", qualification: "current_pass_evidence_and_not_dismissed", pagination: "unbounded", total_count: leads.length,
  leads: leads.map((lead) => {
    const passEvidenceCount = listTechLeadEvidence(db, lead.id).length;
    return { lead_id: lead.id, topic_id: lead.topic_id, lead_kind: lead.kind, evidence_count: passEvidenceCount, pass_evidence_count: passEvidenceCount, status: lead.status === "dismissed" ? "recommended" : lead.status, latest_evidence_at: lead.latest_evidence_at };
  }),
};
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

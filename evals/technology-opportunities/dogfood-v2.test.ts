import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLeadCandidates } from "../../src/lib/agents/tech-leads.js";
import { saveAnalysisBatch, saveValidationResult } from "../../src/lib/db/analysis.js";
import { openDb } from "../../src/lib/db/index.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";
import { upsertTechLeads } from "../../src/lib/db/tech-leads.js";
import type { AnalysisBatch, ContentItem, Source, Topic, ValidationResult } from "../../src/lib/types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../../src/lib/utils/source-quote-projection.js";
import { createBlindSampleManifest, createDeterministicMappingExport, createSealedExpectedArtifact, materializeActualLabels, scoreDogfoodLabels, validateDogfoodLabels, validateManifest, validateQualifiedTechLeadSnapshot, validateSealedExpectedArtifact, type ExpectedLabel, type QualifiedTechLeadSnapshot } from "./dogfood-v2.js";

const source = (): QualifiedTechLeadSnapshot => ({ snapshot_version: "qualified-tech-leads-snapshot-v2", snapshot_at: "2026-09-10T12:00:00.000Z", source: "listPlanningTechLeads", qualification: "current_pass_evidence_and_not_dismissed", pagination: "unbounded", total_count: 4,
  mapping_directions: [{ direction_id: "d1", topic_id: "topic-a", status: "active", version: 1, match_terms: ["alpha"], adjacent_terms: ["beta"], challenge_terms: ["risk"] }],
  leads: [
    { lead_id: "lead-a", topic_id: "topic-a", lead_kind: "tool", evidence_count: 1, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-09T12:00:00.000Z", title: "alpha tool", summary: "", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-b", topic_id: "topic-a", lead_kind: "model", evidence_count: 2, pass_evidence_count: 2, status: "watching", latest_evidence_at: "2026-09-01T12:00:00.000Z", title: "beta model", summary: "", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-c", topic_id: "topic-b", lead_kind: "tool", evidence_count: 4, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-08-01T12:00:00.000Z", title: "unmapped", summary: "", score: 40, evidence_score: 1, importance_score: 1 },
    { lead_id: "lead-d", topic_id: "topic-b", lead_kind: "other", evidence_count: 3, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-10T00:00:00.000Z", title: "also unmapped", summary: "", score: 40, evidence_score: 1, importance_score: 1 },
  ],
});
const options = { generatedAt: "2026-09-10T12:00:00.000Z", seed: "fixed-seed", count: 3, pilot: false };
const expected = (manifest: ReturnType<typeof createBlindSampleManifest>): ExpectedLabel[] => manifest.rows.map((row, index) => ({ ...row, expected_candidate: index === 0, expected_direction_id: index === 0 ? "d1" : null, expected_lane: index === 0 ? "core" : null, not_enough_evidence: false, exclusion_reason: index === 0 ? null : "direction_not_applicable" }));

function seedQualifiedDatabase(path: string) {
  const db = openDb(path);
  const topic: Topic = { id: "t", name: "T", keywords: ["agent"], language: "en", brief_schedule: "daily", enabled: true };
  const content: ContentItem = { id: "c", source_id: "s", url: "https://x/c", title: "c", author: null, published_at: "2026-09-09T00:00:00.000Z", fetched_at: "2026-09-09T00:00:00.000Z", language: "en", topic_ids: ["t"], tags: [], body: "Agent tool", body_kind: "article", raw_ref: "", content_hash: "c", fetch_status: "ok" };
  const batch: AnalysisBatch = { id: "b", topic_id: "t", time_window: { start: "2026-09-08", end: "2026-09-09" }, status: "done", no_significant_event: false, display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION, insights: [{ id: "i", topic_id: "t", type: "aggregation", event_id: "e", statement: "Agent tool", statement_citation_index: 1, headline: "", importance: 4, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", citations: [{ content_item_id: "c", citation_ref: "binding", claim: "Agent tool", quote: "Agent tool", locator: { paragraph_index: 0, char_start: 0, char_end: 10 } }], source_count: 1, multi_source: false, time_window: { start: "2026-09-08", end: "2026-09-09" }, confidence: null, language: "en", tags: ["tool"] }], display_coverage_audits: [{ insight_id: "i", candidate_id: "i", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage", decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash("Agent tool"), quote_sha256: sourceQuoteHash("Agent tool"), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-09T00:00:00.000Z" }] };
  const validation: ValidationResult = { checks: [{ insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
  insertTopic(db, topic);
  insertSource(db, { id: "s", name: "Source", type: "rss", endpoint: "x", topic_ids: ["t"], fetch_interval: "6h", backfill: null, enabled: true } as Source);
  insertContentItem(db, content);
  saveAnalysisBatch(db, batch);
  saveValidationResult(db, batch.id, validation);
  upsertTechLeads(db, extractLeadCandidates(batch, validation, new Map([[content.id, content]]), "2026-09-10T00:00:00.000Z"), "2026-09-10T00:00:00.000Z");
  db.close();
}

describe("technology opportunity dogfood v2", () => {
  it("requires strict versioned snapshot and rejects extra or malformed fields", () => {
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), total_count: 500 })).toThrow("qualified_snapshot_schema_invalid");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, status: "dismissed" as never }) })).toThrow("qualified_snapshot_lead_schema_invalid");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, unexpected: true }) as never })).toThrow("qualified_snapshot_lead_schema_invalid");
  });

  it("uses the complete TechLeadKind closed set and rejects unknown_kind at every artifact boundary", () => {
    const manifest = createBlindSampleManifest(source(), options);
    const sealed = createSealedExpectedArtifact(manifest, expected(manifest), "2026-09-10T13:00:00.000Z");
    const mapping = createDeterministicMappingExport(source());
    const labels = materializeActualLabels(source(), manifest, sealed, mapping, "2026-09-10T14:00:00.000Z");
    expect(source().leads.some((lead) => lead.lead_kind === "other")).toBe(true);
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, lead_kind: "unknown_kind" }) as never })).toThrow("qualified_snapshot_lead_schema_invalid");
    expect(() => validateManifest({ ...manifest, rows: manifest.rows.map((row, index) => index ? row : { ...row, lead_kind: "unknown_kind" }) as never })).toThrow("blind_manifest_row_schema_invalid");
    expect(() => createSealedExpectedArtifact(manifest, expected(manifest).map((row, index) => index ? row : { ...row, lead_kind: "unknown_kind" }) as never, "2026-09-10T13:00:00.000Z")).toThrow("expected_label_schema_invalid");
    expect(() => validateSealedExpectedArtifact({ ...sealed, labels: sealed.labels.map((row, index) => index ? row : { ...row, lead_kind: "unknown_kind" }) } as never, manifest)).toThrow();
    expect(() => validateDogfoodLabels({ ...labels, labels: labels.labels.map((row, index) => index ? row : { ...row, lead_kind: "unknown_kind" }) } as never, source(), manifest, sealed, mapping)).toThrow();
  });

  it("requires the sealed expected-only artifact and immutable deterministic mapping at score time", () => {
    const manifest = createBlindSampleManifest(source(), options);
    const sealed = createSealedExpectedArtifact(manifest, expected(manifest), "2026-09-10T13:00:00.000Z");
    const mapping = createDeterministicMappingExport(source());
    expect(JSON.stringify(sealed)).not.toContain("actual_");
    const labels = materializeActualLabels(source(), manifest, sealed, mapping, "2026-09-10T14:00:00.000Z");
    expect(scoreDogfoodLabels(labels, source(), manifest, sealed, mapping)).toMatchObject({ total: 3, pilot: false });
    expect(() => materializeActualLabels(source(), manifest, { ...sealed, labels: sealed.labels.map((x) => ({ ...x, actual_candidate: false })) } as never, mapping, "2026-09-10T14:00:00.000Z")).toThrow("sealed_artifact_schema_invalid");
    expect(() => scoreDogfoodLabels({ ...labels, labels: labels.labels.map((x, i) => i ? x : { ...x, actual_candidate: !x.actual_candidate }) }, source(), manifest, sealed, mapping)).toThrow("label_file_schema_invalid");
    expect(() => scoreDogfoodLabels(labels, source(), manifest, sealed, { ...mapping, records: mapping.records.map((x, i) => i ? x : { ...x, candidate: false, direction_id: null, lane: null }) })).toThrow();
  });

  it("runs the documented export→sample→seal→mapping→materialize→score CLI contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "dogfood-v2-"));
    try {
      const paths = ["seeded.db", "snapshot.json", "manifest.json", "expected.json", "sealed.json", "mapping.json", "labels.json"].map((name) => join(dir, name));
      seedQualifiedDatabase(paths[0]);
      const run = (script: string, args: string[]) => execFileSync("npm", ["run", script, "--", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DB_PATH: paths[0] } });
      run("eval:opportunity-export", [paths[1], options.generatedAt]);
      const snapshot = JSON.parse(readFileSync(paths[1], "utf8")) as QualifiedTechLeadSnapshot;
      expect(snapshot.total_count).toBe(1);
      run("eval:opportunity-sample", [paths[1], paths[2], options.seed, "1"]);
      const manifest = JSON.parse(readFileSync(paths[2], "utf8")) as ReturnType<typeof createBlindSampleManifest>;
      writeFileSync(paths[3], JSON.stringify(expected(manifest)));
      run("eval:opportunity-seal", [paths[2], paths[3], paths[4], "2026-09-10T13:00:00.000Z"]);
      run("eval:opportunity-mapping-export", [paths[1], paths[5]]);
      run("eval:opportunity-materialize", [paths[1], paths[2], paths[4], paths[5], paths[6], "2026-09-10T14:00:00.000Z"]);
      const scoreOutput = run("eval:opportunity-map", [paths[6], paths[1], paths[2], paths[4], paths[5]]);
      expect(JSON.parse(scoreOutput.slice(scoreOutput.indexOf("{")))).toMatchObject({ total: 1 });
      expect(JSON.parse(readFileSync(paths[3], "utf8"))).not.toHaveProperty("actual_candidate");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

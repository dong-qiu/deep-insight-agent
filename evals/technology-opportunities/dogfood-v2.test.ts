import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlindSampleManifest, createDeterministicMappingExport, createSealedExpectedArtifact, materializeActualLabels, scoreDogfoodLabels, validateQualifiedTechLeadSnapshot, type ExpectedLabel, type QualifiedTechLeadSnapshot } from "./dogfood-v2.js";

const source = (): QualifiedTechLeadSnapshot => ({ snapshot_version: "qualified-tech-leads-snapshot-v2", snapshot_at: "2026-09-10T12:00:00.000Z", source: "listPlanningTechLeads", qualification: "current_pass_evidence_and_not_dismissed", pagination: "unbounded", total_count: 4,
  mapping_directions: [{ direction_id: "d1", topic_id: "topic-a", status: "active", version: 1, match_terms: ["alpha"], adjacent_terms: ["beta"], challenge_terms: ["risk"] }],
  leads: [
    { lead_id: "lead-a", topic_id: "topic-a", lead_kind: "tool", evidence_count: 1, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-09T12:00:00.000Z", title: "alpha tool", summary: "", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-b", topic_id: "topic-a", lead_kind: "model", evidence_count: 2, pass_evidence_count: 2, status: "watching", latest_evidence_at: "2026-09-01T12:00:00.000Z", title: "beta model", summary: "", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-c", topic_id: "topic-b", lead_kind: "tool", evidence_count: 4, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-08-01T12:00:00.000Z", title: "unmapped", summary: "", score: 40, evidence_score: 1, importance_score: 1 },
    { lead_id: "lead-d", topic_id: "topic-b", lead_kind: "tool", evidence_count: 3, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-10T00:00:00.000Z", title: "also unmapped", summary: "", score: 40, evidence_score: 1, importance_score: 1 },
  ],
});
const options = { generatedAt: "2026-09-10T12:00:00.000Z", seed: "fixed-seed", count: 3, pilot: false };
const expected = (manifest: ReturnType<typeof createBlindSampleManifest>): ExpectedLabel[] => manifest.rows.map((row, index) => ({ ...row, expected_candidate: index === 0, expected_direction_id: index === 0 ? "d1" : null, expected_lane: index === 0 ? "core" : null, not_enough_evidence: false, exclusion_reason: index === 0 ? null : "direction_not_applicable" }));

describe("technology opportunity dogfood v2", () => {
  it("requires strict versioned snapshot and rejects extra or malformed fields", () => {
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), total_count: 500 })).toThrow("qualified_snapshot_schema_invalid");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, status: "dismissed" as never }) })).toThrow("qualified_snapshot_lead_schema_invalid");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, unexpected: true }) as never })).toThrow("qualified_snapshot_lead_schema_invalid");
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
      const paths = ["snapshot.json", "manifest.json", "expected.json", "sealed.json", "mapping.json", "labels.json"].map((name) => join(dir, name));
      writeFileSync(paths[0], JSON.stringify(source()));
      const manifest = createBlindSampleManifest(source(), options); writeFileSync(paths[2], JSON.stringify(expected(manifest)));
      const run = (script: string, args: string[]) => execFileSync("npx", ["tsx", script, ...args], { cwd: process.cwd(), encoding: "utf8" });
      run("evals/build-opportunity-dogfood-v2-sample.ts", [paths[0], paths[1], options.seed, String(options.count)]);
      run("evals/seal-opportunity-dogfood-v2.ts", [paths[1], paths[2], paths[3], "2026-09-10T13:00:00.000Z"]);
      run("evals/export-opportunity-dogfood-v2-mapping.ts", [paths[0], paths[4]]);
      run("evals/materialize-opportunity-dogfood-v2.ts", [paths[0], paths[1], paths[3], paths[4], paths[5], "2026-09-10T14:00:00.000Z"]);
      expect(JSON.parse(run("evals/score-opportunity-map.ts", [paths[5], paths[0], paths[1], paths[3], paths[4]]))).toMatchObject({ total: 3 });
      expect(JSON.parse(readFileSync(paths[3], "utf8"))).not.toHaveProperty("actual_candidate");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

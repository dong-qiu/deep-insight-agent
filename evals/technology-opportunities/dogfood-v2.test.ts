import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBlindSampleManifest, createSealedExpectedArtifact, materializeActualLabels, scoreDogfoodLabels, validateDogfoodLabels, validateQualifiedTechLeadSnapshot, type ExpectedLabel, type QualifiedTechLeadSnapshot } from "./dogfood-v2.js";

const source = (): QualifiedTechLeadSnapshot => ({ snapshot_version: "qualified-tech-leads-snapshot-v1", snapshot_at: "2026-09-10T12:00:00.000Z", source: "listPlanningTechLeads", qualification: "current_pass_evidence_and_not_dismissed", pagination: "unbounded", total_count: 4, leads: [
  { lead_id: "lead-a", topic_id: "topic-a", lead_kind: "tool", evidence_count: 1, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-09T12:00:00.000Z" },
  { lead_id: "lead-b", topic_id: "topic-a", lead_kind: "model", evidence_count: 2, pass_evidence_count: 2, status: "watching", latest_evidence_at: "2026-09-01T12:00:00.000Z" },
  { lead_id: "lead-c", topic_id: "topic-b", lead_kind: "tool", evidence_count: 4, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-08-01T12:00:00.000Z" },
  { lead_id: "lead-d", topic_id: "topic-b", lead_kind: "tool", evidence_count: 3, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-10T00:00:00.000Z" },
] });
const options = { generatedAt: "2026-09-10T12:00:00.000Z", seed: "fixed-seed", count: 3, pilot: true };
const expected = (manifest: ReturnType<typeof createBlindSampleManifest>): ExpectedLabel[] => manifest.rows.map((row, index) => ({ ...row, expected_candidate: index !== 1, expected_direction_id: index === 0 ? "d1" : index === 2 ? "d2" : null, expected_lane: index === 0 ? "core" : index === 2 ? "challenge" : null, not_enough_evidence: false, exclusion_reason: index === 1 ? "direction_not_applicable" : null }));

describe("technology opportunity dogfood v2", () => {
  it("requires a complete versioned qualified export and binds the snapshot", () => {
    const manifest = createBlindSampleManifest(source(), options);
    expect(createBlindSampleManifest(source(), options)).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain("lead-a");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), source: "opportunity_pool" as never })).toThrow("qualified_snapshot_wrong_source_or_attestation");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), total_count: 500 })).toThrow("qualified_snapshot_truncated_or_invalid");
    expect(() => validateQualifiedTechLeadSnapshot({ ...source(), leads: source().leads.map((lead, index) => index ? lead : { ...lead, status: "dismissed" as never }) })).toThrow("qualified_snapshot_unqualified_lead");
  });

  it("seals expected-only rows before exact actual materialization", () => {
    const manifest = createBlindSampleManifest(source(), options); const sealed = createSealedExpectedArtifact(manifest, expected(manifest), "2026-09-10T13:00:00.000Z");
    expect(JSON.stringify(sealed)).not.toContain("lead-a"); expect(JSON.stringify(sealed)).not.toContain("actual_");
    const labels = materializeActualLabels(source(), manifest, sealed, { "lead-a": { candidate: true, direction_id: "d1", lane: "core" }, "lead-b": { candidate: true, direction_id: null, lane: "horizon" }, "lead-c": { candidate: false, direction_id: null, lane: null }, "lead-d": { candidate: false, direction_id: null, lane: null } }, "2026-09-10T14:00:00.000Z");
    expect(scoreDogfoodLabels(labels, manifest, sealed)).toMatchObject({ total: 3, pilot: true });
    expect(() => scoreDogfoodLabels({ ...labels, labels: [...labels.labels].reverse() }, manifest, sealed)).toThrow("label_manifest_row_mismatch");
    expect(() => scoreDogfoodLabels({ ...labels, labels: labels.labels.map((row, index) => index ? row : { ...row, expected_lane: "adjacent" }) }, manifest, sealed)).toThrow("sealed_expected_mutated");
  });

  it("rejects strict booleans, lanes, and non-candidate fields", () => {
    const manifest = createBlindSampleManifest(source(), options); const sealed = createSealedExpectedArtifact(manifest, expected(manifest), "2026-09-10T13:00:00.000Z");
    const labels = materializeActualLabels(source(), manifest, sealed, { "lead-a": { candidate: true, direction_id: "d1", lane: "core" }, "lead-b": { candidate: true, direction_id: null, lane: "horizon" }, "lead-c": { candidate: false, direction_id: null, lane: null }, "lead-d": { candidate: false, direction_id: null, lane: null } }, "2026-09-10T14:00:00.000Z");
    expect(() => validateDogfoodLabels({ ...labels, labels: [{ ...labels.labels[0], actual_candidate: "false" as never }, ...labels.labels.slice(1)] }, manifest, sealed)).toThrow("label_row_schema_invalid");
    expect(() => validateDogfoodLabels({ ...labels, labels: [{ ...labels.labels[0], actual_lane: "unknown" as never }, ...labels.labels.slice(1)] }, manifest, sealed)).toThrow("label_row_schema_invalid");
    expect(() => validateDogfoodLabels({ ...labels, labels: [{ ...labels.labels[0], actual_candidate: false, actual_direction_id: "d1" }, ...labels.labels.slice(1)] }, manifest, sealed)).toThrow("非候选不得带 direction/lane");
  });

  it("scores the fixed pilot only as a protocol fixture", () => {
    const manifest = JSON.parse(readFileSync("evals/technology-opportunities/pilot-v2.blind-manifest.json", "utf8")); const labels = JSON.parse(readFileSync("evals/technology-opportunities/pilot-v2.labels.json", "utf8"));
    validateDogfoodLabels(labels, manifest); expect(manifest.rows).toHaveLength(20); expect(scoreDogfoodLabels(labels, manifest)).toMatchObject({ pilot: true, total: 20 });
  });
});

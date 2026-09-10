import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBlindSampleManifest, scoreDogfoodLabels, validateDogfoodLabels, type DogfoodLabelFile } from "./dogfood-v2.js";

describe("technology opportunity dogfood v2", () => {
  it("samples the qualified TechLead population deterministically without exposing IDs or outcomes", () => {
    const population = [
      { lead_id: "lead-a", topic_id: "topic-a", lead_kind: "tool", evidence_count: 1, latest_evidence_at: "2026-09-09T12:00:00.000Z" },
      { lead_id: "lead-b", topic_id: "topic-a", lead_kind: "model", evidence_count: 2, latest_evidence_at: "2026-09-01T12:00:00.000Z" },
      { lead_id: "lead-c", topic_id: "topic-b", lead_kind: "tool", evidence_count: 4, latest_evidence_at: "2026-08-01T12:00:00.000Z" },
      { lead_id: "lead-d", topic_id: "topic-b", lead_kind: "tool", evidence_count: 3, latest_evidence_at: "2026-09-10T00:00:00.000Z" },
    ];
    const options = { generatedAt: "2026-09-10T12:00:00.000Z", seed: "fixed-seed", count: 3, pilot: true };
    const first = createBlindSampleManifest(population, options);
    expect(createBlindSampleManifest(population, options)).toEqual(first);
    expect(first.population_source).toBe("qualified_tech_leads");
    expect(first.rows).toHaveLength(3);
    expect(first.rows.map((row) => Object.keys(row).sort())).toEqual(first.rows.map(() => ["evidence_band", "freshness_band", "lead_kind", "sample_id", "topic_id"]));
    expect(JSON.stringify(first)).not.toContain("lead-a");
  });

  it("reports candidate precision/recall, coverage, matrices and reasoned error attribution", () => {
    const labels: DogfoodLabelFile = {
      protocol_version: "technology-opportunity-dogfood-v2", generated_at: "2026-09-10T00:00:00.000Z", pilot: true,
      labels: [
        { sample_id: "a", topic_id: "topic-a", lead_kind: "tool", evidence_band: "1", freshness_band: "0-48h", expected_candidate: true, actual_candidate: true, expected_direction_id: "d1", actual_direction_id: "d1", expected_lane: "core", actual_lane: "core", not_enough_evidence: false, exclusion_reason: null },
        { sample_id: "b", topic_id: "topic-a", lead_kind: "model", evidence_band: "2-3", freshness_band: "0-48h", expected_candidate: false, actual_candidate: true, expected_direction_id: null, actual_direction_id: null, expected_lane: null, actual_lane: "horizon", not_enough_evidence: false, exclusion_reason: "direction_not_applicable" },
        { sample_id: "c", topic_id: "topic-b", lead_kind: "tool", evidence_band: "4+", freshness_band: "14d+", expected_candidate: true, actual_candidate: false, expected_direction_id: "d2", actual_direction_id: null, expected_lane: "challenge", actual_lane: null, not_enough_evidence: false, exclusion_reason: null },
        { sample_id: "d", topic_id: "topic-b", lead_kind: "paper", evidence_band: "1", freshness_band: "49h-14d", expected_candidate: false, actual_candidate: false, expected_direction_id: null, actual_direction_id: null, expected_lane: null, actual_lane: null, not_enough_evidence: true, exclusion_reason: "not_enough_evidence" },
      ],
    };
    const result = scoreDogfoodLabels(labels);
    expect(result).toMatchObject({ total: 4, scored_total: 3, excluded_not_enough_evidence: 1, candidate: { true_positive: 1, false_positive: 1, false_negative: 1, precision: 0.5, recall: 0.5 } });
    expect(result.confusion_matrices.candidate).toEqual({ true: { true: 1, false: 1 }, false: { true: 1 } });
    expect(result.stratified_coverage.by_topic["topic-b"]).toMatchObject({ total: 2, scored: 1 });
    expect(result.misclassification_attribution.map((item) => item.reason)).toEqual(["missed_expected_candidate", "unexpected_candidate:direction_not_applicable"]);
  });

  it("ships a fixed 20-row, de-identified usability pilot and scores it as a pilot only", () => {
    const manifest = JSON.parse(readFileSync("evals/technology-opportunities/pilot-v2.blind-manifest.json", "utf8")) as { rows: Array<{ sample_id: string }> };
    const labels = JSON.parse(readFileSync("evals/technology-opportunities/pilot-v2.labels.json", "utf8")) as DogfoodLabelFile;
    validateDogfoodLabels(labels);
    expect(manifest.rows).toHaveLength(20);
    expect(labels.labels).toHaveLength(20);
    expect(labels.labels.map((row) => row.sample_id)).toEqual(manifest.rows.map((row) => row.sample_id));
    expect(scoreDogfoodLabels(labels)).toMatchObject({ pilot: true, total: 20 });
  });
});

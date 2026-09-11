import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlindSampleManifest, type QualifiedTechLeadSnapshot } from "./dogfood-v2.js";
import { createOwnerReviewPack } from "./review-pack-v1.js";

const snapshot = (): QualifiedTechLeadSnapshot => ({
  snapshot_version: "qualified-tech-leads-snapshot-v2",
  snapshot_at: "2026-09-10T12:00:00.000Z",
  source: "listPlanningTechLeads",
  qualification: "current_pass_evidence_and_not_dismissed",
  pagination: "unbounded",
  total_count: 4,
  mapping_directions: [
    { direction_id: "dir-active", topic_id: "topic-a", status: "active", version: 1, match_terms: ["private-direction-term"], adjacent_terms: ["private-adjacent-term"], challenge_terms: ["private-challenge-term"] },
    { direction_id: "dir-retired", topic_id: "topic-b", status: "retired", version: 1, match_terms: ["old"], adjacent_terms: [], challenge_terms: [] },
  ],
  leads: [
    { lead_id: "lead-a", topic_id: "topic-a", lead_kind: "tool", evidence_count: 1, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-09T12:00:00.000Z", title: "alpha tool", summary: "summary a", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-b", topic_id: "topic-a", lead_kind: "model", evidence_count: 2, pass_evidence_count: 2, status: "watching", latest_evidence_at: "2026-09-01T12:00:00.000Z", title: "beta model", summary: "summary b", score: 70, evidence_score: 12, importance_score: 12 },
    { lead_id: "lead-c", topic_id: "topic-b", lead_kind: "tool", evidence_count: 4, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-08-01T12:00:00.000Z", title: "gamma tool", summary: "summary c", score: 40, evidence_score: 1, importance_score: 1 },
    { lead_id: "lead-d", topic_id: "topic-b", lead_kind: "other", evidence_count: 3, pass_evidence_count: 1, status: "recommended", latest_evidence_at: "2026-09-10T00:00:00.000Z", title: "delta other", summary: "summary d", score: 40, evidence_score: 1, importance_score: 1 },
  ],
});

const options = { generatedAt: "2026-09-10T12:00:00.000Z", seed: "fixed-seed", count: 3, pilot: false };
const restrictedNames = [
  ["a", "ctual", "_candidate"].join(""),
  ["a", "ctual", "_direction_id"].join(""),
  ["a", "ctual", "_lane"].join(""),
  ["mapping", "_digest"].join(""),
];

describe("Owner review pack", () => {
  it("rebuilds a fixed blind sample into the same one-to-one lead inventory", () => {
    const manifest = createBlindSampleManifest(snapshot(), options);
    const first = createOwnerReviewPack(snapshot(), manifest, options.seed);
    const second = createOwnerReviewPack(snapshot(), manifest, options.seed);

    expect(first).toEqual(second);
    expect(first.samples.map((sample) => sample.sample_id)).toEqual(manifest.rows.map((row) => row.sample_id));
    expect(first.samples.map((sample) => sample.lead_id)).toEqual(["lead-a", "lead-b", "lead-c"]);
    expect(first.samples).toHaveLength(new Set(first.samples.map((sample) => sample.lead_id)).size);
    expect(first.allowed_direction_ids).toEqual(["dir-active"]);
    expect(first.input_digests.qualified_tech_leads_snapshot).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for truncated snapshots, tampered manifests, duplicated identifiers, and the wrong seed", () => {
    const manifest = createBlindSampleManifest(snapshot(), options);
    expect(() => createOwnerReviewPack({ ...snapshot(), total_count: 3 }, manifest, options.seed)).toThrow("qualified_snapshot_schema_invalid");
    expect(() => createOwnerReviewPack(snapshot(), { ...manifest, rows: manifest.rows.map((row, index) => index ? row : { ...row, topic_id: "topic-b" }) }, options.seed)).toThrow("owner_review_pack_snapshot_or_manifest_mismatch");
    expect(() => createOwnerReviewPack(snapshot(), { ...manifest, rows: [manifest.rows[0], manifest.rows[0], manifest.rows[2]] }, options.seed)).toThrow("blind_manifest_row_schema_invalid");
    expect(() => createOwnerReviewPack({ ...snapshot(), leads: [...snapshot().leads, { ...snapshot().leads[0] }], total_count: 5 }, manifest, options.seed)).toThrow("qualified_snapshot_duplicate_lead_id");
    expect(() => createOwnerReviewPack(snapshot(), manifest, "wrong-seed")).toThrow("owner_review_pack_seed_mismatch");
  });

  it("creates a private file once and keeps serialization and process output free of restricted fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-review-pack-"));
    try {
      const snapshotPath = join(dir, "snapshot.json");
      const manifestPath = join(dir, "manifest.json");
      const outputPath = join(dir, "review-pack.json");
      const manifest = createBlindSampleManifest(snapshot(), options);
      writeFileSync(snapshotPath, JSON.stringify(snapshot()));
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const run = () => spawnSync("npm", ["run", "eval:opportunity-review-pack", "--", snapshotPath, manifestPath, options.seed, outputPath], { cwd: process.cwd(), encoding: "utf8" });
      const created = run();
      expect(created.status).toBe(0);
      const artifact = readFileSync(outputPath, "utf8");
      for (const name of restrictedNames) {
        expect(artifact).not.toContain(name);
        expect(created.stdout + created.stderr).not.toContain(name);
      }
      expect(artifact).not.toContain("private-direction-term");
      const protocol = readFileSync(join(process.cwd(), "evals/technology-opportunities/README.md"), "utf8");
      const ownerSection = protocol.split("3. Owner")[1]?.split("4. ")[0] ?? "";
      for (const name of restrictedNames) expect(ownerSection).not.toContain(name);

      const existing = run();
      expect(existing.status).not.toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(artifact);
      for (const name of restrictedNames) expect(existing.stdout + existing.stderr).not.toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDatasetLock } from "./a1-dataset-lock.js";
import {
  bindConsistencyLabelDataset,
  verifyConsistencyLabelReceipt,
  type ConsistencyBlindReviewerSubmission,
} from "./a1-consistency-label-receipt.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "a1-lock-"));
  roots.push(root);
  const dir = join(root, "evals/dataset");
  // Tests make a deliberately tiny but distribution-valid v2 snapshot.  Source text is not
  // committed; this only proves the lock verifier's contract.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "quality.jsonl"), Array.from({ length: 5 }, (_, i) => JSON.stringify({ topic: { id: `t${i}` } })).join("\n"));
  const consistency = Array.from({ length: 100 }, (_, index) => {
    const negative = index < 40;
    return JSON.stringify({
      id: `case-${index}`, statement: `Controlled conclusion ${index}.`, source_text: `Controlled source evidence ${index}.`,
      expected_consistency: negative ? "not_support" : "support",
      ...(negative ? { negative_type: ["exaggeration", "out_of_context", "misattribution"][index % 3] } : {}),
    });
  }).join("\n");
  writeFileSync(join(dir, "consistency.jsonl"), consistency);
  writeFileSync(join(dir, "display.json"), "{\"cases\":[]}\n");
  return root;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function controlledFiles() {
  return {
    qualityFile: "evals/dataset/quality.jsonl", consistencyFile: "evals/dataset/consistency.jsonl", displayCoverageFixture: "evals/dataset/display.json",
    consistencyReceiptFile: "evals/dataset/consistency-label-receipt.json",
  };
}

function writeFormalReceipt(root: string): string {
  const dataset = join(root, "evals/dataset");
  const binding = bindConsistencyLabelDataset(join(dataset, "consistency.jsonl"));
  const reviewer = (reviewerId: string): ConsistencyBlindReviewerSubmission => ({
    reviewer_id: reviewerId, reviewer_kind: "human", blind_attestation: true,
    decisions: binding.cases.map((entry) => ({
      case_id: entry.id, pair_sha256: entry.pair_sha256, expected_consistency: entry.expected_consistency,
      ...(entry.negative_type ? { negative_type: entry.negative_type } : {}),
    })),
  });
  const receipt = verifyConsistencyLabelReceipt(binding, [reviewer("reviewer-a"), reviewer("reviewer-b")], []);
  const path = join(dataset, "consistency-label-receipt.json");
  writeFileSync(path, `${JSON.stringify(receipt)}\n`);
  return path;
}

function writeLock(root: string, overrides: Record<string, unknown> = {}): string {
  const dataset = join(root, "evals/dataset");
  const receipt = writeFormalReceipt(root);
  const lock = {
    schema_version: "a1-dataset-lock-v1", id: "controlled-v2", tier: "controlled_snapshot_v2",
    snapshot: {
      immutable_reference: "s3://controlled/a1-v2/manifest",
      collected_at: "2026-09-10T00:00:00Z",
      source_manifest_reference: "s3://controlled/a1-v2/sources.json",
      source_manifest_sha256: "a".repeat(64),
      license_and_retention: "internal retention=90d",
      object_lock_retain_until: "2026-12-09T00:00:00Z",
      source_terms_decision: {
        record_id: "A1-V2-TERMS-001",
        sha256: "b".repeat(64),
        status: "approved_all",
        approved_at: "2026-09-11T00:00:00Z",
        permitted_retention_until: "2026-12-09T00:00:00Z",
      },
    },
    files: {
      quality: { path: "evals/dataset/quality.jsonl", sha256: hash(join(dataset, "quality.jsonl")) },
      consistency: { path: "evals/dataset/consistency.jsonl", sha256: hash(join(dataset, "consistency.jsonl")) },
      display_coverage: { path: "evals/dataset/display.json", sha256: hash(join(dataset, "display.json")) },
    },
    quality_contract: { min_unique_topics: 5, dedupe_key: "content_item_id_or_url" },
    consistency_contract: { min_total: 100, min_not_support: 40, required_negative_types: ["exaggeration", "out_of_context", "misattribution"] },
    topic_mapping_rule: "topic id",
    labeling_provenance: {
      receipt_reference: "s3://controlled/a1-v2/consistency-label-receipt.json?versionId=opaque",
      receipt_sha256: hash(receipt), status: "eligible_for_lock",
    },
    ...overrides,
  };
  const path = join(dataset, "lock.json");
  writeFileSync(path, `${JSON.stringify(lock)}\n`);
  return path;
}

describe("A1 dataset lock", () => {
  it("marks the committed source-text fixture as regression-only legacy, not promotable v2 evidence", () => {
    expect(validateDatasetLock("evals/dataset/dataset-lock.json", {
      qualityFile: "evals/dataset/insight-quality.jsonl",
      consistencyFile: "evals/dataset/citation-consistency.jsonl",
      displayCoverageFixture: "evals/dataset/display-coverage-benchmark.json",
    })).toMatchObject({ status: "verified_legacy", promotion_eligible: false, issues: [] });
  });

  it("accepts only a byte-matched controlled v2 snapshot with the required distribution", () => {
    const root = fixtureRoot();
    const lock = writeLock(root);
    expect(validateDatasetLock(lock, controlledFiles(), root)).toMatchObject({ status: "verified_v2", promotion_eligible: true, issues: [] });
  });

  it("accepts the microsecond-precision UTC instant returned by S3 Object Lock", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, {
      snapshot: {
        immutable_reference: "s3://controlled/a1-v2/manifest",
        collected_at: "2026-09-10T00:00:00Z",
        source_manifest_reference: "s3://controlled/a1-v2/sources.json",
        source_manifest_sha256: "a".repeat(64), license_and_retention: "internal retention=90d",
        object_lock_retain_until: "2026-12-09T00:00:00.960000Z",
        source_terms_decision: {
          record_id: "A1-V2-TERMS-001", sha256: "b".repeat(64), status: "approved_all",
          approved_at: "2026-09-11T00:00:00Z", permitted_retention_until: "2026-12-09T00:00:00.960000Z",
        },
      },
    });
    expect(validateDatasetLock(lock, controlledFiles(), root)).toMatchObject({ status: "verified_v2", promotion_eligible: true, issues: [] });
  });

  it("rejects a changed byte or a path outside the controlled dataset root", () => {
    const root = fixtureRoot();
    const lock = writeLock(root);
    writeFileSync(join(root, "evals/dataset/quality.jsonl"), "{\"topic\":{\"id\":\"changed\"}}\n");
    const result = validateDatasetLock(lock, { ...controlledFiles(), qualityFile: "../outside.jsonl" }, root);
    expect(result.status).toBe("invalid");
    expect(result.issues.join(" ")).toMatch(/路径穿越|不一致/);
  });

  it("rejects v2 data missing a negative class even when its total is large", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, { consistency_contract: { min_total: 100, min_not_support: 40, required_negative_types: ["exaggeration", "out_of_context", "misattribution"] } });
    const file = join(root, "evals/dataset/consistency.jsonl");
    writeFileSync(file, [...Array.from({ length: 40 }, () => JSON.stringify({ expected_consistency: "not_support", negative_type: "exaggeration" })), ...Array.from({ length: 60 }, () => JSON.stringify({ expected_consistency: "support" }))].join("\n"));
    const result = validateDatasetLock(lock, controlledFiles(), root);
    expect(result.issues.join(" ")).toContain("out_of_context");
  });

  it("rejects v2 locks without a complete, hashed source-terms owner decision", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, {
      snapshot: {
        immutable_reference: "s3://controlled/a1-v2/manifest",
        collected_at: "2026-09-10T00:00:00Z",
        source_manifest_reference: "s3://controlled/a1-v2/sources.json",
        source_manifest_sha256: "a".repeat(64),
        license_and_retention: "internal retention=90d",
        object_lock_retain_until: "2026-12-09T00:00:00Z",
      },
    });
    const result = validateDatasetLock(lock, controlledFiles(), root);
    expect(result).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(result.issues.join(" ")).toContain("完整且已哈希的来源条款 owner 决策");
  });

  it("rejects v2 locks whose source-terms owner decision is not approved_all", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, {
      snapshot: {
        immutable_reference: "s3://controlled/a1-v2/manifest",
        collected_at: "2026-09-10T00:00:00Z",
        source_manifest_reference: "s3://controlled/a1-v2/sources.json",
        source_manifest_sha256: "a".repeat(64),
        license_and_retention: "internal retention=90d",
        object_lock_retain_until: "2026-12-09T00:00:00Z",
        source_terms_decision: {
          record_id: "A1-V2-TERMS-001",
          sha256: "b".repeat(64),
          status: "blocked",
          approved_at: "2026-09-11T00:00:00Z",
          permitted_retention_until: "2026-12-09T00:00:00Z",
        },
      },
    });
    const result = validateDatasetLock(lock, controlledFiles(), root);
    expect(result).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(result.issues.join(" ")).toContain("来源条款 owner 决策未获全部批准");
  });

  it("rejects v2 locks whose permitted source retention ends before Object Lock", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, {
      snapshot: {
        immutable_reference: "s3://controlled/a1-v2/manifest",
        collected_at: "2026-09-10T00:00:00Z",
        source_manifest_reference: "s3://controlled/a1-v2/sources.json",
        source_manifest_sha256: "a".repeat(64),
        license_and_retention: "internal retention=90d",
        object_lock_retain_until: "2026-12-09T00:00:00Z",
        source_terms_decision: {
          record_id: "A1-V2-TERMS-001",
          sha256: "b".repeat(64),
          status: "approved_all",
          approved_at: "2026-09-11T00:00:00Z",
          permitted_retention_until: "2026-10-11T00:00:00Z",
        },
      },
    });
    const result = validateDatasetLock(lock, controlledFiles(), root);
    expect(result).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(result.issues.join(" ")).toContain("来源许可保留期早于 Object Lock 保留期");
  });

  it("rejects a prose-only, ineligible, or unhashed human-label claim for a v2 lock", () => {
    const root = fixtureRoot();
    const lock = writeLock(root, { labeling_provenance: "two independent human labels" });
    const result = validateDatasetLock(lock, controlledFiles(), root);
    expect(result).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(result.issues.join(" ")).toContain("双人标签 receipt");
  });

  it("rejects a v2 lock when its actual receipt is absent, prototype-only, or missing formal human provenance", () => {
    const root = fixtureRoot();
    const lock = writeLock(root);
    const withoutReceipt = validateDatasetLock(lock, { ...controlledFiles(), consistencyReceiptFile: undefined }, root);
    expect(withoutReceipt).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(withoutReceipt.issues.join(" ")).toContain("实际 consistency label receipt 文件");

    const receiptPath = join(root, "evals/dataset/consistency-label-receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify({
      schema_version: "a1-v2-ai-assisted-receipt-v1", status: "prototype_ai_assisted", lock_eligible: false,
    })}\n`);
    const lockValue = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    const labels = lockValue.labeling_provenance as Record<string, unknown>;
    labels.receipt_sha256 = hash(receiptPath);
    writeFileSync(lock, `${JSON.stringify(lockValue)}\n`);
    const prototype = validateDatasetLock(lock, controlledFiles(), root);
    expect(prototype).toMatchObject({ status: "invalid", promotion_eligible: false });
    expect(prototype.issues.join(" ")).toContain("AI-assisted/prototype receipt 不可用于 v2 lock");
  });
});

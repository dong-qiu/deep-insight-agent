import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { consistencyPairHash, type ConsistencyLabelCase } from "./a1-consistency-label-receipt.js";
import {
  derivePrototypeBoundaryReview,
  PROTOTYPE_BOUNDARY_REVIEW_BINDING_VERSION,
  PROTOTYPE_BOUNDARY_REVIEW_RECEIPT_VERSION,
  resolvePrototypeBoundaryReviewCliPaths,
} from "./a1-prototype-boundary-review.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const rows: ConsistencyLabelCase[] = [
    { id: "p1", statement: "claim one", source_text: "source one", expected_consistency: "support" },
    { id: "p2", statement: "claim two", source_text: "source two", expected_consistency: "not_support", negative_type: "exaggeration" },
    { id: "p3", statement: "claim three", source_text: "source three", expected_consistency: "uncertain" },
  ];
  const parentBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const parentReceiptBytes = Buffer.from(JSON.stringify({
    schema_version: "a1-v2-ai-assisted-receipt-v1", status: "prototype_ai_assisted", lock_eligible: false,
    final_dataset_sha256: hash(parentBytes), human_adjudication_mode: "human_with_ai_advice", human_adjudication_blind_attestation: false,
  }));
  const review = {
    schema_version: "a1-v2-validator-boundary-review-progress-v1", run_id: "run-1", purpose: "test", status: "completed",
    decisions: [
      { case_index: 0, original_human_label: "support", final_human_label: "uncertain" },
      { case_index: 1, original_human_label: "not_support", original_negative_type: "exaggeration", final_human_label: "not_support", negative_type: "misattribution" },
    ],
  };
  const reviewBytes = Buffer.from(JSON.stringify(review));
  const pair = (row: ConsistencyLabelCase) => consistencyPairHash(row);
  const binding = {
    schema_version: PROTOTYPE_BOUNDARY_REVIEW_BINDING_VERSION, status: "completed",
    promotion_limits: { prototype_only: true, receipt_status: "prototype_ai_assisted", lock_eligible: false, baseline_eligible: false, dcp_eligible: false },
    parents: {
      final_labels: {
        sha256: hash(parentBytes), receipt_sha256: hash(parentReceiptBytes), receipt_schema_version: "a1-v2-ai-assisted-receipt-v1",
        receipt_status: "prototype_ai_assisted", human_adjudication_mode: "human_with_ai_advice", human_adjudication_blind_attestation: false,
      },
      boundary_review: { run_id: "run-1", sha256: hash(reviewBytes), decision_count: 2 },
    },
    reviewed_pairs: [0, 1].map((case_index) => ({ case_index, id: rows[case_index]!.id, pair_sha256: pair(rows[case_index]!) })),
    final_output_overrides: [
      { id: "p1", pair_sha256: pair(rows[0]), from: { expected_consistency: "support" }, to: { expected_consistency: "uncertain" } },
      { id: "p2", pair_sha256: pair(rows[1]), from: { expected_consistency: "not_support", negative_type: "exaggeration" }, to: { expected_consistency: "not_support", negative_type: "misattribution" } },
    ],
    summary: { reviewed_pairs: 2, changed_label_count: 1, changed_negative_type_count: 1, changed_output_row_count: 2 },
  };
  return { parentBytes, parentReceiptBytes, reviewBytes, bindingBytes: Buffer.from(JSON.stringify(binding)) };
}

describe("derivePrototypeBoundaryReview", () => {
  it("derives only bound human-reviewed changes and preserves the prototype-only boundary", () => {
    const input = fixture();
    const result = derivePrototypeBoundaryReview(input.parentBytes, input.parentReceiptBytes, input.reviewBytes, input.bindingBytes);
    const rows = result.datasetBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toEqual([
      { id: "p1", statement: "claim one", source_text: "source one", expected_consistency: "uncertain" },
      { id: "p2", statement: "claim two", source_text: "source two", expected_consistency: "not_support", negative_type: "misattribution" },
      { id: "p3", statement: "claim three", source_text: "source three", expected_consistency: "uncertain" },
    ]);
    expect(result.receipt).toMatchObject({
      schema_version: PROTOTYPE_BOUNDARY_REVIEW_RECEIPT_VERSION,
      status: "prototype_ai_assisted",
      lock_eligible: false,
      human_adjudication_mode: "human_with_ai_advice",
      human_adjudication_blind_attestation: false,
      boundary_review: { reviewed_pair_count: 2, changed_label_count: 1, changed_negative_type_count: 1, changed_output_row_count: 2 },
    });
    expect(result.receipt.distribution).toMatchObject({ total: 3, support: 0, uncertain: 2, not_support: 1, negative_types: { misattribution: 1 } });
  });

  it("rejects a parent whose bytes differ from the hash bound by the review", () => {
    const input = fixture();
    expect(() => derivePrototypeBoundaryReview(Buffer.from(`${input.parentBytes} `), input.parentReceiptBytes, input.reviewBytes, input.bindingBytes)).toThrow(/父标签字节/);
  });

  it("rejects an override that is not the exact reviewed outcome", () => {
    const input = fixture();
    const binding = JSON.parse(input.bindingBytes.toString("utf8"));
    binding.final_output_overrides[0].to = { expected_consistency: "support" };
    expect(() => derivePrototypeBoundaryReview(input.parentBytes, input.parentReceiptBytes, input.reviewBytes, Buffer.from(JSON.stringify(binding)))).toThrow(/binding override/);
  });

  it("rejects any attempt to reclassify the parent receipt as lock-eligible", () => {
    const input = fixture();
    const receipt = JSON.parse(input.parentReceiptBytes.toString("utf8"));
    receipt.lock_eligible = true;
    expect(() => derivePrototypeBoundaryReview(input.parentBytes, Buffer.from(JSON.stringify(receipt)), input.reviewBytes, input.bindingBytes)).toThrow(/parent receipt/);
  });

  it("preserves extra parent audit fields while changing only the reviewed outcome", () => {
    const input = fixture();
    const rows = input.parentBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    rows[0].audit = { source_archive_sha256: "a".repeat(64), retained_by: "controlled-runner" };
    const parentBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const receipt = JSON.parse(input.parentReceiptBytes.toString("utf8"));
    receipt.final_dataset_sha256 = hash(parentBytes);
    const parentReceiptBytes = Buffer.from(JSON.stringify(receipt));
    const binding = JSON.parse(input.bindingBytes.toString("utf8"));
    binding.parents.final_labels.sha256 = hash(parentBytes);
    binding.parents.final_labels.receipt_sha256 = hash(parentReceiptBytes);
    binding.reviewed_pairs[0].pair_sha256 = consistencyPairHash(rows[0]);
    binding.final_output_overrides[0].pair_sha256 = consistencyPairHash(rows[0]);
    const result = derivePrototypeBoundaryReview(parentBytes, parentReceiptBytes, input.reviewBytes, Buffer.from(JSON.stringify(binding)));
    expect(JSON.parse(result.datasetBytes.toString("utf8").split("\n")[0]!)).toMatchObject({
      audit: { source_archive_sha256: "a".repeat(64), retained_by: "controlled-runner" },
      expected_consistency: "uncertain",
    });
  });

  it("rejects not_support review decisions that omit their original negative type", () => {
    const input = fixture();
    const review = JSON.parse(input.reviewBytes.toString("utf8"));
    delete review.decisions[1].original_negative_type;
    expect(() => derivePrototypeBoundaryReview(input.parentBytes, input.parentReceiptBytes, Buffer.from(JSON.stringify(review)), input.bindingBytes))
      .toThrow(/缺少 original_negative_type/);
  });
});

describe("resolvePrototypeBoundaryReviewCliPaths", () => {
  function controlledFiles() {
    const root = mkdtempSync(join(tmpdir(), "a1-prototype-boundary-"));
    const outputDirectory = join(root, "derived");
    mkdirSync(outputDirectory);
    const files = ["parent.local.jsonl", "parent-receipt.local.json", "review.json", "binding.json"]
      .map((name) => join(root, name));
    for (const file of files) writeFileSync(file, "{}\n");
    return { root, outputDirectory, files };
  }

  it("requires an explicit non-repository controlled root for all inputs and outputs", () => {
    const { root, outputDirectory, files } = controlledFiles();
    const outputPath = join(outputDirectory, "derived.local.jsonl");
    const receiptPath = join(outputDirectory, "derived-receipt.local.json");
    expect(resolvePrototypeBoundaryReviewCliPaths([...files, outputPath, receiptPath], { EVAL_ISOLATED_ROOT: root }))
      .toMatchObject({ outputPath: join(realpathSync(outputDirectory), "derived.local.jsonl"), outputReceiptPath: join(realpathSync(outputDirectory), "derived-receipt.local.json") });
    expect(() => resolvePrototypeBoundaryReviewCliPaths([...files, outputPath, receiptPath], {}))
      .toThrow(/必须显式设置 EVAL_ISOLATED_ROOT/);
  });

  it("rejects a repository output, parent-directory escape, and output symlink", () => {
    const { root, outputDirectory, files } = controlledFiles();
    const receiptPath = join(outputDirectory, "derived-receipt.local.json");
    const escapedOutput = join(root, "..", "derived.local.jsonl");
    expect(() => resolvePrototypeBoundaryReviewCliPaths([...files, escapedOutput, receiptPath], { EVAL_ISOLATED_ROOT: root }))
      .toThrow(/必须位于 EVAL_ISOLATED_ROOT 内/);
    const linkedOutput = join(outputDirectory, "linked.local.jsonl");
    symlinkSync(join(tmpdir(), "outside.local.jsonl"), linkedOutput);
    expect(() => resolvePrototypeBoundaryReviewCliPaths([...files, linkedOutput, receiptPath], { EVAL_ISOLATED_ROOT: root }))
      .toThrow(/不得是符号链接/);
    expect(() => resolvePrototypeBoundaryReviewCliPaths([...files, join(process.cwd(), "derived.local.jsonl"), receiptPath], { EVAL_ISOLATED_ROOT: process.cwd() }))
      .toThrow(/不得位于仓库内/);
  });
});

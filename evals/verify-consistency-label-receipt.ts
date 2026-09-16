/**
 * Usage: npm run labels:receipt -- <consistency-v2.local.jsonl> <blind-labels.json> [receipt.json]
 *
 * `blind-labels.json` contains exactly two human submissions and any third-person adjudications.
 * It contains hashes and decisions only; source text stays in the controlled JSONL input.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJson } from "./a1-artifacts.js";
import {
  bindConsistencyLabelDataset,
  verifyConsistencyLabelReceipt,
  type ConsistencyBlindReviewerSubmission,
  type ConsistencyLabelAdjudication,
} from "./a1-consistency-label-receipt.js";

const [datasetPath, reviewsPath, outputArg] = process.argv.slice(2);
if (!datasetPath || !reviewsPath) {
  console.error("用法：npm run labels:receipt -- <consistency-v2.local.jsonl> <blind-labels.json> [receipt.json]");
  process.exit(2);
}
const input = JSON.parse(readFileSync(reviewsPath, "utf8")) as {
  reviewers?: ConsistencyBlindReviewerSubmission[];
  adjudications?: ConsistencyLabelAdjudication[];
};
const isLabel = (value: unknown): boolean => value === "support" || value === "not_support" || value === "uncertain";
const isNegativeType = (value: unknown): boolean => value === "exaggeration" || value === "out_of_context" || value === "misattribution";
const isDecision = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  return isLabel(decision.expected_consistency)
    && (decision.expected_consistency === "not_support" ? isNegativeType(decision.negative_type) : decision.negative_type == null);
};
const isMark = (value: unknown): boolean => {
  if (!isDecision(value)) return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.case_id === "string" && typeof mark.pair_sha256 === "string";
};
const isReviewer = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const reviewer = value as Record<string, unknown>;
  return typeof reviewer.reviewer_id === "string"
    && (reviewer.reviewer_kind === "human" || reviewer.reviewer_kind === "ai")
    && reviewer.blind_attestation === true
    && Array.isArray(reviewer.decisions) && reviewer.decisions.every(isMark);
};
const isAdjudication = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const adjudication = value as Record<string, unknown>;
  return typeof adjudication.case_id === "string"
    && typeof adjudication.adjudicator_id === "string"
    && (adjudication.adjudicator_kind === "human" || adjudication.adjudicator_kind === "ai")
    && isDecision(adjudication.decision);
};
if (!Array.isArray(input.reviewers) || !Array.isArray(input.adjudications ?? [])
  || !input.reviewers.every(isReviewer) || !(input.adjudications ?? []).every(isAdjudication)) {
  console.error("blind-labels.json 必须包含 reviewers[] 和可选 adjudications[]");
  process.exit(2);
}
const receipt = verifyConsistencyLabelReceipt(
  bindConsistencyLabelDataset(datasetPath),
  input.reviewers,
  input.adjudications ?? [],
);
const outputPath = outputArg ?? join(dirname(datasetPath), "consistency-label-receipt.json");
writeJson(outputPath, receipt);
console.log(`已写入 ${outputPath}：${receipt.status}`);
if (receipt.issues.length) console.error(receipt.issues.map((issue) => `- ${issue}`).join("\n"));
process.exit(receipt.status === "eligible_for_lock" ? 0 : 1);

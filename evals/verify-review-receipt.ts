/**
 * Usage: npm run review:receipt -- <manifest.json> <review-queue.json> <blind-reviews.json> [review-receipt.json]
 *
 * The input contains two independent, blind human submissions and any required third-person
 * adjudications. The output is additive evidence; it never mutates the A1 manifest or queue.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJson } from "./a1-artifacts.js";
import { bindReviewArtifacts, verifyReviewReceipt, type BlindReviewerSubmission, type ReviewAdjudication } from "./a1-review-receipt.js";

const [manifestPath, queuePath, inputPath, outputArg] = process.argv.slice(2);
if (!manifestPath || !queuePath || !inputPath) {
  console.error("用法：npm run review:receipt -- <manifest.json> <review-queue.json> <blind-reviews.json> [review-receipt.json]");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
  reviewers?: BlindReviewerSubmission[];
  adjudications?: ReviewAdjudication[];
};
const validMark = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.insight_id === "string"
    && typeof mark.insight_text_sha256 === "string"
    && typeof mark.non_obvious === "boolean"
    && typeof mark.hallucination === "boolean"
    && typeof mark.importance_reasonable === "boolean";
};
const validReviewer = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const reviewer = value as Record<string, unknown>;
  return typeof reviewer.reviewer_id === "string" && reviewer.blind_attestation === true && Array.isArray(reviewer.decisions) && reviewer.decisions.every(validMark);
};
const validAdjudication = (value: unknown): boolean => {
  if (value == null || typeof value !== "object") return false;
  const adjudication = value as Record<string, unknown>;
  return typeof adjudication.insight_id === "string"
    && typeof adjudication.adjudicator_id === "string"
    && adjudication.decision != null
    && typeof adjudication.decision === "object"
    && typeof (adjudication.decision as Record<string, unknown>).non_obvious === "boolean"
    && typeof (adjudication.decision as Record<string, unknown>).hallucination === "boolean"
    && typeof (adjudication.decision as Record<string, unknown>).importance_reasonable === "boolean";
};
if (!Array.isArray(input.reviewers) || !Array.isArray(input.adjudications ?? []) || !input.reviewers.every(validReviewer) || !(input.adjudications ?? []).every(validAdjudication)) {
  console.error("blind-reviews.json 必须包含 reviewers[] 和可选 adjudications[]");
  process.exit(2);
}
const binding = bindReviewArtifacts(manifestPath, queuePath);
const receipt = verifyReviewReceipt(binding, input.reviewers, input.adjudications ?? []);
const outputPath = outputArg ?? join(dirname(manifestPath), "review-receipt.json");
writeJson(outputPath, receipt);
console.log(`已写入 ${outputPath}：${receipt.status}`);
if (receipt.issues.length) console.error(receipt.issues.map((issue) => `- ${issue}`).join("\n"));
process.exit(receipt.status === "eligible_for_signoff" ? 0 : 1);

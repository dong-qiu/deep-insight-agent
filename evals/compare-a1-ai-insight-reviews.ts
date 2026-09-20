/**
 * Usage:
 * npm run review:ai-compare -- <manifest.json> <review-queue.json> <validator.local.json> <coverage.local.json> <disputes.local.json> <receipt.local.json>
 *
 * The generated dispute pack deliberately contains AI advice, so any human who reads it is in
 * `human_with_ai_advice` mode. It is prototype-only and never eligible for review:receipt/DCP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bindReviewArtifacts } from "./a1-review-receipt.js";
import {
  AI_INSIGHT_REVIEW_VERSION,
  compareAiInsightReviews,
  type AiInsightReviewerSubmission,
} from "./a1-ai-insight-review.js";

const [manifestPath, queuePath, firstPath, secondPath, disputesPath, receiptPath] = process.argv.slice(2);
if (!manifestPath || !queuePath || !firstPath || !secondPath || !disputesPath || !receiptPath) {
  console.error("用法：npm run review:ai-compare -- <manifest.json> <review-queue.json> <validator.local.json> <coverage.local.json> <disputes.local.json> <receipt.local.json>");
  process.exit(2);
}
if (!disputesPath.endsWith(".local.json") || !receiptPath.endsWith(".local.json")) {
  throw new Error("dispute 与 receipt 输出必须以 .local.json 结尾，防止诊断证据进入 Git");
}
if (existsSync(disputesPath) || existsSync(receiptPath)) throw new Error("AI 双审输出已存在，拒绝覆盖诊断证据");

const binding = bindReviewArtifacts(manifestPath, queuePath);
const queue = JSON.parse(readFileSync(queuePath, "utf8")) as { insights?: Array<Record<string, unknown> & { id: string }> };
if (!Array.isArray(queue.insights)) throw new Error("review queue 缺少 insights");
const first = JSON.parse(readFileSync(firstPath, "utf8")) as AiInsightReviewerSubmission;
const second = JSON.parse(readFileSync(secondPath, "utf8")) as AiInsightReviewerSubmission;
const { receipt, consensus_ids: consensusIds, disputes } = compareAiInsightReviews(binding, first, second);
if (receipt.issues.length) throw new Error(`AI 双审输入不合格：${receipt.issues.join("；")}`);
const byId = new Map(queue.insights.map((insight) => [insight.id, insight]));
const disputePack = {
  schema_version: AI_INSIGHT_REVIEW_VERSION,
  status: "diagnostic_only",
  lock_eligible: false,
  human_adjudication_mode: "human_with_ai_advice",
  binding: receipt.binding,
  note: "This pack deliberately includes AI labels and rationales. Human decisions based on it are not blind and cannot be used for review:receipt, baseline promotion, DCP, or release sign-off.",
  consensus_ids: consensusIds,
  disputes: disputes.map((dispute) => ({
    insight: byId.get(dispute.insight_id),
    disputed_fields: dispute.fields,
    reviewer_advice: { validator: dispute.first, coverage: dispute.second },
  })),
};
for (const dispute of disputePack.disputes) if (!dispute.insight) throw new Error("分歧项不属于当前 review queue");
mkdirSync(dirname(disputesPath), { recursive: true });
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(disputesPath, `${JSON.stringify(disputePack, null, 2)}\n`, { flag: "wx" });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(`AI 双审完成：整条一致 ${receipt.agreement.consensus_count} 条；字段一致 ${receipt.agreement.field_consensus_count} 项，待人工裁决 ${receipt.agreement.field_dispute_count} 个字段（分布于 ${receipt.agreement.dispute_count} 条，均仅 diagnostic_only）`);

/**
 * Usage:
 * npm run review:ai-human-record -- <manifest.json> <review-queue.json> <ai-review-receipt.local.json> <ai-disputes.local.json> <human-progress.local.json> <opaque-human-id> <record.local.json>
 *
 * This writes a hash-bound diagnostic record for a human who has seen AI advice. It is explicitly
 * incompatible with review:receipt, baseline promotion, DCP, and release sign-off.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { bindReviewArtifacts } from "./a1-review-receipt.js";
import {
  AI_INSIGHT_REVIEW_VERSION,
  bindAiInsightHumanAdjudication,
  type AiInsightHumanAdjudicationProgress,
  type AiInsightReviewReceipt,
} from "./a1-ai-insight-review.js";

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const [manifestPath, queuePath, receiptPath, disputesPath, progressPath, adjudicatorId, outputPath] = process.argv.slice(2);
if (!manifestPath || !queuePath || !receiptPath || !disputesPath || !progressPath || !adjudicatorId || !outputPath) {
  console.error("用法：npm run review:ai-human-record -- <manifest.json> <review-queue.json> <ai-review-receipt.local.json> <ai-disputes.local.json> <human-progress.local.json> <opaque-human-id> <record.local.json>");
  process.exit(2);
}
if (!receiptPath.endsWith(".local.json") || !disputesPath.endsWith(".local.json") || !progressPath.endsWith(".local.json") || !outputPath.endsWith(".local.json")) {
  throw new Error("AI 辅助 human adjudication 的 receipt、dispute、progress 与输出必须均为 .local.json");
}
if (existsSync(outputPath)) throw new Error("AI 辅助 human insight adjudication 已存在，拒绝覆盖人工决定");

const receiptBytes = readFileSync(receiptPath);
const disputesBytes = readFileSync(disputesPath);
const progressBytes = readFileSync(progressPath);
const receipt = JSON.parse(receiptBytes.toString("utf8")) as AiInsightReviewReceipt;
const disputes = JSON.parse(disputesBytes.toString("utf8")) as {
  schema_version?: string;
  status?: string;
  lock_eligible?: boolean;
  human_adjudication_mode?: string;
  disputes?: Array<{ insight?: { id?: string } }>;
};
if (disputes.schema_version !== AI_INSIGHT_REVIEW_VERSION || disputes.status !== "diagnostic_only" || disputes.lock_eligible !== false
  || disputes.human_adjudication_mode !== "human_with_ai_advice" || !Array.isArray(disputes.disputes)) {
  throw new Error("AI dispute pack 不是合格的 diagnostic_only human_with_ai_advice 产物");
}
const disputeIds = disputes.disputes.map((item) => item.insight?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
if (disputeIds.length !== disputes.disputes.length) throw new Error("AI dispute pack 含无效 insight id");
const binding = bindReviewArtifacts(manifestPath, queuePath);
const record = bindAiInsightHumanAdjudication(
  binding,
  receipt,
  disputeIds,
  JSON.parse(progressBytes.toString("utf8")) as AiInsightHumanAdjudicationProgress,
  adjudicatorId,
  {
    ai_review_receipt_sha256: hash(receiptBytes),
    dispute_pack_sha256: hash(disputesBytes),
    progress_sha256: hash(progressBytes),
  },
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
console.log(`已写入 ${record.decisions.length} 条 AI 辅助 human insight adjudication（human_with_ai_advice；lock_eligible=false）：${outputPath}`);

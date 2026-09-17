/**
 * Bind completed, AI-advised chat decisions to the immutable AI-disagreement population.
 *
 * Usage: npm run labels:ai-chat-to-adjudication -- <disputes.local.jsonl> <chat-progress.local.json> <opaque-human-id> <adjudication.local.json>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import {
  bindAiAssistedChatAdjudication,
  type AiAssistedChatAdjudicationProgress,
} from "./a1-consistency-ai-assisted.js";

const hash = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const [disputesPath, progressPath, adjudicatorId, outputPath] = process.argv.slice(2);
if (!disputesPath || !progressPath || !adjudicatorId || !outputPath) {
  console.error("用法：npm run labels:ai-chat-to-adjudication -- <disputes.local.jsonl> <chat-progress.local.json> <opaque-human-id> <adjudication.local.json>");
  process.exit(2);
}
if (!disputesPath.endsWith(".local.jsonl") || !progressPath.endsWith(".local.json") || !outputPath.endsWith(".local.json")) {
  throw new Error("disputes/progress/output 必须分别以 .local.jsonl/.local.json/.local.json 结尾");
}
if (existsSync(outputPath)) throw new Error("AI 辅助 human adjudication 已存在，拒绝覆盖人工决定");
const disputeBytes = readFileSync(disputesPath);
const input = disputeBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const disputes = readConsistencyBlindWorklist(input);
if (!disputes.length || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== disputes[index]?.pair_sha256)) {
  throw new Error("AI dispute worklist 必须非空且未被修改");
}
const progress = JSON.parse(readFileSync(progressPath, "utf8")) as AiAssistedChatAdjudicationProgress;
const adjudication = bindAiAssistedChatAdjudication(disputes, hash(disputeBytes), progress, adjudicatorId);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(adjudication, null, 2)}\n`, { flag: "wx" });
console.log(`已写入 ${adjudication.decisions.length} 条 AI 辅助 human adjudication（blind_attestation=false）：${outputPath}`);

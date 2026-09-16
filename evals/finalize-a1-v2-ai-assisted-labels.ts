/**
 * Finalize a prototype-only consistency JSONL after all AI disagreements have a human decision.
 *
 * Usage: npm run labels:ai-finalize -- <worklist.local.jsonl> <validator.local.json> <coverage.local.json> <adjudication.local.json|none> <final.local.jsonl> <receipt.local.json>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import {
  finalizeAiAssistedReviews,
  type AiAssistedHumanAdjudication,
  type AiAssistedReviewerSubmission,
} from "./a1-consistency-ai-assisted.js";

const hash = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const [worklistPath, firstPath, secondPath, adjudicationPath, finalPath, receiptPath] = process.argv.slice(2);
if (!worklistPath || !firstPath || !secondPath || !adjudicationPath || !finalPath || !receiptPath) {
  console.error("用法：npm run labels:ai-finalize -- <worklist.local.jsonl> <validator.local.json> <coverage.local.json> <adjudication.local.json|none> <final.local.jsonl> <receipt.local.json>");
  process.exit(2);
}
if (!finalPath.endsWith(".local.jsonl") || !receiptPath.endsWith(".local.json")) throw new Error("final/receipt 必须以 .local.jsonl/.local.json 结尾");
if (existsSync(finalPath) || existsSync(receiptPath)) throw new Error("final/receipt 已存在，拒绝覆盖受控标签证据");
const worklistBytes = readFileSync(worklistPath);
const input = worklistBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const worklist = makeConsistencyBlindWorklist(input);
if (worklist.length !== 100 || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== worklist[index]?.pair_sha256)) {
  throw new Error("worklist 必须是完整、未修改的 100 条 blind worklist");
}
const first = JSON.parse(readFileSync(firstPath, "utf8")) as AiAssistedReviewerSubmission;
const second = JSON.parse(readFileSync(secondPath, "utf8")) as AiAssistedReviewerSubmission;
const adjudication = adjudicationPath === "none" ? null : JSON.parse(readFileSync(adjudicationPath, "utf8")) as AiAssistedHumanAdjudication;
const finalized = finalizeAiAssistedReviews(worklist, hash(worklistBytes), first, second, adjudication);
if (finalized.receipt.status !== "prototype_ai_assisted") throw new Error(`AI-assisted finalization 不合格：${finalized.receipt.issues.join("；")}`);
const finalBytes = Buffer.from(`${finalized.cases.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
if (hash(finalBytes) !== finalized.receipt.final_dataset_sha256) throw new Error("AI-assisted final JSONL hash 未与 receipt 一致");
mkdirSync(dirname(finalPath), { recursive: true });
writeFileSync(finalPath, finalBytes, { flag: "wx" });
writeFileSync(receiptPath, `${JSON.stringify(finalized.receipt, null, 2)}\n`, { flag: "wx" });
console.log(`已写入 ${finalized.cases.length} 条 prototype_ai_assisted 标签；lock_eligible=false；receipt=${receiptPath}`);

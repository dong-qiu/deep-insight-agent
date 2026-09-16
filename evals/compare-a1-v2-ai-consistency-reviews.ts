/**
 * Compare the two AI reviewer submissions and prepare a label-free human dispute worklist.
 *
 * Usage: npm run labels:ai-compare -- <worklist.local.jsonl> <validator.local.json> <coverage.local.json> <disputes.local.jsonl> <receipt.local.json>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { compareAiAssistedReviews, type AiAssistedReviewerSubmission } from "./a1-consistency-ai-assisted.js";

const hash = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const [worklistPath, firstPath, secondPath, disputesPath, receiptPath] = process.argv.slice(2);
if (!worklistPath || !firstPath || !secondPath || !disputesPath || !receiptPath) {
  console.error("用法：npm run labels:ai-compare -- <worklist.local.jsonl> <validator.local.json> <coverage.local.json> <disputes.local.jsonl> <receipt.local.json>");
  process.exit(2);
}
if (!disputesPath.endsWith(".local.jsonl") || !receiptPath.endsWith(".local.json")) throw new Error("disputes/receipt 必须分别以 .local.jsonl/.local.json 结尾");
if (existsSync(disputesPath) || existsSync(receiptPath)) throw new Error("AI 对比产物已存在，拒绝覆盖诊断或人工裁决输入");
const worklistBytes = readFileSync(worklistPath);
const input = worklistBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const worklist = makeConsistencyBlindWorklist(input);
if (worklist.length !== 100 || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== worklist[index]?.pair_sha256)) {
  throw new Error("worklist 必须是完整、未修改的 100 条 blind worklist");
}
const first = JSON.parse(readFileSync(firstPath, "utf8")) as AiAssistedReviewerSubmission;
const second = JSON.parse(readFileSync(secondPath, "utf8")) as AiAssistedReviewerSubmission;
const compared = compareAiAssistedReviews(worklist, hash(worklistBytes), first, second);
if (compared.receipt.status !== "prototype_ai_assisted") throw new Error(`AI reviewer 对比不合格：${compared.receipt.issues.join("；")}`);
mkdirSync(dirname(disputesPath), { recursive: true });
writeFileSync(disputesPath, `${compared.disputes.map((row) => JSON.stringify(row)).join("\n")}${compared.disputes.length ? "\n" : ""}`, { flag: "wx" });
writeFileSync(receiptPath, `${JSON.stringify(compared.receipt, null, 2)}\n`, { flag: "wx" });
console.log(`AI 对比完成：${compared.disputes.length}/100 条分歧已写入无标签 human dispute worklist；receipt=${receiptPath}`);

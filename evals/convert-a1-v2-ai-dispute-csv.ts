/**
 * Convert a completed dispute CSV into the one human adjudication submission.
 *
 * Usage: npm run labels:ai-dispute-to-adjudication -- <disputes.local.jsonl> <filled.local.csv> <human-id> <adjudication.local.json>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { blindLabelCsvToSubmission } from "./a1-consistency-label-csv.js";
import { AI_ASSISTED_ADJUDICATION_VERSION, pairPopulationSha, type AiAssistedHumanAdjudication } from "./a1-consistency-ai-assisted.js";

const [disputesPath, csvPath, adjudicatorId, outputPath] = process.argv.slice(2);
if (!disputesPath || !csvPath || !adjudicatorId || !outputPath) {
  console.error("用法：npm run labels:ai-dispute-to-adjudication -- <disputes.local.jsonl> <filled.local.csv> <human-id> <adjudication.local.json>");
  process.exit(2);
}
if (!csvPath.endsWith(".local.csv") || !outputPath.endsWith(".local.json")) throw new Error("CSV/裁决输出必须以 .local.csv/.local.json 结尾");
if (existsSync(outputPath)) throw new Error("human adjudication 已存在，拒绝覆盖人工决定");
const input = readFileSync(disputesPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const disputes = makeConsistencyBlindWorklist(input);
if (!disputes.length || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== disputes[index]?.pair_sha256)) {
  throw new Error("AI dispute worklist 必须非空且未被修改");
}
const submission = blindLabelCsvToSubmission(disputes, readFileSync(csvPath, "utf8"), adjudicatorId);
const adjudication: AiAssistedHumanAdjudication = {
  schema_version: AI_ASSISTED_ADJUDICATION_VERSION,
  adjudicator_id: submission.reviewer_id,
  adjudicator_kind: "human",
  blind_attestation: true,
  dispute_pair_population_sha256: pairPopulationSha(disputes),
  decisions: submission.decisions,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(adjudication, null, 2)}\n`, { flag: "wx" });
console.log(`已写入 ${adjudication.decisions.length} 条 ${adjudication.adjudicator_id} 的 human adjudication：${outputPath}`);

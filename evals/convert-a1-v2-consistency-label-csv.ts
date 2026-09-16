/**
 * Convert one completed human worksheet into one receipt-ready blind submission.
 *
 * Usage: npm run labels:csv-to-submission -- <worklist.local.jsonl> <filled.local.csv> <reviewer-id> <submission.local.json>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { blindLabelCsvToSubmission } from "./a1-consistency-label-csv.js";

const [worklistPath, csvPath, reviewerId, outputPath] = process.argv.slice(2);
if (!worklistPath || !csvPath || !reviewerId || !outputPath) {
  console.error("用法：npm run labels:csv-to-submission -- <worklist.local.jsonl> <filled.local.csv> <reviewer-id> <submission.local.json>");
  process.exit(2);
}
if (!csvPath.endsWith(".local.csv") || !outputPath.endsWith(".local.json")) {
  throw new Error("填写表和提交文件必须分别以 .local.csv、.local.json 结尾，防止受控数据进入 Git");
}
if (existsSync(outputPath)) throw new Error("提交文件已存在，拒绝覆盖已冻结的人类决定");
const input = readFileSync(worklistPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const worklist = makeConsistencyBlindWorklist(input);
if (worklist.length !== 100 || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== worklist[index]?.pair_sha256)) {
  throw new Error("worklist 必须是完整、未修改的 100 条 blind worklist");
}
const submission = blindLabelCsvToSubmission(worklist, readFileSync(csvPath, "utf8"), reviewerId);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(submission, null, 2)}\n`, { flag: "wx" });
console.log(`已写入 ${submission.decisions.length} 条 ${submission.reviewer_id} 的独立 human 盲标提交：${outputPath}`);

/**
 * Create a human-only CSV for just the disputed AI labels. AI decisions are intentionally absent.
 *
 * Usage: npm run labels:ai-dispute-csv -- <disputes.local.jsonl> <adjudication.local.csv>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { makeBlindLabelCsv } from "./a1-consistency-label-csv.js";

const [disputesPath, outputPath] = process.argv.slice(2);
if (!disputesPath || !outputPath) {
  console.error("用法：npm run labels:ai-dispute-csv -- <disputes.local.jsonl> <adjudication.local.csv>");
  process.exit(2);
}
if (!outputPath.endsWith(".local.csv")) throw new Error("human adjudication CSV 必须以 .local.csv 结尾");
if (existsSync(outputPath)) throw new Error("human adjudication CSV 已存在，拒绝覆盖人工填写内容");
const input = readFileSync(disputesPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const disputes = readConsistencyBlindWorklist(input);
if (!disputes.length || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== disputes[index]?.pair_sha256)) {
  throw new Error("AI dispute worklist 必须非空且未被修改");
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, makeBlindLabelCsv(disputes), { flag: "wx" });
console.log(`已写入 ${disputes.length} 条 human adjudication CSV：${outputPath}（不含 AI 标签）`);

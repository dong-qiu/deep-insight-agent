/**
 * Create one spreadsheet-safe, unlabeled human worksheet from the immutable blind worklist.
 *
 * Usage: npm run labels:prepare-csv -- <worklist.local.jsonl> <reviewer-sheet.local.csv>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { makeBlindLabelCsv } from "./a1-consistency-label-csv.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const [worklistPath, outputPath] = process.argv.slice(2);
if (!worklistPath || !outputPath) {
  console.error("用法：npm run labels:prepare-csv -- <worklist.local.jsonl> <reviewer-sheet.local.csv>");
  process.exit(2);
}
if (!outputPath.endsWith(".local.csv")) throw new Error("标注表必须以 .local.csv 结尾，防止第三方原文进入 Git");
if (existsSync(outputPath)) throw new Error("标注表已存在，拒绝覆盖人工填写内容");
const input = readFileSync(worklistPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
const worklist = readConsistencyBlindWorklist(input);
if (worklist.length !== 100 || input.some((row, index) => (row as { pair_sha256?: unknown }).pair_sha256 !== worklist[index]?.pair_sha256)) {
  throw new Error("worklist 必须是完整、未修改的 100 条 blind worklist");
}
const output = makeBlindLabelCsv(worklist);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, { flag: "wx" });
console.log(`已写入 ${worklist.length} 条人工盲标 CSV：${outputPath}（SHA-256 ${hash(output)}）`);

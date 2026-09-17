/**
 * Reduce an unlabeled candidate JSONL to the exact source pair + binding hash used by blind
 * reviewers. The result contains third-party excerpts and therefore must remain `.local.jsonl`.
 *
 * Usage: npm run labels:prepare-blind-worklist -- <candidates.local.jsonl> <worklist.local.jsonl>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertCompletedCandidateManifest, makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";
import { candidateCheckpointPath } from "./a1-consistency-candidate-checkpoint.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const [candidatePath, outputPath] = process.argv.slice(2);
if (!candidatePath || !outputPath) {
  console.error("用法：npm run labels:prepare-blind-worklist -- <candidates.local.jsonl> <worklist.local.jsonl>");
  process.exit(2);
}
if (!outputPath.endsWith(".local.jsonl")) throw new Error("盲标 worklist 必须以 .local.jsonl 结尾，防止第三方原文进入 Git");
if (existsSync(outputPath)) throw new Error("盲标 worklist 已存在，拒绝覆盖受控人工输入");
const candidateBytes = readFileSync(candidatePath);
const diagnosticPath = candidatePath.replace(/\.local\.jsonl$/u, ".diagnostic.local.json");
if (!existsSync(diagnosticPath)) throw new Error("候选缺少 completed feasibility diagnostic，不能创建盲审 worklist");
const checkpointPath = candidateCheckpointPath(candidatePath);
if (!existsSync(checkpointPath)) throw new Error("候选缺少 completed feasibility checkpoint，不能创建盲审 worklist");
const rows = candidateBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
assertCompletedCandidateManifest(JSON.parse(readFileSync(diagnosticPath, "utf8")), candidateBytes, readFileSync(checkpointPath), rows);
const worklist = makeConsistencyBlindWorklist(rows);
if (worklist.length !== 100) throw new Error(`v2 盲标 worklist 要求恰有 100 条，当前 ${worklist.length}`);
const output = Buffer.from(`${worklist.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, { flag: "wx" });
console.log(`已写入 ${worklist.length} 条盲标 worklist：${outputPath}（SHA-256 ${hash(output)}）`);

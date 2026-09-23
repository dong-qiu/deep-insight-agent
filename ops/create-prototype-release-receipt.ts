import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPrototypeReleaseReceipt, writePrototypeReleaseArtifact } from "./prototype-release.js";

const [safetyPath, ciPath, output] = process.argv.slice(2);
if (!safetyPath || !ciPath || !output) {
  throw new Error("用法：tsx ops/create-prototype-release-receipt.ts <prototype-safety.json> <prototype-ci-evidence.json> <out.json>");
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain=v1"], { encoding: "utf8" }).trim()) {
  throw new Error("创建 prototype release receipt 要求干净 worktree");
}
const receipt = createPrototypeReleaseReceipt({
  commit,
  safetyReceipt: JSON.parse(readFileSync(safetyPath, "utf8")),
  ciEvidence: JSON.parse(readFileSync(ciPath, "utf8")),
});
writePrototypeReleaseArtifact(output, receipt);
console.log(`已写 prototype release receipt：${output}`);

import { createPrototypeCiEvidence, writePrototypeReleaseArtifact } from "./prototype-release.js";

const output = process.argv[2];
if (!output) throw new Error("用法：tsx ops/write-prototype-ci-evidence.ts <out.json>");

const testedCommit = process.env.GITHUB_SHA;
const commit = process.env.PROTOTYPE_CI_EVIDENCE_COMMIT ?? testedCommit;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
if (!commit || !testedCommit || !runId) throw new Error("CI evidence 要求 GitHub Actions runtime variables");

writePrototypeReleaseArtifact(output, createPrototypeCiEvidence({
  commit,
  testedCommit,
  runId,
  runAttempt,
}));
console.log(`已写 prototype CI evidence：${output}`);

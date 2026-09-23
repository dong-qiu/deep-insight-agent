import { createPrototypeCiEvidence, writePrototypeReleaseArtifact } from "./prototype-release.js";

const output = process.argv[2];
if (!output) throw new Error("用法：tsx ops/write-prototype-ci-evidence.ts <out.json>");

const commit = process.env.GITHUB_SHA;
const serverUrl = process.env.GITHUB_SERVER_URL;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
if (!commit || !serverUrl || !repository || !runId) throw new Error("CI evidence 要求 GitHub Actions runtime variables");

writePrototypeReleaseArtifact(output, createPrototypeCiEvidence({
  commit,
  runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  runId,
  runAttempt,
}));
console.log(`已写 prototype CI evidence：${output}`);

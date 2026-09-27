import { readFileSync } from "node:fs";
import { verifyReaderPerformanceEvidence } from "./report-reader-performance-policy.js";

const path = process.argv[2];
if (!path) throw new Error("report_reader_evidence_path_required");
const result = verifyReaderPerformanceEvidence(JSON.parse(readFileSync(path, "utf8")), process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA);
if (result.warning) {
  console.warn(`::warning::Report reader microbenchmark exceeds 5% warning budget (ratio=${result.observed_regression_ratio.toFixed(3)}, delta_ms=${result.observed_delta_ms.toFixed(6)}).`);
}
if (!result.passed) throw new Error("report reader microbenchmark exceeds BOTH 10% and 0.1 ms budgets");
console.log(`report reader performance gate: ${result.status}`);

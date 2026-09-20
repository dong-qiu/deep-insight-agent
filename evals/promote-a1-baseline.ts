/**
 * Usage: npm run baseline:promote -- <manifest.json> <a1-run.json> <stratum> [registry.json]
 * Explicit operator command: records a provisional run first and requires a second matching run
 * before it may be marked dcp_accepted. It does not rewrite historical baseline.json metrics.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJson } from "./a1-artifacts.js";
import { BASELINE_REGISTRY_VERSION, baselineCandidateFromArtifacts, promoteBaselineCandidate, type BaselineRecord } from "./a1-baseline-promotion.js";

const [manifestPath, a1RunPath, stratum, registryPath = "evals/baseline-registry.json"] = process.argv.slice(2);
if (!manifestPath || !a1RunPath || !stratum) {
  console.error("用法：npm run baseline:promote -- <manifest.json> <a1-run.json> <stratum> [registry.json]");
  process.exit(2);
}
const registry = existsSync(registryPath)
  ? JSON.parse(readFileSync(registryPath, "utf8")) as { schema_version?: string; strata?: Record<string, BaselineRecord | { status?: string }> }
  : { schema_version: BASELINE_REGISTRY_VERSION, strata: {} as Record<string, BaselineRecord | { status?: string }> };
if (registry.schema_version !== BASELINE_REGISTRY_VERSION || !registry.strata) {
  console.error(`不支持的 baseline registry：${registryPath}`);
  process.exit(2);
}
const existing = registry.strata[stratum];
const prior = existing?.status === "provisional" || existing?.status === "dcp_accepted" ? existing as BaselineRecord : undefined;
const result = promoteBaselineCandidate(baselineCandidateFromArtifacts(manifestPath, a1RunPath, stratum), prior);
if (!result.next) {
  console.error(result.reasons.map((reason) => `- ${reason}`).join("\n"));
  process.exit(1);
}
registry.strata[stratum] = result.next;
writeJson(registryPath, registry);
console.log(`${stratum} baseline → ${result.next.status}（run=${result.next.run_id}）`);

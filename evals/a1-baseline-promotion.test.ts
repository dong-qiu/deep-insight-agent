import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineCandidateFromArtifacts, comparableRegistryBaselineMetrics, formalA1GateExitCode, promoteBaselineCandidate, type BaselineCandidate } from "./a1-baseline-promotion.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const config = {
  analyzer_model: "a", analyzer_output_version: 1, analyzer_prompt_sha256: "p", analyze_body_chars: 1, analyze_batch_chars: 1, select_window_chars: 1,
  validator_model: "v", validator_contract_version: "v1", consistency_window_chars: 1, consistency_batch_max: 1,
  relay_recovery_policy_version: "r", relay_recovery_max_probes: 1, relay_recovery_max_backoff_wait_ms: 1, relay_recovery_exhausted_cooldown_ms: 1,
  coverage_model: "c", validator_thinking: true, coverage_thinking: true, coverage_thinking_source: "explicit" as const, structured_thinking_transport_version: "forced-tool-enabled-v1", validator_batch: true,
  quality_dataset_sha256: "q", consistency_dataset_sha256: "c", dataset_lock_sha256: "lock", dataset_lock_status: "verified_v2" as const,
  display_coverage_dataset_sha256: "d", quote_self_contained_dataset_sha256: "s", display_coverage_gate_version: "g", display_projection_version: "p",
  display_coverage_primary_prompt_version: "p", display_coverage_primary_prompt_sha256: "p", display_coverage_primary_response_budget_version: "output-4096-v1", display_coverage_primary_max_tokens: 4096, display_coverage_primary_claims_per_call: 1, display_coverage_countercheck_prompt_version: "c", display_coverage_countercheck_prompt_sha256: "c",
};
const candidate = (run_id: string): BaselineCandidate => ({
  run_id, stratum: "arxiv", manifest_sha256: "a".repeat(64), a1_run_sha256: "b".repeat(64), config,
  metrics: { reachability_pass: 1, consistency_ok: 0.98, consistency_failure: 0.02, flagged_rate: 0.01, judge_accuracy: 0.97, judge_neg_recall: 0.96, judge_completion: 1 },
  source: { commit: "main-sha", dirty_fingerprint: null }, smoke: false, status: "completed", auto_gate: "pass",
});

describe("A1 baseline promotion", () => {
  it("makes the first clean v2 pass provisional, never DCP accepted by itself", () => {
    expect(promoteBaselineCandidate(candidate("run-1"), undefined, "now")).toMatchObject({ next: { status: "provisional" }, reasons: [] });
  });

  it("requires a distinct second identical clean run before dcp_accepted", () => {
    const first = promoteBaselineCandidate(candidate("run-1"), undefined, "one").next!;
    expect(promoteBaselineCandidate(candidate("run-1"), first).reasons.join(" ")).toContain("不同 run_id");
    expect(promoteBaselineCandidate(candidate("run-2"), first, "two")).toMatchObject({ next: { status: "dcp_accepted", promoted_at: "two" } });
  });

  it("uses only an accepted registry record with matching config and finite saved metrics", () => {
    const provisional = promoteBaselineCandidate(candidate("run-1")).next!;
    const expectedKeys = Object.keys(candidate("reference").metrics);
    expect(comparableRegistryBaselineMetrics({ schema_version: "a1-baseline-registry-v1", strata: { arxiv: provisional } }, "arxiv", config, expectedKeys)).toBeNull();
    const accepted = promoteBaselineCandidate(candidate("run-2"), provisional).next!;
    expect(comparableRegistryBaselineMetrics({ schema_version: "a1-baseline-registry-v1", strata: { arxiv: accepted } }, "arxiv", config, expectedKeys))
      .toEqual(candidate("run-2").metrics);
    expect(comparableRegistryBaselineMetrics({ schema_version: "a1-baseline-registry-v1", strata: { arxiv: { ...accepted, metrics: { consistency_ok: 0.98 } } } }, "arxiv", config, expectedKeys)).toBeNull();
    expect(comparableRegistryBaselineMetrics({ schema_version: "a1-baseline-registry-v1", strata: { arxiv: { ...accepted, metrics: { ...accepted.metrics, consistency_ok: Number.NaN } } } }, "arxiv", config, expectedKeys)).toBeNull();
    expect(comparableRegistryBaselineMetrics({ schema_version: "a1-baseline-registry-v1", strata: { arxiv: accepted } }, "arxiv", { ...config, coverage_model: "different" }, expectedKeys)).toBeNull();
  });

  it("blocks the formal gate when automatic rows pass but no comparable baseline exists", () => {
    expect(formalA1GateExitCode(true, 1, "incomparable")).toBe(1);
    expect(formalA1GateExitCode(true, 1, "comparable")).toBe(0);
    expect(formalA1GateExitCode(false, 1, "comparable")).toBe(1);
    expect(formalA1GateExitCode(true, 0, "comparable")).toBe(1);
  });

  it("rejects dirty, smoke, legacy-lock and config-drift candidates", () => {
    expect(promoteBaselineCandidate({ ...candidate("dirty"), source: { commit: "main", dirty_fingerprint: "dirty" } }).reasons.join(" ")).toContain("clean commit");
    expect(promoteBaselineCandidate({ ...candidate("smoke"), smoke: true }).reasons.join(" ")).toContain("smoke");
    expect(promoteBaselineCandidate({ ...candidate("legacy"), config: { ...config, dataset_lock_status: "verified_legacy" } }).reasons.join(" ")).toContain("verified_v2");
    expect(promoteBaselineCandidate({ ...candidate("partial"), metrics: { consistency_ok: 1 } }).reasons.join(" ")).toContain("完整的规范分形态指标");
    const first = promoteBaselineCandidate(candidate("run-1")).next!;
    expect(promoteBaselineCandidate(candidate("run-2"), { ...first, metrics: { consistency_ok: 1 } }).reasons.join(" ")).toContain("首跑缺少完整的规范分形态指标");
    expect(promoteBaselineCandidate({ ...candidate("run-2"), config: { ...config, coverage_model: "changed" } }, first).reasons.join(" ")).toContain("相同 EvalConfig");
  });

  it("rejects a baseline candidate when a1-run artifact bytes no longer match its manifest hash", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-baseline-artifact-")); roots.push(root);
    const runPath = join(root, "a1-run.json");
    const run = `${JSON.stringify({ run_id: "run", config, metrics: { arxiv: [{ key: "reachability_pass", value: 1 }] } })}\n`;
    writeFileSync(runPath, run);
    const manifestPath = join(root, "manifest.json");
    const manifest = {
      run_id: "run", status: "completed", auto_gate: "pass", config,
      source: { commit: "main", dirty_fingerprint: null }, dataset: { smoke: false },
      artifacts: { "a1-run.json": sha(run) },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(baselineCandidateFromArtifacts(manifestPath, runPath, "arxiv")).toMatchObject({ run_id: "run", stratum: "arxiv" });
    writeFileSync(runPath, `${JSON.stringify({ ...JSON.parse(run), changed: true })}\n`);
    expect(() => baselineCandidateFromArtifacts(manifestPath, runPath, "arxiv")).toThrow("sha256");
  });
});

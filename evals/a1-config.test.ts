import { describe, expect, it } from "vitest";
import { sameEvalConfig, type EvalConfig } from "./a1-config.js";

const current: EvalConfig = {
  analyzer_model: "analyzer", analyzer_output_version: 17, analyzer_prompt_sha256: "analyzer-prompt",
  analyze_body_chars: 10_000, analyze_batch_chars: 30_000, select_window_chars: 1_000,
  validator_model: "validator", validator_contract_version: "validator-contract",
  consistency_window_chars: 600, consistency_batch_max: 8,
  relay_recovery_policy_version: "relay-half-open-v1", relay_recovery_max_probes: 3, relay_recovery_max_backoff_wait_ms: 70_750, relay_recovery_exhausted_cooldown_ms: 70_750,
  coverage_model: "coverage", validator_thinking: false, coverage_thinking: false, coverage_thinking_source: "explicit", structured_thinking_transport_version: "forced-tool-enabled-v1", validator_batch: true,
  quality_dataset_sha256: "quality", consistency_dataset_sha256: "consistency", dataset_lock_sha256: "dataset-lock", dataset_lock_status: "verified_v2", display_coverage_dataset_sha256: "coverage-data", quote_self_contained_dataset_sha256: "quote-data",
  display_coverage_gate_version: "display-coverage-v6", display_projection_version: "source_quote_v1", display_coverage_primary_prompt_version: "v6",
  display_coverage_primary_prompt_sha256: "primary", display_coverage_primary_response_budget_version: "output-4096-v1", display_coverage_primary_max_tokens: 4096, display_coverage_primary_claims_per_call: 1, display_coverage_countercheck_prompt_version: "v3",
  display_coverage_countercheck_prompt_sha256: "counter",
};

describe("A1 config comparability", () => {
  it("requires every contract fingerprint, including the analyzer output version and prompt", () => {
    expect(sameEvalConfig({ ...current }, current)).toBe(true);
    const oldBaseline = { ...current } as Record<string, unknown>;
    delete oldBaseline.analyzer_output_version;
    expect(sameEvalConfig(oldBaseline, current)).toBe(false);
    expect(sameEvalConfig({ ...current, analyzer_prompt_sha256: "old" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, analyze_body_chars: 8_000 }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, analyze_batch_chars: 20_000 }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, validator_contract_version: "old" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, relay_recovery_policy_version: "old" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, relay_recovery_exhausted_cooldown_ms: 1 }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, coverage_model: "other-coverage" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, coverage_thinking: true }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, coverage_thinking_source: "inherited" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, structured_thinking_transport_version: "older-transport" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, dataset_lock_sha256: "other-lock" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, dataset_lock_status: "verified_legacy" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, quote_self_contained_dataset_sha256: "other-quote-data" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_coverage_gate_version: "display-coverage-v5" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_projection_version: "legacy" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_coverage_primary_prompt_sha256: "other-primary" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_coverage_primary_response_budget_version: "old" }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_coverage_primary_max_tokens: 2048 }, current)).toBe(false);
    expect(sameEvalConfig({ ...current, display_coverage_primary_claims_per_call: 2 }, current)).toBe(false);
  });
});

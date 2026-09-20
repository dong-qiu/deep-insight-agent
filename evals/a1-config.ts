/**
 * The exact knobs that change the meaning of an A1 score. A baseline missing even one is
 * intentionally incomparable, so an older run cannot vouch for a newer prompt or contract.
 */
export interface EvalConfig {
  analyzer_model: string;
  analyzer_output_version: number;
  analyzer_prompt_sha256: string;
  analyze_body_chars: number;
  /** Analyzer chunking changes model context grouping and must be part of a comparable run. */
  analyze_batch_chars: number;
  select_window_chars: number;
  validator_model: string;
  validator_contract_version: string;
  consistency_window_chars: number;
  consistency_batch_max: number;
  /** Bounded parallelism for independent judges/fixtures; default remains serial. */
  independent_call_concurrency: number;
  relay_recovery_policy_version: string;
  relay_recovery_max_probes: number;
  relay_recovery_max_backoff_wait_ms: number;
  relay_recovery_exhausted_cooldown_ms: number;
  coverage_model: string;
  validator_thinking: boolean;
  coverage_thinking: boolean;
  /** Explicit settings are required for frozen baselines; inherited preserves legacy behaviour only. */
  coverage_thinking_source: "explicit" | "inherited";
  structured_thinking_transport_version: string;
  validator_batch: boolean;
  quality_dataset_sha256: string;
  consistency_dataset_sha256: string;
  /** A score is not a promotable baseline without a byte- and provenance-locked dataset. */
  dataset_lock_sha256: string;
  dataset_lock_status: "verified_legacy" | "verified_v2" | "invalid";
  display_coverage_dataset_sha256: string;
  quote_self_contained_dataset_sha256: string;
  display_coverage_gate_version: string;
  display_projection_version: string;
  display_coverage_primary_prompt_version: string;
  display_coverage_primary_prompt_sha256: string;
  /** Primary display-audit response allowance changes truncation risk and therefore outcomes. */
  display_coverage_primary_response_budget_version: string;
  display_coverage_primary_max_tokens: number;
  /** Number of atomic claims in each primary display-audit request. */
  display_coverage_primary_claims_per_call: number;
  display_coverage_countercheck_prompt_version: string;
  display_coverage_countercheck_prompt_sha256: string;
}

export const EVAL_CONFIG_KEYS: Array<keyof EvalConfig> = [
  "analyzer_model", "analyzer_output_version", "analyzer_prompt_sha256", "analyze_body_chars", "analyze_batch_chars", "select_window_chars",
  "validator_model", "validator_contract_version", "consistency_window_chars", "consistency_batch_max", "independent_call_concurrency",
  "relay_recovery_policy_version", "relay_recovery_max_probes", "relay_recovery_max_backoff_wait_ms", "relay_recovery_exhausted_cooldown_ms",
  "coverage_model", "validator_thinking", "coverage_thinking", "coverage_thinking_source", "structured_thinking_transport_version", "validator_batch",
  "quality_dataset_sha256", "consistency_dataset_sha256", "dataset_lock_sha256", "dataset_lock_status", "display_coverage_dataset_sha256", "quote_self_contained_dataset_sha256",
  "display_coverage_gate_version", "display_projection_version", "display_coverage_primary_prompt_version", "display_coverage_primary_prompt_sha256",
  "display_coverage_primary_response_budget_version", "display_coverage_primary_max_tokens", "display_coverage_primary_claims_per_call",
  "display_coverage_countercheck_prompt_version", "display_coverage_countercheck_prompt_sha256",
];

export function sameEvalConfig(baseline: Record<string, unknown>, current: EvalConfig): boolean {
  return EVAL_CONFIG_KEYS.every((key) => baseline[key] === current[key]);
}

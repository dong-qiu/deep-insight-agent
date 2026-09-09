/**
 * The exact knobs that change the meaning of an A1 score. A baseline missing even one is
 * intentionally incomparable, so an older run cannot vouch for a newer prompt or contract.
 */
export interface EvalConfig {
  analyzer_model: string;
  analyzer_output_version: number;
  analyzer_prompt_sha256: string;
  analyze_body_chars: number;
  select_window_chars: number;
  validator_model: string;
  validator_contract_version: string;
  consistency_window_chars: number;
  consistency_batch_max: number;
  coverage_model: string;
  validator_thinking: boolean;
  validator_batch: boolean;
  quality_dataset_sha256: string;
  consistency_dataset_sha256: string;
  display_coverage_dataset_sha256: string;
  display_coverage_gate_version: string;
  display_coverage_primary_prompt_version: string;
  display_coverage_primary_prompt_sha256: string;
  display_coverage_countercheck_prompt_version: string;
  display_coverage_countercheck_prompt_sha256: string;
}

export const EVAL_CONFIG_KEYS: Array<keyof EvalConfig> = [
  "analyzer_model", "analyzer_output_version", "analyzer_prompt_sha256", "analyze_body_chars", "select_window_chars",
  "validator_model", "validator_contract_version", "consistency_window_chars", "consistency_batch_max",
  "coverage_model", "validator_thinking", "validator_batch",
  "quality_dataset_sha256", "consistency_dataset_sha256", "display_coverage_dataset_sha256",
  "display_coverage_gate_version", "display_coverage_primary_prompt_version", "display_coverage_primary_prompt_sha256",
  "display_coverage_countercheck_prompt_version", "display_coverage_countercheck_prompt_sha256",
];

export function sameEvalConfig(baseline: Record<string, unknown>, current: EvalConfig): boolean {
  return EVAL_CONFIG_KEYS.every((key) => baseline[key] === current[key]);
}

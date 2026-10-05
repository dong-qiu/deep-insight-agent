/** Conservative local recovery identity; raw environment values never enter artifacts. */
import { a1QualityCheckpointConfigSha256 } from "./a1-quality-checkpoint.js";
import { DIRTY_SOURCE_FINGERPRINT_ALGORITHM, type DirtySourceSnapshot } from "./a1-source-state.js";

export const A1_RECOVERY_ENV_KEYS = [
  "LLM_PROVIDER", "LLM_BASE_URL", "ANTHROPIC_BASE_URL",
  "ANALYZER_MODEL", "VALIDATOR_MODEL", "COVERAGE_MODEL",
  "LLM_TIMEOUT_MS", "LLM_MAX_RETRIES", "LLM_TRANSIENT_RETRIES", "LLM_TRANSIENT_RETRY_BACKOFF_MS",
  "VALIDATOR_RETRIES", "VALIDATOR_RETRY_BACKOFF_MS", "VALIDATOR_THINKING", "VALIDATOR_BATCH",
  "COVERAGE_THINKING", "COVERAGE_MAX_TOKENS", "COVERAGE_BACKFILL", "PROMPT_CACHE",
  "ANALYZE_BODY_CHARS", "ANALYZE_BATCH_CHARS", "SELECT_WINDOW_CHARS",
  "CONSISTENCY_WINDOW_CHARS", "CONSISTENCY_BATCH_MAX", "CONSISTENCY_CACHE",
  "A1_INDEPENDENT_CALL_CONCURRENCY", "A1_TOPIC_TIMEOUT_MS", "A1_JUDGE_TIMEOUT_MS", "A1_COVERAGE_TIMEOUT_MS",
  "NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
] as const;

export interface A1RecoverySource {
  commit: string | null;
  dirty_fingerprint: string | null;
  dirty_fingerprint_algorithm?: string;
  /** A digest of unavailable data is not evidence of a complete source snapshot. */
  identity_complete?: boolean;
}

export function a1SourceIdentityComplete(commit: string | null, snapshot: DirtySourceSnapshot, untrackedPaths: Buffer | null): boolean {
  return commit != null && /^[a-f0-9]{40}$/.test(commit) && snapshot.status != null
    && snapshot.staged_diff != null && snapshot.unstaged_diff != null && untrackedPaths != null
    && snapshot.untracked != null && snapshot.untracked.every((file) => file.content != null);
}

export function a1RecoveryIdentity(
  source: A1RecoverySource,
  effectiveConfig: object,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!source.identity_complete || !source.commit || !/^[a-f0-9]{40}$/.test(source.commit)
    || (source.dirty_fingerprint !== null && !/^[a-f0-9]{64}$/.test(source.dirty_fingerprint))
    || source.dirty_fingerprint_algorithm !== DIRTY_SOURCE_FINGERPRINT_ALGORITHM) return null;
  return a1QualityCheckpointConfigSha256({
    source,
    // Sampling time is an observation, not a judgment or execution condition.
    effective_config: Object.fromEntries(Object.entries(effectiveConfig).filter(([key]) => key !== "sampled_at")),
    runtime: Object.fromEntries(A1_RECOVERY_ENV_KEYS.map((key) => [key, env[key] ?? null])),
  });
}

type TerminalTelemetry = Record<string, { output_stop_reasons: Record<string, number> }>;

/** A schema-valid result may still have been truncated by the provider. Retry success is allowed. */
export function a1HasNewTruncatedOutput(before: TerminalTelemetry, after: TerminalTelemetry): boolean {
  return Object.entries(after).some(([role, value]) => ["max_tokens", "max_output_tokens"].some((reason) =>
    (value.output_stop_reasons[reason] ?? 0) > (before[role]?.output_stop_reasons[reason] ?? 0)));
}

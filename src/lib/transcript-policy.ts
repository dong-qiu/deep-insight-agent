import type { Source } from "./types.js";

/** The reviewed transcript policy is a single unit. A policy-aware source must never inherit a
 * strategy or resource limit merely because a caller bypassed YAML parsing or the repository. */
export function assertExplicitTranscriptPolicy(source: Source): void {
  if ((source.transcript_mode ?? "off") === "off") return;
  if (!source.transcript_policy_version?.trim()) throw new Error("transcript_policy_version_required");
  if (
    source.transcript_strategy === undefined ||
    source.transcript_max_items_per_run === undefined ||
    source.transcript_max_bytes_per_run === undefined ||
    source.transcript_timeout_budget_ms === undefined ||
    source.transcript_host_qps === undefined
  ) throw new Error("transcript_policy_fields_required");
  if (source.transcript_strategy !== "all" && source.transcript_strategy !== "relevant_only") {
    throw new Error("invalid_transcript_policy_strategy");
  }
  if (
    !Number.isInteger(source.transcript_max_items_per_run) || source.transcript_max_items_per_run <= 0 ||
    !Number.isInteger(source.transcript_max_bytes_per_run) || source.transcript_max_bytes_per_run <= 0 ||
    !Number.isInteger(source.transcript_timeout_budget_ms) || source.transcript_timeout_budget_ms <= 0 ||
    !Number.isFinite(source.transcript_host_qps) || source.transcript_host_qps <= 0
  ) throw new Error("invalid_transcript_policy_limits");
}

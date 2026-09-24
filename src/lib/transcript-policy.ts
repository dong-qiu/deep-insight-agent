import type { Source } from "./types.js";

/** The reviewed transcript policy is a single unit. A policy-aware source must never inherit a
 * strategy or resource limit merely because a caller bypassed YAML parsing or the repository. */
export function assertExplicitTranscriptPolicy(source: Source): void {
  if ((source.transcript_mode ?? "off") === "off") return;
  if (
    source.transcript_strategy === undefined ||
    source.transcript_max_items_per_run === undefined ||
    source.transcript_max_bytes_per_run === undefined ||
    source.transcript_timeout_budget_ms === undefined ||
    source.transcript_host_qps === undefined
  ) throw new Error("transcript_policy_fields_required");
}

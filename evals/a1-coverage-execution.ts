/**
 * Reasons that mean the coverage benchmark did not obtain a usable model audit at all.
 *
 * This is deliberately an allow-list rather than a substring check.  Several valid
 * fail-closed *semantic* rejections also start with "invalid_" (for example an
 * unpassed controlled-importance anchor); treating those as infrastructure failures
 * would make an otherwise complete safety benchmark spuriously incomplete.
 */
const EXECUTION_FAILURE_REASONS = new Set<string>([
  "primary_unavailable",
  "primary_invalid_verdict_set",
  "missing_or_duplicate_verdict",
  "invalid_kind",
  "unsupported_with_evidence",
  "invalid_citation_indexes",
  "statement_bound_citation_not_selected",
  "invalid_evidence_span",
  "self_contained_unavailable",
  "self_contained_invalid_verdict_set",
  "self_contained_invalid_kind",
  "self_contained_unsupported_with_evidence",
  "self_contained_invalid_citation_indexes",
  "self_contained_invalid_evidence_span",
]);

export function isA1CoverageExecutionFailure(reason: string): boolean {
  return EXECUTION_FAILURE_REASONS.has(reason);
}

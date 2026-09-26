import { createHash } from "node:crypto";
import type { CoverageDecision } from "./analyzer.js";

// Never copy arbitrary model/error text into the long-lived trace ledger.
const REASONS = new Set([
  "missing_statement_citation_binding", "invalid_statement_citation_binding",
  "statement_binding_citation_not_displayable", "statement_not_atomic", "statement_not_bound_to_citation_claim",
  "statement_token_not_in_bound_quote", "unresolved_deictic_quote", "primary_unavailable",
  "primary_invalid_verdict_set", "missing_or_duplicate_verdict", "invalid_kind", "judge_not_supported",
  "unsupported_with_evidence", "invalid_citation_indexes", "statement_bound_citation_not_selected",
  "invalid_evidence_span", "judge_supported", "self_contained_unavailable", "self_contained_invalid_verdict_set",
  "self_contained_invalid_kind", "quote_not_self_contained", "self_contained_unsupported_with_evidence",
  "self_contained_invalid_citation_indexes", "self_contained_invalid_evidence_span", "quote_self_contained",
  "controlled_reason_pruned_anchor", "controlled_reason_anchored", "invalid_or_unpassed_importance_anchor",
  "invalid_importance_contract", "reader_language_repair_unavailable", "reader_language_repair_invalid",
]);
const TERMINALS = new Set([
  "kept", "kept_degraded", "dropped_truncated", "dropped_invalid_citation",
  "dropped_no_displayable_citation", "dropped_coverage", "dropped_coverage_error",
]);
const reasonCode = (value: string): string => REASONS.has(value) ? value : "unknown";
const hash = (value: string | undefined): string | null => value && /^[a-f0-9]{64}$/.test(value) ? value : null;

/** A deliberately lossy diagnostic, not an audit copy or a replayable model response. */
export function coverageDiagnostic(decision: CoverageDecision) {
  return {
    candidate_sha256: createHash("sha256").update(decision.candidate_id).digest("hex"),
    terminal_reason: TERMINALS.has(decision.terminal_reason) ? decision.terminal_reason : "unknown",
    claim_reasons: [...new Set(decision.claims.map((claim) => reasonCode(claim.reason)))].sort(),
    countercheck_reasons: [...new Set(decision.claims.flatMap((claim) => claim.countercheck
      ? [reasonCode(claim.countercheck.reason)] : []))].sort(),
    input_hash: hash(decision.input_hash),
    draft_statement_sha256: hash(decision.draft_statement_sha256),
    quote_sha256: hash(decision.quote_sha256),
    reader_language_repair: decision.reader_language_repair ? {
      status: ["repaired", "unavailable", "invalid", "rejected"].includes(decision.reader_language_repair.status)
        ? decision.reader_language_repair.status : "unknown",
      source_draft_sha256: hash(decision.reader_language_repair.source_draft_sha256),
      source_audit_input_hash: hash(decision.reader_language_repair.source_audit_input_hash),
      translated_draft_sha256: hash(decision.reader_language_repair.translated_draft_sha256),
      prompt_hash: hash(decision.reader_language_repair.prompt_hash),
    } : null,
  };
}

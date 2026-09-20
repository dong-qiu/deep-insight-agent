import { describe, expect, it } from "vitest";
import { isA1CoverageExecutionFailure } from "./a1-coverage-execution.js";

describe("A1 coverage execution-failure classification", () => {
  it("marks only unavailable or structurally unusable model audits as incomplete", () => {
    for (const reason of [
      "primary_unavailable",
      "primary_invalid_verdict_set",
      "missing_or_duplicate_verdict",
      "invalid_kind",
      "unsupported_with_evidence",
      "invalid_citation_indexes",
      "invalid_evidence_span",
      "self_contained_unavailable",
      "self_contained_invalid_verdict_set",
      "self_contained_invalid_kind",
      "self_contained_unsupported_with_evidence",
      "self_contained_invalid_citation_indexes",
      "self_contained_invalid_evidence_span",
    ]) expect(isA1CoverageExecutionFailure(reason)).toBe(true);
  });

  it("does not turn a fail-closed semantic rejection into an infrastructure failure", () => {
    for (const reason of [
      "invalid_or_unpassed_importance_anchor",
      "invalid_importance_contract",
      "quote_not_self_contained",
      "judge_not_supported",
      "unresolved_deictic_quote",
    ]) expect(isA1CoverageExecutionFailure(reason)).toBe(false);
  });
});

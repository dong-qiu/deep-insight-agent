import { describe, expect, it } from "vitest";
import { combinedExpectation, observeRatioDecision, pendingRatioLabels, readerRatioDimensionCases, scoreRatioCheck,
  scoreRatioObservation, type RatioExpectation } from "./reader-ratio-contract.js";

describe("independently reviewed ratio labels", () => {
  it("preserves every legacy case and distinguishes policy-pending labels", () => {
    const legacy = readerRatioDimensionCases.slice(0, 42);
    expect(readerRatioDimensionCases).toHaveLength(45);
    expect(new Set(readerRatioDimensionCases.map(row => row.id)).size).toBe(45);
    for (const [dimension, counts] of [["equivalence", [25, 16, 1]], ["primary", [25, 17, 0]],
      ["quote", [17, 0, 25]], ["combined", [11, 17, 14]]] as const) {
      expect([true, false, "pending"].map(label => legacy.filter(row => row.expected[dimension] === label).length)).toEqual(counts);
    }
    expect(pendingRatioLabels(readerRatioDimensionCases)).toHaveLength(26);
    expect(legacy.find(row => row.id === "pronoun-baseline")?.expected).toMatchObject({ equivalence: "pending", primary: false });
    for (const row of legacy) {
      for (const sameSource of legacy.filter(other => other.quote === row.quote)) expect(row.expected.quote).toBe(sameSource.expected.quote);
    }
  });
  it("includes controls where equivalence does not imply quote sufficiency or primary support", () => {
    expect(readerRatioDimensionCases.find(row => row.id === "external-baseline-context")?.expected)
      .toMatchObject({ equivalence: true, quote: false, combined: false });
    expect(readerRatioDimensionCases.find(row => row.id === "equivalent-but-missing-cost-evidence")?.expected)
      .toMatchObject({ equivalence: true, primary: false, quote: true, combined: false });
    expect(combinedExpectation(true, "pending")).toBe("pending");
    expect(combinedExpectation(false, "pending")).toBe(false);
  });
});

const expected: RatioExpectation = { equivalence: true, primary: true, quote: false, combined: false, rationale: "test" };
function check(primary: boolean, quote: boolean, covered = primary && quote) {
  return { covered, primary_decisions: [{ claim_id: "statement:1", supports: primary, reason: primary ? "judge_supported" : "judge_not_supported" }],
    claims: [{ claim_id: "statement:1", countercheck: { supports: quote, reason: quote ? "quote_self_contained" : "quote_not_self_contained" } }] };
}
it("scores faithful-primary plus insufficient-quote independently", () => {
  expect(scoreRatioCheck(expected, check(true, false))).toMatchObject({
    equivalence_prediction: "not_isolated", scores: { primary: "match", quote: "match", combined: "match" },
  });
});
it("does not let the combined rejection hide an incorrect primary acceptance", () => {
  expect(scoreRatioCheck({ ...expected, equivalence: false, primary: false }, check(true, false)).scores)
    .toEqual({ primary: "mismatch", quote: "match", combined: "match" });
});
it("does not infer primary success from the overwritten final reason or missing observations", () => {
  const result = check(true, false);
  delete (result as { primary_decisions?: unknown }).primary_decisions;
  expect(scoreRatioCheck(expected, result).scores).toEqual({ primary: "not_observed", quote: "match", combined: "execution_failed" });
});
it("rejects duplicate or extra observations instead of scoring only the first", () => {
  const result = check(true, true);
  result.primary_decisions.push({ ...result.primary_decisions[0] });
  result.claims.push({ ...result.claims[0] });
  expect(scoreRatioCheck(expected, result).scores).toEqual({ primary: "not_observed", quote: "not_observed", combined: "execution_failed" });
});
it("separates contract errors/outages from true semantic rejections even for pending labels", () => {
  const result = check(false, false);
  result.primary_decisions[0].reason = "primary_unavailable";
  expect(scoreRatioCheck({ ...expected, primary: "pending" }, result).scores.primary).toBe("execution_failed");
  result.claims[0].countercheck.reason = "self_contained_invalid_evidence_span";
  expect(scoreRatioCheck(expected, result).scores.quote).toBe("execution_failed");
  expect(observeRatioDecision({ supports: true, reason: "unexpected" }, "primary")).toBe("execution_failed");
  expect(scoreRatioObservation("pending", "support")).toBe("pending");
});
it("detects an inconsistent AND result and labels preflight rejection without claiming model judgment", () => {
  expect(scoreRatioCheck(expected, check(true, false, true)).scores.combined).toBe("execution_failed");
  const result = check(false, true);
  result.primary_decisions[0].reason = "translation_ratio_baseline_unverified";
  expect(scoreRatioCheck({ ...expected, equivalence: "pending", primary: false }, result)).toMatchObject({
    primary_origins: ["deterministic_preflight"], equivalence_annotation: "pending", observed: { primary: "reject" },
  });
});
it("aggregates all statement decisions and never hides a later error behind an earlier rejection", () => {
  const result = check(true, true, false);
  result.primary_decisions.push({ claim_id: "statement:2", supports: false, reason: "judge_not_supported" });
  result.claims.push({ claim_id: "statement:2" } as typeof result.claims[number]);
  expect(scoreRatioCheck({ ...expected, primary: false, quote: true }, result).scores)
    .toEqual({ primary: "match", quote: "match", combined: "match" });
  result.primary_decisions[0] = { claim_id: "statement:1", supports: false, reason: "judge_not_supported" };
  result.primary_decisions[1].reason = "primary_invalid_verdict_set";
  expect(scoreRatioCheck({ ...expected, primary: false, quote: true }, result).scores.primary).toBe("execution_failed");
  result.claims.pop();
  expect(scoreRatioCheck(expected, result).scores.primary).toBe("not_observed");
});

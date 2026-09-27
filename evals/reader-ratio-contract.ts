import { readerBaselineCases, readerRatioCases, readerRatioPreflightCases, readerRatioExplanations,
  readerRatioReferenceControls, unstatedRatioBaseline } from "./dataset/reader-language-ratios.js";

export const READER_RATIO_EVAL_VERSION = "reader-ratio-dimensions-v2";
export type Expectation = boolean | "pending";
export type RatioExpectation = {
  /** Independently reviewed annotation, NOT a prediction inferred from the primary gate. */
  equivalence: Expectation;
  primary: Expectation;
  quote: Expectation;
  combined: Expectation;
  rationale: string;
};
export type RatioCase = { id: string; source: string; quote: string; statement: string; expected: RatioExpectation };

// Reviewed without model outputs. Explicit IDs prevent parser-unit `rejected` flags from
// silently becoming publication labels. The preflight flag in the old fixture is not read here.
const equivalent = new Set([
  "accuracy-retention-good", "cost-share-good", "relative-percent-good", "percentage-points-good", "absolute-accuracy-good",
  "bounded-denominator-good", "negated-explanation", "separate-subjects", "explicit-relative-baseline", "parenthetical-baseline",
  "generic-baselines", "explicit-named-baselines", "front-comparison", "trailing-comparison", "mixed-generic-and-named",
  "unicode-percentage", "postnominal-accuracy", "postnominal-cost", "postnominal-achieved", "accuracy-loss", "cost-saving",
  "mixed-retention-saving", "mixed-loss-share", "the-original-denominator", "mixed-postnominal-original",
]);
const inequivalent = new Set([
  "accuracy-retention-bad", "cost-share-bad", "relative-percent-bad", "percentage-points-bad", "absolute-accuracy-bad",
  "unstated-baseline", "bounded-denominator-bad", "routed-model-baseline", "named-generic-substring", "named-cost-substring",
  "trailing-baseline-definition", "mixed-baseline-leak", "wrong-percentage", "mixed-postnominal-leak",
  "baseline-context-not-denominator", "absolute-to-relative",
]);
const selfContained = new Set([
  "accuracy-retention-good", "accuracy-retention-bad", "cost-share-good", "cost-share-bad",
  "relative-percent-good", "relative-percent-bad", "percentage-points-good", "percentage-points-bad",
  "absolute-accuracy-good", "absolute-accuracy-bad", "explicit-named-baselines", "front-comparison", "trailing-comparison",
  "postnominal-accuracy", "postnominal-cost", "postnominal-achieved", "absolute-to-relative",
]);

export function combinedExpectation(primary: Expectation, quote: Expectation): Expectation {
  if (primary === false || quote === false) return false;
  if (primary === "pending" || quote === "pending") return "pending";
  return true;
}

const legacyRows = [
  ...readerRatioCases.flatMap(row => [
    { id: `${row.id}-good`, source: row.source, statement: row.good },
    { id: `${row.id}-bad`, source: row.source, statement: row.bad },
  ]),
  { id: unstatedRatioBaseline.id, source: unstatedRatioBaseline.source, statement: unstatedRatioBaseline.bad },
  ...readerRatioPreflightCases.flatMap(row => [
    { id: `${row.id}-good`, source: row.source, statement: row.good },
    { id: `${row.id}-bad`, source: row.source, statement: row.bad },
  ]),
  ...readerRatioExplanations.map(row => ({ id: row.id, source: row.source, statement: row.translation })),
  ...readerBaselineCases.map(row => ({ id: row.id, source: row.source, statement: row.translation })),
  ...readerRatioReferenceControls.map(row => ({ id: row.id, source: row.source, statement: row.translation })),
];

export const readerRatioDimensionCases: RatioCase[] = legacyRows.map(row => {
  if (!equivalent.has(row.id) && !inequivalent.has(row.id) && row.id !== "pronoun-baseline") {
    throw new Error(`Missing independently reviewed ratio label: ${row.id}`);
  }
  const equivalence = equivalent.has(row.id) ? true : inequivalent.has(row.id) ? false : "pending";
  const primary = equivalent.has(row.id);
  const quote = selfContained.has(row.id) ? true : "pending";
  return { ...row, quote: row.source, expected: { equivalence, primary, quote,
    combined: combinedExpectation(primary, quote),
    rationale: [
      equivalence === "pending" ? "Pronoun referent unresolved; deterministic unverified-baseline rejection is not proof of inequivalence."
        : equivalence ? "Faithful relation; primary checks quote support AND equivalence." : "Changes the ratio relation, quantity, or introduces an unsupported denominator.",
      quote === "pending" ? "Contract conflict: identifiable-baseline requirement versus the generic MCP speedup positive example. Strict-policy proposal is rejection, not current gold."
        : "Quote identifies the subject and absolute metric or comparison baseline.",
    ].join(" "),
  } };
});

const controls = [
  { id: "external-baseline-context", source: "Compared with the baseline described above, Atlas retains 96% of accuracy at 42% of the cost.",
    statement: "相对于上文所述基线，Atlas 保留准确性的96%，成本为该基线成本的42%。",
    primary: "pending" as const, quoteSelfContained: false,
    rationale: "Faithful translation, but the explicitly external baseline has no antecedent in the quote. Primary label awaits separate review; quote and combined must reject." },
  { id: "defined-baseline-context", source: "The baseline is running Orion alone. Compared with that baseline, Atlas retains 96% of accuracy at 42% of the cost.",
    statement: "基线是单独运行 Orion；相对于该基线，Atlas 保留准确性的96%，成本为基线成本的42%。",
    primary: true, quoteSelfContained: true,
    rationale: "The quote itself defines the baseline and supports all translated facts." },
  { id: "equivalent-but-missing-cost-evidence", source: "Atlas retains 96% of Orion's accuracy at 42% of Orion's cost.",
    quote: "Atlas retains 96% of Orion's accuracy.",
    statement: "Atlas 保留 Orion 准确性的96%，成本为 Orion 成本的42%。",
    primary: false, quoteSelfContained: true,
    rationale: "Translation is equivalent to the source claim; the displayed quote is self-contained but does not prove the cost fact. Equivalence alone cannot predict primary support." },
];
readerRatioDimensionCases.push(...controls.map(row => ({
  id: row.id, source: row.source, statement: row.statement, quote: row.quote ?? row.source,
  expected: { equivalence: true, primary: row.primary, quote: row.quoteSelfContained,
    combined: combinedExpectation(row.primary, row.quoteSelfContained), rationale: row.rationale },
})));

export function pendingRatioLabels(cases: readonly RatioCase[]): Array<{ id: string; dimensions: string[] }> {
  return cases.flatMap(row => {
    const dimensions = (["equivalence", "primary", "quote", "combined"] as const).filter(key => row.expected[key] === "pending");
    return dimensions.length ? [{ id: row.id, dimensions }] : [];
  });
}

type Decision = { supports: boolean; reason: string };
export type RatioObservation = "support" | "reject" | "execution_failed" | "not_observed";
export type RatioScore = "match" | "mismatch" | "pending" | "execution_failed" | "not_observed";
const primaryRejects = new Set(["judge_not_supported", "translation_ratio_denominator_lost", "translation_ratio_baseline_unverified"]);

export function observeRatioDecision(decision: Decision | undefined, gate: "primary" | "quote"): RatioObservation {
  if (!decision) return "not_observed";
  if (decision.supports && decision.reason === (gate === "primary" ? "judge_supported" : "quote_self_contained")) return "support";
  if (!decision.supports && (gate === "primary" ? primaryRejects.has(decision.reason) : decision.reason === "quote_not_self_contained")) return "reject";
  return "execution_failed";
}

export function scoreRatioObservation(expected: Expectation, observed: RatioObservation): RatioScore {
  if (observed === "execution_failed" || observed === "not_observed") return observed;
  if (expected === "pending") return "pending";
  return expected === (observed === "support") ? "match" : "mismatch";
}

export function scoreRatioCheck(expected: RatioExpectation, check: {
  covered: boolean;
  primary_decisions?: Array<Decision & { claim_id: string }>;
  claims: Array<{ claim_id: string; countercheck?: Decision }>;
}) {
  // Never reverse-infer primary success from the combined reason after Coverage has overwritten it.
  const snapshots = check.primary_decisions ?? [];
  const exactSet = snapshots.length > 0 && snapshots.length === check.claims.length
    && snapshots.every((row, index) => row.claim_id === `statement:${index + 1}`
      && check.claims[index]?.claim_id === row.claim_id);
  const primaryObservations = snapshots.map(row => observeRatioDecision(row, "primary"));
  const primary: RatioObservation = !exactSet ? "not_observed"
    : primaryObservations.includes("execution_failed") ? "execution_failed"
      : primaryObservations.includes("reject") ? "reject" : "support";
  const quote = observeRatioDecision(check.claims[0]?.claim_id === "statement:1"
    && !check.claims.slice(1).some(row => row.countercheck !== undefined)
    ? check.claims[0].countercheck : undefined, "quote");
  const executable = [primary, quote].every(value => value === "support" || value === "reject");
  const andConsistent = check.covered === (primary === "support" && quote === "support");
  const combined: RatioObservation = !executable || !andConsistent ? "execution_failed" : check.covered ? "support" : "reject";
  return {
    equivalence_annotation: expected.equivalence, equivalence_prediction: "not_isolated" as const,
    primary_origins: [...new Set(snapshots.map(row => row.reason.startsWith("translation_ratio_") ? "deterministic_preflight" : "model_or_unavailable"))],
    observed: { primary, quote, combined },
    scores: { primary: scoreRatioObservation(expected.primary, primary), quote: scoreRatioObservation(expected.quote, quote),
      combined: scoreRatioObservation(expected.combined, combined) },
  };
}

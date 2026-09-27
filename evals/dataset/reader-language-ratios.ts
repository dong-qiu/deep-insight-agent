/** Synthetic, fixed before/after cases. No production source text or report records. */
export const readerRatioCases = [
  { id: "accuracy-retention", source: "Atlas retains 96% of Orion's accuracy.",
    good: "Atlas 保留了 Orion 准确性的 96%。", bad: "Atlas 的准确率达到 96%。" },
  { id: "cost-share", source: "Atlas runs at 42% of Orion's cost.",
    good: "Atlas 的运行成本为 Orion 成本的 42%。", bad: "Atlas 的运行成本比 Orion 降低了 42%。" },
  { id: "relative-percent", source: "Atlas improves accuracy by 12% relative to Orion.",
    good: "Atlas 的准确率相对 Orion 提高了 12%。", bad: "Atlas 的准确率比 Orion 提高了 12 个百分点。" },
  { id: "percentage-points", source: "Atlas improves accuracy by 12 percentage points over Orion.",
    good: "Atlas 的准确率比 Orion 提高了 12 个百分点。", bad: "Atlas 的准确率相对 Orion 提高了 12%。" },
  { id: "absolute-accuracy", source: "Atlas achieves 96% accuracy.",
    good: "Atlas 的准确率达到 96%。", bad: "Atlas 保留了原有准确性的 96%。" },
] as const;

/** Added after independent review; keep the original 16-case comparison identifiable. */
export const readerRatioPreflightCases = [
  { id: "bounded-denominator", source: "Atlas keeps 96% of accuracy at 42% of the cost.",
    good: "Atlas 保留了原有准确性的96%，成本为原有成本的42%。", bad: "Atlas 在42%的成本下保持了96%的准确率。" },
] as const;

export const readerRatioExplanations = [
  { id: "negated-explanation", source: "Atlas retains 96% of accuracy, which does not mean its accuracy is 96%.",
    translation: "Atlas 保留原有准确性的96%，这不意味着准确率为96%。" },
  { id: "separate-subjects", source: "Atlas retains 96% of baseline accuracy; Orion achieves 96% accuracy.",
    translation: "Atlas 保留基线准确性的96%；Orion 的准确率为96%。" },
  { id: "explicit-relative-baseline", source: "Atlas retains 96% of baseline accuracy.",
    translation: "Atlas 相对于基线的准确率为96%。" },
  { id: "parenthetical-baseline", source: "Atlas retains 96% of baseline accuracy.",
    translation: "Atlas 保持了96%的准确率（以基线为参照）。" },
] as const;

export const unstatedRatioBaseline = {
  id: "unstated-baseline",
  source: "Atlas cascades low-confidence calls to Orion, retaining 96% of accuracy at 42% of the cost.",
  bad: "Atlas 将低置信度调用交给 Orion，以单独使用 Orion 成本的 42% 保留其准确性的 96%。",
} as const;

/** Fixed acceptance boundaries for the generic-denominator parser, not a universal parser. */
export const readerBaselineCases = [
  { id: "generic-baselines", source: unstatedRatioBaseline.source,
    translation: "Atlas 将低置信度调用交给 Orion，保留原有准确性的96%，成本为原有成本的42%。", rejected: false },
  { id: "routed-model-baseline", source: unstatedRatioBaseline.source,
    translation: unstatedRatioBaseline.bad, rejected: true },
  { id: "pronoun-baseline", source: unstatedRatioBaseline.source,
    translation: "Atlas 将低置信度调用交给 Orion，保留其准确性的96%，成本为原有成本的42%。", rejected: true },
  { id: "named-generic-substring", source: unstatedRatioBaseline.source,
    translation: "Atlas 将低置信度调用交给 Orion，保留 Orion 原有准确性的96%，成本为原有成本的42%。", rejected: true },
  { id: "named-cost-substring", source: unstatedRatioBaseline.source,
    translation: "Atlas 将低置信度调用交给 Orion，保留原有准确性的96%，成本为 Orion 原有成本的42%。", rejected: true },
  { id: "trailing-baseline-definition", source: unstatedRatioBaseline.source,
    translation: "Atlas 将低置信度调用交给 Orion，保留原有准确性的96%，成本为原有成本的42%，以单独使用 Orion 为基线。", rejected: true },
  { id: "explicit-named-baselines", source: "Atlas retains 96% of Orion's accuracy at 42% of Orion's cost.",
    translation: "Atlas 保留 Orion 准确性的96%，成本为 Orion 成本的42%。", rejected: false },
  { id: "front-comparison", source: "Compared with Orion, Atlas retains 96% of accuracy at 42% of the cost.",
    translation: "相对 Orion，Atlas 保留其准确性的96%，成本为其成本的42%。", rejected: false },
  { id: "trailing-comparison", source: "Atlas retains 96% of accuracy at 42% of the cost relative to Orion.",
    translation: "相对 Orion，Atlas 保留其准确性的96%，成本为其成本的42%。", rejected: false },
  { id: "mixed-generic-and-named", source: "Atlas retains 96% of accuracy at 42% of Orion's cost.",
    translation: "Atlas 保留原有准确性的96%，成本为 Orion 成本的42%。", rejected: false },
  { id: "mixed-baseline-leak", source: "Atlas retains 96% of accuracy at 42% of Orion's cost.",
    translation: "Atlas 保留 Orion 准确性的96%，成本为 Orion 成本的42%。", rejected: true },
  { id: "wrong-percentage", source: "Atlas retains 96% of accuracy.",
    translation: "Atlas 保留原有准确性的196%。", rejected: true },
  { id: "unicode-percentage", source: "Atlas retains 96% of accuracy.",
    translation: "Atlas 保留原有准确性的９６％。", rejected: false },
  { id: "postnominal-accuracy", source: "Atlas retains 96% of the accuracy of Orion.",
    translation: "Atlas 保留 Orion 准确性的96%。", rejected: false },
  { id: "postnominal-cost", source: "Atlas runs at 42% of the cost of running Orion alone.",
    translation: "Atlas 的运行成本为单独运行 Orion 成本的42%。", rejected: false },
  { id: "postnominal-achieved", source: "Atlas retains 96% of the accuracy achieved by Orion.",
    translation: "Atlas 保留 Orion 准确性的96%。", rejected: false },
  { id: "accuracy-loss", source: "Atlas loses 4% of accuracy.",
    translation: "Atlas 损失原有准确性的4%。", rejected: false },
  { id: "cost-saving", source: "Atlas saves 42% of the cost.",
    translation: "Atlas 节省原有成本的42%。", rejected: false },
  { id: "mixed-retention-saving", source: "Atlas retains 96% of accuracy and saves 42% of the cost.",
    translation: "Atlas 保留原有准确性的96%，并节省原有成本的42%。", rejected: false },
  { id: "mixed-loss-share", source: "Atlas loses 4% of accuracy at 42% of the cost.",
    translation: "Atlas 损失原有准确性的4%，成本为原有成本的42%。", rejected: false },
  { id: "the-original-denominator", source: "Atlas retains 96% of the original accuracy at 42% of the cost.",
    translation: "Atlas 保留原有准确性的96%，成本为原有成本的42%。", rejected: false },
  { id: "mixed-postnominal-original", source: "Atlas retains 96% of accuracy at 42% of the original cost of Orion.",
    translation: "Atlas 保留原有准确性的96%，成本为 Orion 原有成本的42%。", rejected: false },
  { id: "mixed-postnominal-leak", source: "Atlas retains 96% of accuracy at 42% of the original cost of Orion.",
    translation: "Atlas 保留 Orion 准确性的96%，成本为 Orion 原有成本的42%。", rejected: true },
] as const;

/** Semantic controls: a baseline keyword alone must not grant support. */
export const readerRatioReferenceControls = [
  { id: "baseline-context-not-denominator", source: "Atlas retains 96% of baseline accuracy.",
    translation: "Atlas 的准确率为96%（在基线实验中）。" },
  { id: "absolute-to-relative", source: "Atlas achieves 96% accuracy.",
    translation: "Atlas 相对于基线的准确率为96%。" },
] as const;

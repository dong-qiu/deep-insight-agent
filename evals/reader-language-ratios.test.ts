import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("../src/lib/runtime/llm.js", () => ({ callStructured: vi.fn(), assertCoverageModelSeparation: vi.fn(),
  MODELS: { analyzer: "a", validator: "v", coverage: "c" } }));
import { callStructured } from "../src/lib/runtime/llm.js";
import { analyzerCacheVersion, filterByQuoteCoverage, verifyDisplayedQuoteCoverage, type CoverageDecision } from "../src/lib/agents/analyzer.js";
import { hasUnverifiedRatioBaseline, losesAccuracyRatioDenominator, READER_LANGUAGE_REPAIR_SYSTEM, READER_LANGUAGE_EQUIVALENCE_RULE } from "../src/lib/agents/reader-language.js";
import { readerBaselineCases, readerRatioCases, readerRatioExplanations, readerRatioReferenceControls, unstatedRatioBaseline } from "./dataset/reader-language-ratios.js";
import type { Insight } from "../src/lib/types.js";

beforeEach(() => { vi.mocked(callStructured).mockReset(); });

it.each([[true, false], [false, true], [true, true], [false, false]])(
  "preserves primary=%s separately from quote-only=%s without changing the AND gate", async (primary, quoteOnly) => {
    const source = "Atlas achieves 96% accuracy.";
    vi.mocked(callStructured).mockImplementation(async request => {
      const supports = request.role === "validator" ? primary : quoteOnly;
      return { data: { verdicts: [{ index: 1, kind: "factual", supports,
        citation_indexes: supports ? [1] : [], evidence_spans: supports
          ? [{ citation_index: 1, quote_start: 0, quote_end: source.length, evidence_excerpt: source }] : [],
      }] } } as never;
    });
    const result = await verifyDisplayedQuoteCoverage({ statement: "Atlas 的准确率为96%。", headline: "", importance_basis: "" },
      [{ content_item_id: "synthetic", claim: "Atlas 的准确率为96%。", quote: source,
        locator: { paragraph_index: 0, char_start: 0, char_end: source.length } }], 1, undefined, undefined, source);
    expect(result.primary_decisions).toEqual([{ claim_id: "statement:1", supports: primary,
      reason: primary ? "judge_supported" : "judge_not_supported" }]);
    expect(result.claims[0].countercheck?.supports).toBe(quoteOnly);
    expect(result.covered).toBe(primary && quoteOnly);
    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.primary_decisions)).not.toContain("Atlas");
  },
);

it.each(readerBaselineCases)("generic baseline boundary: $id", ({ source, translation, rejected }) => {
  expect(hasUnverifiedRatioBaseline(source, translation)).toBe(rejected);
});

it.each(readerBaselineCases)("baseline necessary condition survives an overly permissive primary: $id", async ({ source, translation, rejected }) => {
  vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{ index: 1, kind: "factual", supports: true,
    citation_indexes: [1], evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: source.length, evidence_excerpt: source }],
  }] } } as never);
  const result = await verifyDisplayedQuoteCoverage({ statement: translation, headline: "", importance_basis: "" },
    [{ content_item_id: "ci", claim: translation, quote: source, locator: { paragraph_index: 0, char_start: 0, char_end: source.length } }],
    1, undefined, undefined, source);
  expect(result.covered).toBe(!rejected);
  expect(result.claims[0].reason).toBe(rejected ? "translation_ratio_baseline_unverified" : "judge_supported");
  expect(vi.mocked(callStructured).mock.calls.map(([r]) => r.telemetryOperation)).toEqual(rejected
    ? ["display_quote_countercheck"] : ["display_quote_primary", "display_quote_countercheck"]);
});

it("does not apply translation-only baseline rules to the non-translation audit", async () => {
  const { source, bad } = unstatedRatioBaseline;
  vi.mocked(callStructured).mockResolvedValue({ data: { verdicts: [{ index: 1, kind: "factual", supports: false,
    citation_indexes: [], evidence_spans: [],
  }] } } as never);
  const result = await verifyDisplayedQuoteCoverage({ statement: bad, headline: "", importance_basis: "" },
    [{ content_item_id: "ci", claim: bad, quote: source, locator: { paragraph_index: 0, char_start: 0, char_end: source.length } }], 1);
  expect(result.claims[0].reason).toBe("judge_not_supported");
  expect(callStructured).toHaveBeenCalledTimes(2);
});

it.each([
  ["Atlas keeps 96% of accuracy.", "Atlas 保持了96%的准确率。", true],
  ["Atlas retains 96% of the accuracy.", "Atlas 的准确率达到96%。", true],
  ["Atlas preserves 96.5% of original accuracy.", "Atlas 准确率为96.5%。", true],
  ["Atlas keeps 96% of accuracy.", "Atlas 维持了９６％的准确率。", true],
  ["Atlas keeps 96% of accuracy.", "Atlas 保留了原有准确性的96%。", false],
  ["Atlas keeps 96% of accuracy.", "Atlas 保持了96%的原有准确率。", false],
  ["Atlas achieves 96% accuracy.", "Atlas 的准确率达到96%。", false],
  ["Atlas keeps 96% of accuracy.", "Atlas 的准确率达到196%。", false],
  ["Atlas retains 96.5% of accuracy.", "Atlas 的准确率达到965%。", false],
  ["Atlas keeps 96% of accuracy.", "这并非意味着准确率为96%。", false],
  ["Atlas does not retain 96% of accuracy.", "Atlas 的准确率为96%。", false],
  ...readerRatioExplanations.map(row => [row.source, row.translation, false] as const),
] as const)("bounded denominator-loss preflight: %s / %s", (source, translated, rejected) => {
  expect(losesAccuracyRatioDenominator(source, translated)).toBe(rejected);
});

it.each(readerRatioExplanations)("delegates explanations/multiple subjects to the actual primary path: $id", async ({ source, translation }) => {
  expect(hasUnverifiedRatioBaseline(source, translation)).toBe(false);
  vi.mocked(callStructured).mockImplementation(async () => ({ data: { verdicts: [{ index: 1, kind: "factual", supports: true,
    citation_indexes: [1], evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: source.length, evidence_excerpt: source }],
  }] } }) as never);
  const result = await verifyDisplayedQuoteCoverage({ statement: translation, headline: "", importance_basis: "" },
    [{ content_item_id: "ci", claim: translation, quote: source, locator: { paragraph_index: 0, char_start: 0, char_end: source.length } }],
    1, undefined, undefined, source);
  expect(result.covered).toBe(true);
  expect(vi.mocked(callStructured).mock.calls.some(([r]) => r.telemetryOperation === "display_quote_primary")).toBe(true);
  expect(result.claims.every(c => c.reason !== "translation_ratio_denominator_lost")).toBe(true);
});

it("carries ratio/base/unit discipline in both translator and primary-equivalence prompts", () => {
  for (const prompt of [READER_LANGUAGE_REPAIR_SYSTEM, READER_LANGUAGE_EQUIVALENCE_RULE]) {
    expect(prompt).toContain("保留比例不等于绝对准确率");
    expect(prompt).toContain("保持了X%的准确率");
    expect(prompt).toContain("剩余成本比例不等于成本降幅");
    expect(prompt).toContain("百分比不等于百分点");
    expect(prompt).toContain("不得猜测比较基线");
    expect(prompt).toContain("路由目标不是比较基线");
    expect(prompt).toContain("按完整译文判断分母");
    expect(prompt).toContain("背景词不等于给出了比例分母");
    expect(prompt).toContain("是在保留原文的节省/损失关系，不是擅自换算");
  }
  expect(analyzerCacheVersion()).toMatch(/\|v26$/);
});

const cases = [...readerRatioCases.flatMap((r) => [
  { id: `${r.id}-good`, source: r.source, translation: r.good, supports: true },
  { id: `${r.id}-bad`, source: r.source, translation: r.bad, supports: false },
]), ...readerRatioReferenceControls.map(row => ({ ...row, supports: false })),
{ id: unstatedRatioBaseline.id, source: unstatedRatioBaseline.source, translation: unstatedRatioBaseline.bad, supports: false },
{ id: "ambiguous-keeps-accuracy", source: "Atlas retains 96% of accuracy at 42% of the cost.",
  translation: "Atlas 在 42% 的成本下保持了 96% 的准确率。", supports: false },
{ id: "explicit-cost-reduction", source: "Atlas reduces cost by 42% compared with Orion.",
  translation: "Atlas 的成本相对 Orion 降低了 42%。", supports: true }];

// This verifies production wiring, fail-closed handling and evidence identity, not model quality.
// The companion real-model runner checks whether the primary actually makes these verdicts.
it.each(cases)("keeps quote-only coverage independent and enforces the primary ratio verdict: $id", async ({ source, translation, supports }) => {
  vi.mocked(callStructured).mockImplementation(async (request) => {
    if (request.telemetryOperation === "reader_language_repair") return { data: { statement: translation } } as never;
    const isTranslatedPrimary = request.role === "validator" && request.user.includes("<translation_source_claim>");
    const accepted = !isTranslatedPrimary || supports;
    return { data: { verdicts: [{ index: 1, kind: "factual", supports: accepted,
      citation_indexes: accepted ? [1] : [], evidence_spans: accepted
        ? [{ citation_index: 1, quote_start: 0, quote_end: source.length, evidence_excerpt: source }] : [],
    }] } } as never;
  });
  const input: Insight = { id: "ratio", topic_id: "t", type: "aggregation", event_id: null, statement: source,
    statement_citation_index: 1, importance: 3, importance_reason: "evaluation_interpretation",
    importance_reason_claim_indexes: [1], importance_facts: [], importance_basis: "系统重要性判断：该结果可为评测解读提供参考。",
    citations: [{ content_item_id: "ci", citation_ref: "cite-ratio", claim: source, quote: source,
      locator: { paragraph_index: 0, char_start: 0, char_end: source.length } }],
    source_count: 1, multi_source: false, time_window: { start: "", end: "" }, confidence: null, language: "zh" };
  const evidence = structuredClone(input.citations[0]);
  const decisions: CoverageDecision[] = [];
  const result = await filterByQuoteCoverage([input], undefined, undefined, d => decisions.push(d));
  expect(result).toHaveLength(supports ? 1 : 0);
  expect(decisions).toHaveLength(1);
  expect(decisions[0].reader_language_repair?.status).toBe(supports ? "repaired" : "rejected");
  // The existing stable-token preflight catches % introduced into a percentage-points quote.
  if (decisions[0].claims[0].reason === "statement_token_not_in_bound_quote") {
    expect(source).toContain("12 percentage points");
    expect(supports).toBe(false);
    expect(callStructured).toHaveBeenCalledTimes(3);
    return;
  }
  if (["translation_ratio_denominator_lost", "translation_ratio_baseline_unverified"].includes(decisions[0].claims[0].reason)) {
    expect(supports).toBe(false);
    const calls = vi.mocked(callStructured).mock.calls.map(([r]) => r);
    expect(calls.map(r => r.telemetryOperation)).toEqual([
      "display_quote_primary", "display_quote_countercheck", "reader_language_repair", "display_quote_countercheck",
    ]);
    expect(calls[1].user).toBe(calls[3].user);
    expect(decisions[0].claims[0].countercheck?.supports).toBe(true);
    return;
  }
  expect(decisions[0].claims[0].reason).toBe(supports ? "judge_supported" : "judge_not_supported");
  const requests = vi.mocked(callStructured).mock.calls.map(([r]) => r);
  expect(requests).toHaveLength(5);
  expect(requests[3].user).toContain(source);
  expect(requests[1].user).toBe(requests[4].user);
  expect(requests[1].system).toBe(requests[4].system);
  expect(requests[4].user).not.toContain(translation);
  expect(decisions[0].prompt_hash).toBe(createHash("sha256").update(requests[3].system).digest("hex"));
  if (supports) {
    expect(result[0].reader_statement).toBe(translation);
    expect(result[0].statement).toBe(source);
    expect(result[0].citations[0]).toEqual({ ...evidence, claim: translation });
  }
});

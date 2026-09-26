import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Insight, Topic, ContentItem, ValidationResult } from "../types.js";
vi.mock("../runtime/llm.js", () => ({ callStructured: vi.fn(), assertCoverageModelSeparation: vi.fn(),
  MODELS: { analyzer: "a", validator: "v", coverage: "c" } }));
import { callStructured } from "../runtime/llm.js";
import { analyze, filterByQuoteCoverage, type CoverageDecision } from "./analyzer.js";
import { containsChinese } from "./reader-language.js";
import { sourceQuoteHash } from "../utils/source-quote-projection.js";
import { auditSupportsReaderStatement } from "../utils/display-coverage-audit.js";
import { createHash } from "node:crypto";
import { openDb } from "../db/index.js";
import { insertTopic, insertSource, insertContentItem } from "../db/repos.js";
import { saveAnalysisBatch, getAnalysisBatch } from "../db/analysis.js";
import { buildReport } from "./report-gen.js";

const quote = "Atlas reduces latency by 20%.";
const chinese = "Atlas 将延迟降低 20%。";
function candidate(statement = quote, language: Insight["language"] = "zh"): Insight {
  return { id: "candidate-1", topic_id: "t", type: "aggregation", event_id: null, statement,
    statement_citation_index: 1, importance: 3, importance_basis: "", headline: "",
    citations: [{ content_item_id: "ci", claim: statement, quote,
      locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }],
    source_count: 1, multi_source: false, time_window: { start: "", end: "" }, confidence: null,
    language, is_followup: false, entities: [], tags: [],
  };
}
function mockCalls(options: { translation?: string; originalSupport?: boolean; translatedSupport?: boolean; repairError?: Error; controller?: AbortController } = {}) {
  vi.mocked(callStructured).mockImplementation(async (request) => {
    if (request.telemetryOperation === "reader_language_repair") {
      if (options.controller) {
        options.controller.abort(new Error("cancelled by caller"));
        throw options.controller.signal.reason;
      }
      if (options.repairError) throw options.repairError;
      return { data: { statement: options.translation ?? chinese } } as never;
    }
    const translated = request.user.includes(chinese);
    const supports = request.role === "coverage" || (translated ? options.translatedSupport : options.originalSupport) !== false;
    return { data: { verdicts: [{ index: 1, kind: "factual", supports,
      citation_indexes: supports ? [1] : [], evidence_spans: supports
        ? [{ citation_index: 1, quote_start: 0, quote_end: quote.length, evidence_excerpt: quote }] : [],
    }] } } as never;
  });
}
beforeEach(() => { vi.mocked(callStructured).mockReset(); });

describe("Chinese reader-language repair", () => {
  it("carries real analyzer audit IDs through SQLite into the production report renderer", async () => {
    mockCalls();
    vi.mocked(callStructured).mockResolvedValueOnce({ data: { no_significant_event: false, insights: [{
      statement: quote, statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
      importance_reason: "engineering_decision", importance_reason_claim_indexes: [1], importance_facts: [],
      confidence: null, event_id: null, is_followup: false, entities: [], tags: [],
      citations: [{ content_item_id: "ci", claim: quote, quote }],
    }] } } as never);
    const topic: Topic = { id: "t", name: "测试", keywords: [], language: "zh", enabled: true, brief_schedule: "daily" };
    const item: ContentItem = { id: "ci", source_id: "s", url: "https://example.test/fact", title: "Fixture",
      author: null, published_at: null, fetched_at: "2026-09-26T00:00:00Z", language: "en", topic_ids: ["t"], tags: [],
      body: quote, body_kind: "article", raw_ref: "", content_hash: "fixture", fetch_status: "ok" };
    const batch = await analyze(topic, [item], { start: "2026-09-26", end: "2026-09-26" });
    const db = openDb(":memory:");
    try {
      insertTopic(db, topic);
      insertSource(db, { id: "s", name: "Fixture", type: "rss", endpoint: "https://example.test/feed", topic_ids: ["t"],
        fetch_interval: "1h", backfill: null, enabled: true });
      insertContentItem(db, item);
      saveAnalysisBatch(db, batch);
      const stored = getAnalysisBatch(db, batch.id)!;
      expect(stored.insights[0].reader_statement).toBe(chinese);
      const validation: ValidationResult = { checks: [{ insight_id: stored.insights[0].id, citation_index: 0,
        reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }],
        report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0,
          insights_total: 1, insights_includable: 1, releasable: true } };
      const input = { topic, batch: stored, validation, type: "brief" as const,
        contentLookup: new Map([[item.id, { source_id: "s", source_name: "Fixture", tags: [], url: item.url, published_at: null, observed_at: item.fetched_at }]]) };
      const { report, index } = buildReport(input);
      expect(report.status).toBe("done");
      expect(report.body_html).toContain(chinese);
      expect(report.body_md).toContain(`原文证据：「${quote}」`);
      expect(index.summary).toBe(chinese);
      validation.checks[0].verdict = "blocked";
      validation.checks[0].consistency = "not_support";
      expect(buildReport(input).report.body_md).not.toContain(chinese);
    } finally { db.close(); }
  });
  it("detects entirely non-Chinese prose without treating product names as Chinese", () => {
    expect(containsChinese(quote)).toBe(false);
    expect(containsChinese(chinese)).toBe(true);
  });
  it("audits the original and translated claims and preserves quote/locator with a single final disposition", async () => {
    mockCalls();
    const audits: CoverageDecision[] = [];
    const input = candidate();
    const originalCitation = structuredClone(input.citations[0]);
    const [result] = await filterByQuoteCoverage([input], undefined, undefined, (d) => audits.push(d));
    expect(result.reader_statement).toBe(chinese);
    expect(result.statement).toBe(quote);
    expect(result.citations[0]).toMatchObject({ quote: originalCitation.quote, locator: originalCitation.locator, content_item_id: "ci", claim: chinese });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ terminal_reason: "kept", draft_statement_sha256: sourceQuoteHash(chinese),
      statement_citation_claim: chinese, reader_language_repair: { status: "repaired", source_draft_sha256: sourceQuoteHash(quote) } });
    expect(auditSupportsReaderStatement(audits[0], chinese)).toBe(true);
    expect(auditSupportsReaderStatement(audits[0], quote)).toBe(false);
    expect(vi.mocked(callStructured).mock.calls.map(([r]) => r.telemetryOperation)).toEqual([
      "display_quote_primary", "display_quote_countercheck", "reader_language_repair", "display_quote_primary", "display_quote_countercheck",
    ]);
    expect(vi.mocked(callStructured).mock.calls[2][0]).toMatchObject({ role: "analyzer", maxTokens: 1024, thinking: false });
    const requests = vi.mocked(callStructured).mock.calls.map(([r]) => r);
    expect(requests[0].user).not.toContain("<translation_source_claim>");
    expect(requests[3].user).toContain(`<translation_source_claim>\n${quote}\n</translation_source_claim>`);
    expect(requests[3].system).toContain("事实等价");
    expect(audits[0].prompt_hash).toBe(createHash("sha256").update(requests[3].system).digest("hex"));
    expect(requests[4].user).toBe(requests[1].user);
    expect(requests[4].system).toBe(requests[1].system);
  });
  it.each([[chinese, "zh"], [quote, "en"], [quote, "mixed"]] as const)("does not add translation calls for %s (%s)", async (text, language) => {
    mockCalls();
    expect(await filterByQuoteCoverage([candidate(text, language)])).toHaveLength(1);
    expect(callStructured).toHaveBeenCalledTimes(2);
  });
  it("never translates an original claim rejected by the primary judge", async () => {
    mockCalls({ originalSupport: false });
    expect(await filterByQuoteCoverage([candidate()])).toEqual([]);
    expect(callStructured).toHaveBeenCalledTimes(2);
  });
  it.each(["Atlas reduces latency by 20%.", "Atlas 将延迟降低"])("rejects invalid translation without another repair: %s", async (translation) => {
    mockCalls({ translation });
    const audits: CoverageDecision[] = [];
    expect(await filterByQuoteCoverage([candidate()], undefined, undefined, (d) => audits.push(d))).toEqual([]);
    expect(audits[0]).toMatchObject({ terminal_reason: "dropped_coverage", reader_language_repair: { status: "invalid" } });
    expect(audits[0].reader_language_repair?.translated_draft_sha256).toBe(sourceQuoteHash(translation));
    expect(callStructured).toHaveBeenCalledTimes(3);
  });
  it("rejects numeric expansion before paying for another judge", async () => {
    mockCalls({ translation: "Atlas 将延迟降低 99%。" });
    const audits: CoverageDecision[] = [];
    expect(await filterByQuoteCoverage([candidate()], undefined, undefined, (d) => audits.push(d))).toEqual([]);
    expect(audits[0].claims[0].reason).toBe("statement_token_not_in_bound_quote");
    expect(audits[0].reader_language_repair?.translated_draft_sha256).toBe(sourceQuoteHash("Atlas 将延迟降低 99%。"));
    expect(callStructured).toHaveBeenCalledTimes(3);
  });
  it("rejects a translated claim that fails the second semantic audit", async () => {
    mockCalls({ translatedSupport: false });
    const audits: CoverageDecision[] = [];
    expect(await filterByQuoteCoverage([candidate()], undefined, undefined, (d) => audits.push(d))).toEqual([]);
    expect(audits[0].reader_language_repair?.status).toBe("rejected");
    expect(callStructured).toHaveBeenCalledTimes(5);
  });
  it.each([
    { source: quote, evidence: "Atlas reduces latency by 20% and memory usage by 30%.", translation: "Atlas 将内存使用降低 30%。" },
    { source: "Atlas reduces latency by 20% in controlled tests.", evidence: "Atlas reduces latency by 20% in controlled tests and production deployments.", translation: chinese },
  ])("passes original-claim equivalence to the judge, rejecting supported but changed facts: $source", async ({ source, evidence, translation }) => {
    mockCalls({ translation });
    const original = vi.mocked(callStructured).getMockImplementation()!;
    vi.mocked(callStructured).mockImplementation(async (request) => {
      if (request.role === "validator" && request.user.includes("<translation_source_claim>")) {
        expect(request.user).toContain(source);
        expect(request.system).toContain("原主张不得补足 quote 缺失的任何证据");
        return { data: { verdicts: [{ index: 1, kind: "factual", supports: false, citation_indexes: [], evidence_spans: [] }] } } as never;
      }
      if (request.telemetryOperation === "reader_language_repair") return original(request);
      return { data: { verdicts: [{ index: 1, kind: "factual", supports: true, citation_indexes: [1],
        evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: evidence.length, evidence_excerpt: evidence }] }] } } as never;
    });
    const input = candidate(source);
    input.citations[0].quote = evidence;
    input.citations[0].locator.char_end = evidence.length;
    const audits: CoverageDecision[] = [];
    expect(await filterByQuoteCoverage([input], undefined, undefined, (d) => audits.push(d))).toEqual([]);
    expect(audits[0].reader_language_repair?.status).toBe("rejected");
    expect(callStructured).toHaveBeenCalledTimes(5);
  });
  it("drops a failed translation without exposing the error or falling back to English", async () => {
    mockCalls({ repairError: new Error("upstream timeout with sensitive body") });
    const audits: CoverageDecision[] = [];
    expect(await filterByQuoteCoverage([candidate()], undefined, undefined, (d) => audits.push(d))).toEqual([]);
    expect(audits[0]).toMatchObject({ terminal_reason: "dropped_coverage_error", reader_language_repair: { status: "unavailable" } });
    expect(JSON.stringify(audits)).not.toContain("sensitive body");
    expect(callStructured).toHaveBeenCalledTimes(3);
  });
  it("propagates cancellation instead of treating it as a content rejection", async () => {
    const controller = new AbortController();
    mockCalls({ controller });
    await expect(filterByQuoteCoverage([candidate()], undefined, undefined, undefined, controller.signal)).rejects.toThrow("cancelled by caller");
    expect(callStructured).toHaveBeenCalledTimes(3);
  });
});

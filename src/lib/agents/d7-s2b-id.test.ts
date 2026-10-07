import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisBatch, ContentItem, Insight, Topic, ValidationResult } from "../types.js";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { getInsightsByIds, getAnalysisBatch, saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import { computeAnalysisKey, lookupCachedInsights, recordAnalysisCache } from "../db/analysis-cache.js";
import { contentHash } from "../sources/normalize.js";
import { getReport, listRecentBriefEvents } from "../db/reports.js";
import { planRawArchive, writePlannedRawArchive } from "../db/raw-archive.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";
import { buildReport } from "./report-gen.js";
import { runAnalysis, runReportGen, runValidation } from "./pipeline.js";
import { analyze, analyzeChunkInputSha256, analyzerCacheVersion, type AnalyzeChunkCompletion } from "./analyzer.js";
import { callStructured } from "../runtime/llm.js";

vi.mock("../runtime/llm.js", () => ({ callStructured: vi.fn(), assertCoverageModelSeparation: vi.fn(), assertModelSeparation: vi.fn(), MODELS: { analyzer: "test-analyzer", validator: "test-validator", coverage: "test-coverage" } }));
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn(), notifyReport: vi.fn(), notifyThinBrief: vi.fn(), notifyBriefAcceptance: vi.fn() }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes), randomUUID: vi.fn(actual.randomUUID) };
});
const topic: Topic = { id: "t_ai_tools_abcd", name: "AI Tools", keywords: ["tools"], facets: ["domain:software-engineering"], language: "en", enabled: true, brief_schedule: "daily" };
const window = { start: "2026-10-01T00:00:00Z", end: "2026-10-07T00:00:00Z" };
const quote = "Fact is supported.";
const item: ContentItem = { id: "ci_s2", source_id: "src_ai_feed_abcd", url: "https://example.test/s2", title: "Synthetic", author: null, published_at: window.start, fetched_at: window.start, topic_ids: [topic.id], language: "en", tags: [], body: quote, body_kind: "article", content_hash: contentHash(quote), raw_ref: "", fetch_status: "ok" };
function output(event_id: string | null = null, contentId = item.id) {
  return { no_significant_event: false, insights: [{ statement: quote, statement_citation_index: 1, headline: "", type: "aggregation", importance: 3,
    importance_facts: [], importance_reason: "research_tracking", importance_reason_claim_indexes: [1], confidence: null, event_id, is_followup: !!event_id, entities: [], tags: [],
    citations: [{ content_item_id: contentId, claim: quote, quote }] }] };
}
function model(eventId: string | null = null, contentId = item.id) {
  vi.mocked(callStructured).mockImplementation(async (request) => ({ data: request.telemetryOperation === "analysis_generation" ? output(eventId, contentId) : request.telemetryOperation === "citation_consistency_single" ? { consistency: "support", consistency_reason: "ok", rationale: "Synthetic supported evidence" } : { verdicts: [{ index: 1, kind: "factual", supports: true, citation_indexes: [1], evidence_spans: [{ citation_index: 1, quote_start: 0, quote_end: quote.length, evidence_excerpt: quote }] }] } }) as Awaited<ReturnType<typeof callStructured>>);
}
function validation(batch: AnalysisBatch): ValidationResult {
  return { checks: batch.insights.map((ins) => ({ insight_id: ins.id, citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" })),
    report: { total: batch.insights.length, pass: batch.insights.length, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: batch.insights.length, insights_includable: batch.insights.length, releasable: true } };
}
let db: DB; let root: string;
beforeEach(async () => {
  vi.clearAllMocks(); model();
  const crypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  vi.mocked(randomBytes).mockImplementation(crypto.randomBytes); vi.mocked(randomUUID).mockImplementation(crypto.randomUUID);
  vi.stubEnv("COVERAGE_MAX_TOKENS", "2048");
  root = mkdtempSync(join(tmpdir(), "ia-d7-s2b-")); vi.stubEnv("DATA_DIR", root);
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertTopic(db, topic);
  insertSource(db, { id: item.source_id, name: "Synthetic", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true });
  insertContentItem(db, item);
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: quote, source_body_kind: "article", source_item_raw: "synthetic", structured_body_sha256: item.content_hash }) + "\n";
  writePlannedRawArchive(db, planRawArchive(db, { contentId: item.id, raw }), raw);
  vi.mocked(randomBytes).mockClear(); vi.mocked(randomUUID).mockClear();
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const requestPayloads = () => vi.mocked(callStructured).mock.calls.map(([request]) => ({ operation: request.telemetryOperation, system: request.system, user: request.user, schema: request.schema, maxTokens: request.maxTokens }));

describe("D7 S2b new generation contract (red before implementation)", () => {
  it("candidate independently uses the complete 128-bit suffix before formal ID replacement", async () => {
    const batch = await analyze(topic, [item], window);
    expect(batch.display_coverage_candidate_audits![0].candidate_id).toMatch(/^ins_[a-f0-9]{32}$/);
    expect(batch.display_coverage_audits![0].candidate_id).toBe(batch.display_coverage_candidate_audits![0].candidate_id);
  });
  it("real Node generator wires candidate→batch→Insight/event→DB citation/audit→published history", async () => {
    const batch = await analyze(topic, [item], window);
    expect(batch.id).toMatch(/^batch_[a-f0-9]{32}$/);
    const ins = batch.insights[0]; const candidate = batch.display_coverage_candidate_audits![0].candidate_id;
    expect(candidate).toMatch(/^ins_[a-f0-9]{32}$/); expect(ins.id).toBe(`ins_${batch.id}_0`); expect(ins.event_id).toBe(`evt_${batch.id}_0`);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16]]); expect(randomUUID).not.toHaveBeenCalled();
    saveAnalysisBatch(db, batch); expect(getAnalysisBatch(db, batch.id)).toMatchObject({ id: batch.id, topic_id: topic.id, display_coverage_audits: batch.display_coverage_audits, display_coverage_candidate_audits: batch.display_coverage_candidate_audits });
    expect(getInsightsByIds(db, [ins.id])[0]).toMatchObject({ id: ins.id, event_id: ins.event_id, citations: ins.citations });
    vi.stubEnv("VALIDATOR_BATCH", "0");
    const vr = await runValidation(db, batch, [item]);
    expect(vr.checks).toMatchObject([{ insight_id: ins.id, verdict: "pass", consistency: "support" }]);
    const report = await runReportGen(db, { topic, batch, validation: vr, type: "brief", asOf: window.end });
    expect(getReport(db, report.id)).toMatchObject({ insight_ids: [ins.id], event_ids: [ins.event_id] });
    const history = listRecentBriefEvents(db, topic.id, { asOf: window.end }); expect(history).toMatchObject([{ event_id: ins.event_id }]);
    vi.mocked(callStructured).mockClear(); model(ins.event_id);
    const followed = await analyze(topic, [item], window, undefined, { history });
    expect(followed.insights[0]).toMatchObject({ event_id: ins.event_id, is_followup: true });
    expect(requestPayloads()[0].user).toContain(`[${ins.event_id}]`);
  });

  it("controlled bytes preserve allocation before requests and one draw per candidate including dropped", async () => {
    const timeline: string[] = [];
    vi.mocked(randomBytes).mockImplementation(((size: number) => { timeline.push(`random:${size}`); return Buffer.from(Array.from({ length: size }, (_, i) => i)); }) as typeof randomBytes);
    const prior = vi.mocked(callStructured).getMockImplementation()!;
    vi.mocked(callStructured).mockImplementation((request) => { timeline.push(request.telemetryOperation ?? "request"); return prior(request); });
    const batch = await analyze(topic, [item], window);
    const hex = "000102030405060708090a0b0c0d0e0f";
    expect(batch.id).toBe(`batch_${hex}`); expect(batch.display_coverage_audits![0].candidate_id).toBe(`ins_${hex}`);
    expect(timeline.slice(0, 3)).toEqual(["random:16", "analysis_generation", "random:16"]);
    vi.mocked(callStructured).mockResolvedValue({ data: { ...output(), insights: [{ ...output().insights[0], statement_citation_index: 99, statement: "unfinished because" }] } } as Awaited<ReturnType<typeof callStructured>>);
    await expect(analyze(topic, [item], window)).rejects.toThrow();
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16], [16], [16]]);
  });
  it("empty input and completed chunks still allocate exactly once; malformed checkpoint rejects before model", async () => {
    const empty = await analyze(topic, [], window); expect(empty.id).toMatch(/^batch_[a-f0-9]{32}$/);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16]]); expect(callStructured).not.toHaveBeenCalled();
    await expect(analyze(topic, [item], window, undefined, { completed_chunks: [{ input_sha256: "wrong", insights: [], coverage_decisions: [] }] })).rejects.toThrow(/checkpoint/);
    expect(callStructured).not.toHaveBeenCalled(); expect(vi.mocked(randomBytes).mock.calls).toEqual([[16], [16]]);
  });
  it("configuration fails before allocation; cancellation preserves batch-before-chunk timing", async () => {
    vi.stubEnv("COVERAGE_MAX_TOKENS", "3000");
    await expect(analyze(topic, [item], window)).rejects.toThrow(/COVERAGE_MAX_TOKENS/);
    expect(randomBytes).not.toHaveBeenCalled(); expect(callStructured).not.toHaveBeenCalled();
    vi.stubEnv("COVERAGE_MAX_TOKENS", "2048");
    const controller = new AbortController(); controller.abort(new Error("synthetic cancelled"));
    await expect(analyze(topic, [item], window, undefined, { signal: controller.signal })).rejects.toThrow("synthetic cancelled");
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[16]]); expect(callStructured).not.toHaveBeenCalled();
  });
});

describe("D7 S2b identity and failure protection", () => {
  it("baseline readers accept fixed old/new batches and publish only exact supported citations", async () => {
    const batches = ["batch_abcd1234", `batch_${"a".repeat(32)}`].map((id): AnalysisBatch => ({
      id, topic_id: topic.id, time_window: window, status: "done", no_significant_event: false, display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
      display_coverage_audits: [{ insight_id: `ins_${id}_0`, candidate_id: `ins_fixed_${id}`, gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "synthetic", validator_model: "synthetic-c", created_at: window.start,
        decision: { statement_citation_index: 1, statement_citation_ref: "cite_synthetic_stable", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash(quote), quote_sha256: sourceQuoteHash(quote), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] } }],
      insights: [{ id: `ins_${id}_0`, event_id: `evt_${id}_0`, topic_id: topic.id, type: "aggregation", statement: quote,
        statement_citation_index: 1, importance: 3, importance_basis: "系统重要性判断：该结果可为研究跟踪提供参考。", source_count: 1, multi_source: false,
        confidence: null, time_window: window, language: "en", citations: [{ content_item_id: item.id, claim: quote, quote,
          citation_ref: "cite_synthetic_stable", locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }] }],
    }));
    for (const batch of batches) {
      saveAnalysisBatch(db, batch);
      expect(getAnalysisBatch(db, batch.id)).toMatchObject(batch);
      expect(getAnalysisBatch(db, `${batch.id}_wrong`)).toBeNull();
      const vr = validation(batch); saveValidationResult(db, batch.id, vr);
      const report = await runReportGen(db, { topic, batch, validation: vr, type: "brief", asOf: window.end });
      // Existing same-evidence history exclusion applies to the second batch.
      expect(report.insight_ids).toEqual(batch === batches[0] ? [batch.insights[0].id] : []);
      expect(getInsightsByIds(db, [batch.insights[0].id])[0].citations[0].citation_ref).toBe("cite_synthetic_stable");
      expect(buildReport({ topic, batch, validation: vr, type: "brief", contentLookup: new Map(), now: window.end }).report.insight_ids).toEqual([batch.insights[0].id]);
      for (const checks of [[], [{ ...vr.checks[0], consistency: "not_support" as const, verdict: "blocked" as const }]]) {
        const built = buildReport({ topic, batch, validation: { ...vr, checks }, type: "brief", contentLookup: new Map(), now: window.end });
        expect(built.report.insight_ids).toEqual([]); expect(built.report.citation_count).toBe(0);
      }
      // A permissive aggregate cannot bypass exact per-citation binding in the
      // real persistence/history path, for either old or full-length batch roots.
      for (const checks of [[], [{ ...vr.checks[0], consistency: "not_support" as const, verdict: "blocked" as const }],
        [{ ...vr.checks[0], insight_id: "ins_wrong" }], [{ ...vr.checks[0], citation_index: 99 }]]) {
        const negative = await runReportGen(db, { topic, batch, validation: { ...vr, checks }, type: "deep_dive", asOf: window.end });
        expect(getReport(db, negative.id)).toMatchObject({ insight_ids: [], event_ids: [], citation_count: 0 });
      }
      const beforeFailed = listRecentBriefEvents(db, topic.id, { asOf: window.end });
      await expect(runReportGen(db, { topic, batch, validation: { ...vr, checks: [], report: { ...vr.report, releasable: false } }, type: "brief", asOf: window.end })).rejects.toThrow("no_releasable_insight");
      expect(listRecentBriefEvents(db, topic.id, { asOf: window.end })).toEqual(beforeFailed);
    }
    expect(getInsightsByIds(db, batches.map((b) => b.insights[0].id)).map((ins) => ins.event_id)).toEqual(batches.map((b) => b.insights[0].event_id));
  });
  it.each([false, true])("duplicate candidates fail transaction for kept + dropped=%s without model retry", async (dropSecond) => {
    // Force the existing collision protocol at both random sources; no new retry policy.
    vi.mocked(randomUUID).mockReturnValue("01234567-89ab-4cde-8123-456789abcdef");
    vi.mocked(randomBytes).mockImplementation(((size: number) => Buffer.alloc(size, 0x12)) as typeof randomBytes);
    const prior = vi.mocked(callStructured).getMockImplementation()!;
    vi.mocked(callStructured).mockImplementation((request) => request.telemetryOperation === "analysis_generation"
      ? Promise.resolve({ data: { ...output(), insights: [output().insights[0], { ...output().insights[0], ...(dropSecond ? { statement_citation_index: 99, statement: "unfinished because" } : {}) }] } } as Awaited<ReturnType<typeof callStructured>>)
      : prior(request));
    const batch = await analyze(topic, [item], window);
    expect(batch.display_coverage_candidate_audits).toHaveLength(2);
    const calls = vi.mocked(callStructured).mock.calls.length;
    expect(() => saveAnalysisBatch(db, batch)).toThrow(/UNIQUE/);
    expect(getAnalysisBatch(db, batch.id)).toBeNull();
    for (const table of ["insight", "citation", "display_coverage_audit", "display_coverage_candidate_audit"]) expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(callStructured).toHaveBeenCalledTimes(calls);
  });
  it("old history ID is reused exactly, unknown event is rejected, candidate is absent from actual requests", async () => {
    const history = [{ event_id: "evt_batch_abcd1234_0", statement: "Older supported fact.", date: "2026-10-01" }];
    model(history[0].event_id); const batch = await analyze(topic, [item], window, undefined, { history });
    expect(batch.insights[0]).toMatchObject({ event_id: history[0].event_id, is_followup: true });
    for (const payload of requestPayloads()) { expect(payload.user).not.toContain(batch.id); expect(payload.user).not.toContain(batch.display_coverage_audits![0].candidate_id); }
    model("evt_invented"); expect((await analyze(topic, [item], window, undefined, { history })).insights[0]).toMatchObject({ event_id: expect.stringContaining("evt_batch_"), is_followup: false });
  });
  it("actual generation/coverage payload comparison measures source/event changes separately", async () => {
    const oldEvent = "evt_batch_abcd1234_0", newEvent = `evt_batch_${"a".repeat(32)}_0`;
    const history = [{ event_id: oldEvent, statement: "Older fact.", date: "2026-10-01" }];
    await analyze(topic, [item], window, undefined, { history }); const old = requestPayloads();
    vi.mocked(callStructured).mockClear();
    await analyze({ ...topic, id: `t_ai_tools_${"a".repeat(32)}` }, [{ ...item, source_id: `src_ai_feed_${"a".repeat(32)}` }], window, undefined, { history: [{ ...history[0], event_id: newEvent }] });
    const next = requestPayloads();
    expect(next).toHaveLength(old.length);
    expect(next[0]).toEqual({ ...old[0], user: old[0].user.replace(item.source_id, `src_ai_feed_${"a".repeat(32)}`).replace(oldEvent, newEvent) });
    expect(next.slice(1)).toEqual(old.slice(1));
    expect(next[0].user.length - old[0].user.length).toBe(52); expect(Buffer.byteLength(next[0].user) - Buffer.byteLength(old[0].user)).toBe(52);
    // An evidence log of hashes/lengths only; this is not a provider token count or quality eval.
    console.info("D7 S2 payload", { before_bytes: Buffer.byteLength(old[0].user), after_bytes: Buffer.byteLength(next[0].user), source_delta: 28, event_delta: 24,
      before_sha256: createHash("sha256").update(old[0].user).digest("hex"), after_sha256: createHash("sha256").update(next[0].user).digest("hex"), actual_tokens: "unknown; mock transport" });
  });
  it("completed chunk retains candidate identity; changed topic/source/history rejects replay", async () => {
    let checkpoint!: AnalyzeChunkCompletion;
    const checkpointPath = join(root, "chunk.json"), copyPath = join(root, "chunk-copy.json");
    const first = await analyze(topic, [item], window, undefined, { onChunkComplete: (completion) => { writeFileSync(checkpointPath, JSON.stringify(completion)); } });
    const originalBytes = readFileSync(checkpointPath);
    copyFileSync(checkpointPath, copyPath);
    checkpoint = JSON.parse(readFileSync(copyPath, "utf8"));
    vi.mocked(callStructured).mockClear();
    const replay = await analyze(topic, [item], window, undefined, { completed_chunks: [structuredClone(checkpoint)] });
    expect(callStructured).not.toHaveBeenCalled(); expect(replay.display_coverage_audits![0].candidate_id).toBe(first.display_coverage_audits![0].candidate_id);
    expect(replay.insights[0].citations).toEqual(first.insights[0].citations);
    expect(replay.display_coverage_audits![0].decision).toEqual(first.display_coverage_audits![0].decision);
    for (const [changedTopic, changedItems, history] of [[{ ...topic, id: "different" }, [item], []], [topic, [{ ...item, source_id: "different" }], []], [topic, [item], [{ event_id: "evt_other", statement: "History", date: "2026-10-01" }]]] as const) {
      expect(analyzeChunkInputSha256(changedTopic, changedItems, window, history)).not.toBe(checkpoint.input_sha256);
      await expect(analyze(changedTopic, [...changedItems], window, undefined, { history: [...history], completed_chunks: [structuredClone(checkpoint)] })).rejects.toThrow(/checkpoint/);
    }
    expect(callStructured).not.toHaveBeenCalled();
    await expect(analyze(topic, [item], window, undefined, { completed_chunks: [{ ...checkpoint, input_sha256: "0".repeat(64) }] })).rejects.toThrow(/checkpoint/);
    expect(callStructured).not.toHaveBeenCalled();
    expect(readFileSync(checkpointPath)).toEqual(originalBytes); expect(readFileSync(copyPath)).toEqual(originalBytes);
  });
  it("real pipeline cache mixed hit/miss retains old event and first cache bytes", async () => {
    vi.stubEnv("ANALYSIS_CACHE", "1"); vi.stubEnv("ANALYSIS_CACHE_READ", "1"); vi.stubEnv("FULL_REANALYZE_DOW", "-1");
    const first = await analyze(topic, [item], window); const cached: Insight = { ...first.insights[0], id: "ins_batch_abcd1234_0", event_id: "evt_batch_abcd1234_0" };
    recordAnalysisCache(db, topic.id, [item], [cached], analyzerCacheVersion());
    const key = computeAnalysisKey(analyzerCacheVersion(), topic.id, item.content_hash);
    const before = db.prepare("SELECT insights_json FROM analysis_cache WHERE key=?").get(key);
    const newItem = { ...item, id: "ci_new", url: "https://example.test/new", content_hash: "new-hash", body: quote };
    insertContentItem(db, newItem); model(null, newItem.id); vi.mocked(callStructured).mockClear();
    const batch = await runAnalysis(db, topic, [item, newItem], window, { history: [{ event_id: cached.event_id!, statement: quote, type: "aggregation", date: "2026-10-01" }] });
    expect(batch.insights).toHaveLength(2); expect(batch.insights[1]).toMatchObject({ id: `ins_${batch.id}_1`, event_id: cached.event_id, is_followup: true });
    expect(requestPayloads()[0].user).toContain(newItem.id); expect(requestPayloads()[0].user).not.toContain(`id="${item.id}"`);
    expect(db.prepare("SELECT insights_json FROM analysis_cache WHERE key=?").get(key)).toEqual(before);
    expect(lookupCachedInsights(db, "different-topic", [item], analyzerCacheVersion()).hitItemCount).toBe(0);
    expect(lookupCachedInsights(db, topic.id, [{ ...item, id: "ci_outside" }], analyzerCacheVersion()).hitItemCount).toBe(0);
  });
  it("unique/FK/afterSave failure rolls back every row and never reruns model", async () => {
    const batch = await analyze(topic, [item], window); const calls = vi.mocked(callStructured).mock.calls.length;
    saveAnalysisBatch(db, batch); expect(() => saveAnalysisBatch(db, batch)).toThrow(/UNIQUE/);
    const failed = { ...batch, id: "batch_synthetic_failure", insights: batch.insights.map((ins) => ({ ...ins, id: "ins_synthetic_failure" })) };
    expect(() => saveAnalysisBatch(db, { ...failed, topic_id: "missing" })).toThrow(/FOREIGN KEY/);
    expect(() => saveAnalysisBatch(db, { ...failed, display_coverage_audits: [], display_coverage_candidate_audits: [] }, () => { throw new Error("afterSave failed"); })).toThrow("afterSave failed");
    expect(getAnalysisBatch(db, failed.id)).toBeNull(); expect(getInsightsByIds(db, ["ins_synthetic_failure"])).toEqual([]);
    expect(callStructured).toHaveBeenCalledTimes(calls);
  });
});

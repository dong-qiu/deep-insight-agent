/** Eval-Gate scoped：真实 runReportGen → saveReport 双 artifact/索引 → reader 的生产路径回归。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReport, queryReportIndex } from "../db/reports.js";
import { saveAnalysisBatch, saveValidationResult } from "../db/analysis.js";
import { openDb, type DB } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic, listRuns } from "../db/repos.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { appendGenerationEvent, captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import { contentItemRef, contentItemRevisionSnapshot } from "../db/provenance-revisions.js";
import type { AnalysisBatch, ContentItem, Report, ReportIndexEntry, Source, Topic, ValidationResult } from "../types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";
import { summarizeBriefSelection } from "./report-gen.js";

const { buildReportMock } = vi.hoisted(() => ({ buildReportMock: vi.fn() }));
vi.mock("./report-gen.js", async (orig) => ({
  ...(await orig<typeof import("./report-gen.js")>()),
  buildReport: buildReportMock,
}));
import { runReportGen } from "./pipeline.js";

let db: DB;
let dataDir: string;
const originalDataDir = process.env.DATA_DIR;
const topic: Topic = { id: "t1", name: "Topic", keywords: [], language: "en", brief_schedule: "daily", enabled: true, facets: [] };
const batch: AnalysisBatch = {
  id: "b1", topic_id: topic.id, time_window: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" },
  status: "done", no_significant_event: false, insights: [{
    id: "i1", topic_id: topic.id, type: "aggregation", event_id: null, statement: "A validated statement", statement_citation_index: 1, importance: 3,
    importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", citations: [{ content_item_id: "ci1", citation_ref: "binding", claim: "A validated statement", quote: "A validated statement", locator: { paragraph_index: 0, char_start: 0, char_end: 21 } }], source_count: 1, multi_source: false,
    time_window: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" }, confidence: "high", language: "en", is_followup: false, entities: [], tags: [],
  }], display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION, display_coverage_audits: [{
    insight_id: "i1", candidate_id: "i1", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage",
    decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash("A validated statement"), quote_sha256: sourceQuoteHash("A validated statement"), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-11T00:00:00Z",
  }],
};
const validation: ValidationResult = {
  checks: [{ insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true },
};

function seedCompleteTrace(): string {
  const source: Source = { id: "s1", name: "Source", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true };
  const item: ContentItem = { id: "ci1", source_id: source.id, url: "https://example.test/item", title: "Item", author: null, published_at: null, fetched_at: "2026-08-02T00:00:00Z", language: "en", topic_ids: [topic.id], tags: [], body: "A validated statement", body_kind: "article", raw_ref: "raw", content_hash: "content-hash", fetch_status: "ok" };
  insertSource(db, source); insertContentItem(db, item);
  saveAnalysisBatch(db, batch); saveValidationResult(db, batch.id, validation);
  db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
    VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-08-02T00:00:00Z')`).run();
  const content = contentItemRef(item);
  captureRevision(db, { entity_type: content.type, entity_key: entityKey(content), revision: content.revision, snapshot: contentItemRevisionSnapshot(item) });
  const batchRef: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: batch.id }, revision: batch.id, role: "input" };
  const validationRef: EntityRef = { type: "validation_result", locator: { kind: "composite", key: { batch_id: batch.id } }, revision: batch.id, role: "input" };
  const analyzerContext = { analyzer_model: "analyzer", analyzer_prompt_hash: "a".repeat(64), analyzer_output_version: "v1", analyzer_cache_mode: "write_only", coverage_model: "disabled", coverage_prompt_hash: "b".repeat(64), coverage_thinking: "off", coverage_thinking_source: "explicit" };
  const validatorContext = { validator_model: "validator", validator_prompt_hash: "c".repeat(64), validator_thinking: "on", validator_cache_mode: "on" };
  appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [content], version_context: analyzerContext, context_completeness: "complete" });
  appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "completed", input_refs: [content], output_refs: [{ ...batchRef, role: "output" }] });
  appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started", input_refs: [batchRef, content], version_context: validatorContext, context_completeness: "complete" });
  appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "completed", input_refs: [batchRef, content], output_refs: [{ ...validationRef, role: "output" }], version_context: validatorContext, context_completeness: "complete" });
  return "trace_1";
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "insight-reportgen-"));
  process.env.DATA_DIR = dataDir;
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertTopic(db, topic);
  buildReportMock.mockReset();
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir == null) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("runReportGen production persistence path", () => {
  it("publishes a validated report that the normal reader and index can consume", async () => {
    const report: Report = {
      id: "rep_1", type: "brief", topic_id: topic.id, status: "done", generated_at: "2026-08-02T00:00:00Z", title: "Brief",
      body_md: "# Brief\nvalidated", body_html: "<h1>Brief</h1><p>validated</p>", insight_ids: ["i1"], event_ids: [], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 },
    };
    const index: ReportIndexEntry = { report_id: report.id, type: report.type, topic_id: topic.id, facets: [], date: "2026-08-02", source_ids: [], title: report.title, summary: "validated", highlights: [], tags: [], entity_names: [], importance: 3, event_ids: [], milestone_count: 0 };
    buildReportMock.mockReturnValue({ report, index });

    await expect(runReportGen(db, { topic, batch, validation, type: "brief" })).resolves.toMatchObject({ id: report.id });
    expect(getReport(db, report.id)).toEqual(report);
    expect(queryReportIndex(db, { topic: topic.id }).map((row) => row.report_id)).toEqual([report.id]);
    expect(listRuns(db, { kind: "report-gen" })[0]?.status).toBe("done");
  });

  it("trace-backed publication atomically binds the complete review package before readers can see it", async () => {
    const report: Report = {
      id: "rep_trace", type: "brief", topic_id: topic.id, status: "done", generated_at: "2026-08-02T00:00:00Z", title: "Trace Brief",
      body_md: "# Trace", body_html: "<h1>Trace</h1>", insight_ids: ["i1"], event_ids: [], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 },
    };
    const index: ReportIndexEntry = { report_id: report.id, type: report.type, topic_id: topic.id, facets: [], date: "2026-08-02", source_ids: [], title: report.title, summary: "trace", highlights: [], tags: [], entity_names: [], importance: 3, event_ids: [], milestone_count: 0 };
    buildReportMock.mockReturnValue({ report, index });
    const traceId = seedCompleteTrace();
    expect(summarizeBriefSelection(batch, validation, "brief").decisions).toMatchObject([
      { insight_id: "i1", decision: "published", supporting_citation_indices: [0] },
    ]);

    await expect(runReportGen(db, { topic, batch, validation, type: "brief", traceId })).resolves.toMatchObject({ id: report.id });
    expect(getReport(db, report.id)?.status).toBe("done");
    expect(db.prepare("SELECT publication_state,validate_started_event_id FROM report_review_snapshot WHERE report_id=?").get(report.id)).toMatchObject({ publication_state: "published" });
    expect(db.prepare("SELECT decision,reason_code,supporting_citation_indices FROM report_selection_decision WHERE report_id=?").all(report.id)).toEqual([
      { decision: "published", reason_code: "selected_by_rule", supporting_citation_indices: "[0]" },
    ]);
  });

  it("does not publish an unreleasable batch to the normal reader or index", async () => {
    const unreleasable: ValidationResult = { ...validation, report: { ...validation.report, releasable: false, insights_includable: 0 } };
    await expect(runReportGen(db, { topic, batch, validation: unreleasable, type: "brief" })).rejects.toThrow("no_releasable_insight");
    expect(queryReportIndex(db, { topic: topic.id })).toEqual([]);
    expect(db.prepare("SELECT status,body_path FROM report").all()).toEqual([{ status: "failed", body_path: null }]);
  });
});

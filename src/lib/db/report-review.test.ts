import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { appendGenerationEvent, canonicalHash, captureRevision, entityKey, type EntityRef } from "./provenance-facts.js";
import { assertReviewPackageForPublish, getPublishedReportReview, listPublishedReportReviewDecisions, persistReportReviewPackage, publishReviewPackage, REPORT_SELECTION_RULE_VERSION } from "./report-review.js";

function setup(opts: { contentSnapshot?: Record<string, unknown>; reuseAnalyzeInputs?: boolean; completeContext?: boolean } = {}) {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1)").run();
  db.prepare("INSERT INTO analysis_batch(id,topic_id,time_window,status,display_coverage_state,display_projection_version) VALUES ('b','t','{}','done','audited','source_quote_v1')").run();
  db.prepare(`INSERT INTO insight(id,batch_id,topic_id,type,statement,importance,importance_basis,source_count,multi_source,time_window,language)
    VALUES ('i','b','t','aggregation','S',3,'x',1,0,'{}','en')`).run();
  db.prepare("INSERT INTO citation(insight_id,citation_index,content_item_id,quote,locator) VALUES ('i',0,'c','q','{}')").run();
  db.prepare("INSERT INTO citation_check(batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict) VALUES ('b','i',0,'pass','ok','support','ok','pass')").run();
  db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
    VALUES ('r','brief','t','generating','2026-09-11T00:00:00Z','R',NULL,'[\"i\"]','[]',NULL,1,'{}',NULL)`).run();
  db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
    VALUES ('tr','topic_pipeline','api','running','{}','complete','{}','{}','2026-09-11T00:00:00Z')`).run();
  const contentSnapshot = opts.contentSnapshot ?? { url: "https://example.test/c", source_id: "s", title: "C", published_at: null, fetched_at: "2026-09-11T00:00:00Z", body_kind: "article", fetch_status: "ok", body_length: 1, content_hash: "a" };
  const content: EntityRef = { type: "content_item", locator: { kind: "id", id: "c" }, revision: `content-v4:${canonicalHash(contentSnapshot)}`, role: "input" };
  const batch: EntityRef = { type: "analysis_batch", locator: { kind: "id", id: "b" }, revision: "b", role: "input" };
  const validation: EntityRef = { type: "validation_result", locator: { kind: "composite", key: { batch_id: "b" } }, revision: "b", role: "input" };
  captureRevision(db, { entity_type: content.type, entity_key: entityKey(content), revision: content.revision, snapshot: contentSnapshot });
  const analyzerContext = opts.completeContext === false ? {} : { analyzer_model: "analyzer", analyzer_prompt_hash: "a".repeat(64), analyzer_output_version: "v1", analyzer_cache_mode: "write_only", coverage_model: "disabled", coverage_prompt_hash: "b".repeat(64), coverage_thinking: "off", coverage_thinking_source: "explicit" };
  const validatorContext = opts.completeContext === false ? {} : { validator_model: "validator", validator_prompt_hash: "c".repeat(64), validator_thinking: "on", validator_cache_mode: "on" };
  const reportContext = opts.completeContext === false ? {} : { report_selection_rule: REPORT_SELECTION_RULE_VERSION, report_renderer: "report-selection-v1" };
  const contextCompleteness = opts.completeContext === false ? "partial" as const : "complete" as const;
  const analyzeStarted = appendGenerationEvent(db, { trace_id: "tr", stage: "analyze", event_type: "started", input_refs: [content], version_context: analyzerContext, context_completeness: contextCompleteness });
  const analyzeCompleted = appendGenerationEvent(db, { trace_id: "tr", stage: "analyze", event_type: "completed", input_refs: opts.reuseAnalyzeInputs === false ? [] : [content], output_refs: [{ ...batch, role: "output" }] });
  const validateStarted = appendGenerationEvent(db, { trace_id: "tr", stage: "validate", event_type: "started", input_refs: [batch, content], version_context: validatorContext, context_completeness: contextCompleteness });
  const validateCompleted = appendGenerationEvent(db, { trace_id: "tr", stage: "validate", event_type: "completed", input_refs: [batch, content], output_refs: [{ ...validation, role: "output" }], version_context: validatorContext, context_completeness: contextCompleteness });
  const reportStarted = appendGenerationEvent(db, { trace_id: "tr", stage: "generate_report", event_type: "started", input_refs: [batch, validation], version_context: reportContext, context_completeness: contextCompleteness });
  return { db, analyzeStarted, analyzeCompleted, validateStarted, validateCompleted, reportStarted };
}

function packageFor(events: ReturnType<typeof setup>) {
  return { report_id: "r", trace_id: "tr", analysis_batch_id: "b", analyze_started_event_id: events.analyzeStarted.id, analyze_completed_event_id: events.analyzeCompleted.id, validate_started_event_id: events.validateStarted.id, validate_completed_event_id: events.validateCompleted.id, generate_report_started_event_id: events.reportStarted.id, selection_rule_version: REPORT_SELECTION_RULE_VERSION, decisions: [{ insight_id: "i", decision: "published" as const, reason_code: "selected_by_rule", published_rank: 1, supporting_citation_indices: [0] }] };
}

describe("report review package", () => {
  it("requires one decision and matching support whitelist before publish", () => {
    const events = setup(); const { db } = events;
    persistReportReviewPackage(db, packageFor(events));
    expect(() => assertReviewPackageForPublish(db, "r", ["i"])).not.toThrow();
    expect(() => assertReviewPackageForPublish(db, "r", ["i"], { traceId: "tr", eventId: "wrong-event" }))
      .toThrow("report_review_effect_binding_mismatch");
    expect(() => assertReviewPackageForPublish(db, "r", [])).toThrow("report_review_published_set_mismatch");
    db.prepare("DELETE FROM report_selection_decision WHERE report_id='r' AND insight_id='i'").run();
    expect(() => assertReviewPackageForPublish(db, "r", ["i"])).toThrow("report_review_decisions_not_complete");
  });

  it("only exposes published, bounded decision pages to the admin reader", () => {
    const events = setup(); const { db } = events;
    persistReportReviewPackage(db, packageFor(events));
    expect(getPublishedReportReview(db, "r")).toBeNull();
    expect(listPublishedReportReviewDecisions(db, "r", { limit: 50, offset: 0 })).toBeNull();
    publishReviewPackage(db, "r");
    expect(getPublishedReportReview(db, "r")).toBeNull();
    db.prepare("UPDATE report SET status='done' WHERE id='r'").run();
    expect(getPublishedReportReview(db, "r")).toEqual(expect.objectContaining({
      report_id: "r", report_type: "brief", report_title: "R", decision_count: 1,
    }));
    db.prepare("UPDATE report SET title=? WHERE id='r'").run("x".repeat(300));
    expect(getPublishedReportReview(db, "r")?.report_title).toBe("x".repeat(240));
    expect(listPublishedReportReviewDecisions(db, "r", { limit: 1, offset: 0 })).toEqual({ total: 1, items: [{ insight_id: "i", decision: "published", reason_code: "selected_by_rule", published_rank: 1, supporting_citation_indices: [0], related_insight_id: null }] });
    expect(listPublishedReportReviewDecisions(db, "r", { limit: 1, offset: 1 })).toEqual({ total: 1, items: [] });
  });

  it("refuses mismatched stage inputs and a forged content-v4 revision snapshot", () => {
    const badInputs = setup({ reuseAnalyzeInputs: false });
    expect(() => persistReportReviewPackage(badInputs.db, packageFor(badInputs))).toThrow("report_review_trace_binding_invalid");

    const forged = setup({ contentSnapshot: { url: "https://example.test/c", source_id: "s", title: "C", published_at: null, fetched_at: "2026-09-11T00:00:00Z", body_kind: "article", fetch_status: "ok", body_length: 1, content_hash: "a", body: "must never enter review metadata" } });
    expect(() => persistReportReviewPackage(forged.db, packageFor(forged))).toThrow("report_review_trace_binding_invalid");

    const noContext = setup({ completeContext: false });
    expect(() => persistReportReviewPackage(noContext.db, packageFor(noContext))).toThrow("report_review_trace_binding_invalid");
  });
});

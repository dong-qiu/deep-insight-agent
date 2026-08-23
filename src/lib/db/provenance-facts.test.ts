import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendGenerationEvent, canonicalHash, canonicalJson, captureRevision, entityKey, initializeProvenanceMeta, projectTrace, sourceCollectCompletionPolicy, type CompletionPolicy } from "./provenance-facts.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { buildGenerationTraceGraph, listGenerationEventRefs, listGenerationTraceTimeline, listGenerationTraceTimelinePage } from "./provenance.js";
import { finishRun, insertRun, insertSource, updateSource } from "./repos.js";
import { sourceConfigRevision } from "./provenance-revisions.js";
import { appendSourceCredit, reconcileLateSourceCredit, SOURCE_CREDIT_TOTAL_MICROS } from "./source-credit-facts.js";

const eventOnlyPolicy = (stages: CompletionPolicy["stages"]): CompletionPolicy => ({ schema_version: 1, stages });
const requiredEvent = (stage = "analyze"): CompletionPolicy["stages"][number] => ({
  stage, execution_kind: "event_only", criticality: "required", allowed_terminal_events: ["completed", "skipped", "failed", "cancelled"], skip_is_success: true,
});

function dbWithTrace(policy = eventOnlyPolicy([requiredEvent()])) {
  const db = openDb(":memory:");
  applyProvenanceMigrations(db);
  db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
    VALUES ('trace_1','topic_pipeline','api','running',?,'complete','{}','{}','2026-08-03T00:00:00.000Z')`).run(JSON.stringify(policy));
  return db;
}

function insertCreditSource(db: ReturnType<typeof dbWithTrace>, id: string, endpoint = `https://${id}.example.test/feed`) {
  const source = {
    id, name: id, type: "rss" as const, endpoint, topic_ids: [], fetch_interval: "1h", backfill: null, enabled: true,
  };
  insertSource(db, source);
  return source;
}

describe("provenance facts", () => {
  it("writes conserved source credits once, observes conflicts, and keeps a late event reconcilable", () => {
    const db = dbWithTrace();
    initializeProvenanceMeta(db, "2026-08-03T00:00:00.000Z");
    ["source_a", "source_b", "source_c"].forEach((id) => insertCreditSource(db, id));
    const input = {
      event_id: "source-credit-1", trace_id: "trace_1", occurred_at: "2026-08-03T00:00:00.000Z", ingested_at: "2026-08-05T00:00:00.000Z",
      // Input order must not affect allocation or the semantic idempotency key.
      sources: [{ source_id: "source_c" }, { source_id: "source_b" }, { source_id: "source_a" }],
    };
    expect(appendSourceCredit(db, input)).toMatchObject({ replayed: false, trace_coverage: "complete", lateness: "reconcilable" });
    expect(appendSourceCredit(db, { ...input, sources: [...input.sources].reverse() })).toMatchObject({ replayed: true });
    expect(db.prepare("SELECT source_id,credit_micros FROM source_credit_fact WHERE tenant_id='default' AND event_id=? ORDER BY source_id").all(input.event_id))
      .toEqual([
        { source_id: "source_a", credit_micros: 333_334 },
        { source_id: "source_b", credit_micros: 333_333 },
        { source_id: "source_c", credit_micros: 333_333 },
      ]);
    expect(db.prepare("SELECT SUM(credit_micros) AS credits FROM source_credit_fact WHERE tenant_id='default' AND event_id=?").get(input.event_id))
      .toEqual({ credits: SOURCE_CREDIT_TOTAL_MICROS });
    const reconciliation = reconcileLateSourceCredit(db, { event_id: input.event_id, action: "reconciled", actor_id: "admin_1", recorded_at: "2026-08-05T01:00:00.000Z" });
    expect(db.prepare("SELECT action FROM source_credit_late_reconciliation WHERE id=?").get(reconciliation.id)).toEqual({ action: "reconciled" });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM source_credit_fact WHERE tenant_id='default' AND source_id='source_a'").all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\\n")).toContain("idx_source_credit_fact_tenant_source_event");
    expect(() => appendSourceCredit(db, { ...input, sources: [{ source_id: "source_a" }] })).toThrow("source_credit_idempotency_conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_credit_conflict WHERE tenant_id='default' AND event_id=?").get(input.event_id)).toEqual({ count: 1 });
    expect(() => db.prepare("DELETE FROM source_credit_fact WHERE tenant_id='default' AND event_id=?").run(input.event_id)).toThrow("append-only");
  });

  it("never upgrades absent, pre-cutover, or partial provenance into complete source-credit coverage", () => {
    const db = dbWithTrace();
    insertCreditSource(db, "source_a");
    // RFC 3339 allows both whole-second and fractional-second forms. This trace predates
    // the cutover even though lexicographic string comparison would say otherwise.
    db.prepare("UPDATE generation_trace SET started_at='2026-08-03T00:00:00Z' WHERE id='trace_1'").run();
    initializeProvenanceMeta(db, "2026-08-03T00:00:00.500Z");
    expect(appendSourceCredit(db, {
      event_id: "source-credit-legacy", trace_id: "trace_1", occurred_at: "2026-08-03T00:00:00.000Z", ingested_at: "2026-08-03T01:00:00.000Z",
      sources: [{ source_id: "source_a" }],
    }).trace_coverage).toBe("legacy");
    db.prepare("UPDATE generation_trace SET started_at='2026-08-05T00:00:00.000Z',coverage='partial' WHERE id='trace_1'").run();
    expect(appendSourceCredit(db, {
      event_id: "source-credit-partial", trace_id: "trace_1", occurred_at: "2026-08-05T00:00:00.000Z", ingested_at: "2026-08-05T01:00:00.000Z",
      sources: [{ source_id: "source_a" }],
    }).trace_coverage).toBe("partial");
    expect(appendSourceCredit(db, {
      event_id: "source-credit-no-trace", trace_id: "unknown_trace", occurred_at: "2026-08-05T00:00:00.000Z", ingested_at: "2026-08-05T01:00:00.000Z",
      sources: [{ source_id: "source_a" }],
    }).trace_coverage).toBe("legacy");

    const nanosecondDb = dbWithTrace();
    insertCreditSource(nanosecondDb, "source_a");
    nanosecondDb.prepare("UPDATE generation_trace SET started_at='2026-08-03T00:00:00.100000000Z' WHERE id='trace_1'").run();
    initializeProvenanceMeta(nanosecondDb, "2026-08-03T00:00:00.100000001Z");
    expect(appendSourceCredit(nanosecondDb, {
      event_id: "source-credit-nanosecond-legacy", trace_id: "trace_1", occurred_at: "2026-08-03T00:00:00.000Z", ingested_at: "2026-08-03T01:00:00.000Z",
      sources: [{ source_id: "source_a" }],
    }).trace_coverage).toBe("legacy");
  });

  it.each([
    ["2026-02-31T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2026-04-30T00:00:00Z", "2026-04-31T00:00:00Z"],
    ["2026-02-29T00:00:00Z", "2026-03-01T00:00:00Z"],
  ])("rejects RFC 3339-shaped but invalid calendar instants: %s / %s", (occurred_at, ingested_at) => {
    const db = dbWithTrace();
    insertCreditSource(db, "source_a");
    expect(() => appendSourceCredit(db, {
      event_id: "source-credit-invalid-calendar", occurred_at, ingested_at, sources: [{ source_id: "source_a" }],
    })).toThrow("source_credit_timestamp_invalid");
  });

  it("accepts a real leap-day instant", () => {
    const db = dbWithTrace();
    insertCreditSource(db, "source_a");
    expect(() => appendSourceCredit(db, {
      event_id: "source-credit-leap-day", occurred_at: "2024-02-29T00:00:00Z", ingested_at: "2024-02-29T00:00:00.000000001Z",
      sources: [{ source_id: "source_a" }],
    })).not.toThrow();
  });

  it("derives immutable credit revisions from persisted Sources and rejects missing sources", () => {
    const db = dbWithTrace();
    const source = insertCreditSource(db, "source_a");
    const firstRevision = sourceConfigRevision(source);
    appendSourceCredit(db, {
      event_id: "source-credit-revision-1", occurred_at: "2026-08-05T00:00:00.000Z", ingested_at: "2026-08-05T01:00:00.000Z",
      sources: [{ source_id: source.id }],
    });
    expect(db.prepare("SELECT source_revision FROM source_credit_fact WHERE event_id='source-credit-revision-1'").get())
      .toEqual({ source_revision: firstRevision });

    const updated = { ...source, endpoint: "https://source_a.example.test/updated" };
    updateSource(db, updated);
    appendSourceCredit(db, {
      event_id: "source-credit-revision-2", occurred_at: "2026-08-05T00:00:00.000Z", ingested_at: "2026-08-05T01:00:00.000Z",
      sources: [{ source_id: source.id }],
    });
    expect(db.prepare("SELECT source_revision FROM source_credit_fact WHERE event_id='source-credit-revision-2'").get())
      .toEqual({ source_revision: sourceConfigRevision(updated) });
    expect(() => appendSourceCredit(db, {
      event_id: "source-credit-missing-source", occurred_at: "2026-08-05T00:00:00.000Z", ingested_at: "2026-08-05T01:00:00.000Z",
      sources: [{ source_id: "missing" }],
    })).toThrow("source_credit_source_not_found");
  });

  it("uses stable canonical vectors including Unicode keys and array order", () => {
    expect(canonicalJson({ z: 1, "😀": null, a: ["b", "a"] })).toBe('{"a":["b","a"],"z":1,"😀":null}');
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
    expect(entityKey({ type: "citation", locator: { kind: "composite", key: { citation_index: 0, insight_id: "i" } } }))
      .toBe(entityKey({ type: "citation", locator: { kind: "composite", key: { insight_id: "i", citation_index: 0 } } }));
  });

  it("appends ordered events, refs and only permits identical semantic replays", () => {
    const db = dbWithTrace();
    const input = { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id" as const, id: "c1" }, revision: "hash1", role: "input" as const },
    ] };
    const first = appendGenerationEvent(db, input);
    const replay = appendGenerationEvent(db, input);
    const terminal = appendGenerationEvent(db, { ...input, event_type: "completed", output_refs: [
      { type: "analysis_batch", locator: { kind: "id" as const, id: "b1" }, revision: "b1", role: "output" as const },
    ] });
    expect(first).toEqual({ id: first.id, sequence: 1, replayed: false });
    expect(replay).toEqual({ id: first.id, sequence: 1, replayed: true });
    expect(terminal.sequence).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM generation_entity_ref").get()).toEqual({ count: 3 });
    expect(() => appendGenerationEvent(db, { ...input, reason_code: "different" })).toThrow("generation_event_idempotency_conflict");
    expect(() => db.prepare("DELETE FROM generation_event WHERE id=?").run(first.id)).toThrow("append-only");
  });

  it("captures immutable revisions and transition metadata", () => {
    const db = dbWithTrace();
    captureRevision(db, { entity_type: "content_item", entity_key: "content_item:v1:x", revision: "hash1", snapshot: { url: "https://x", body_length: 1 } });
    captureRevision(db, { entity_type: "content_item", entity_key: "content_item:v1:x", revision: "hash1", snapshot: { body_length: 1, url: "https://x" } });
    expect(() => captureRevision(db, { entity_type: "content_item", entity_key: "content_item:v1:x", revision: "hash1", snapshot: { url: "https://different" } })).toThrow("provenance_revision_conflict");
    initializeProvenanceMeta(db, "2026-08-03T00:00:00.000Z");
    initializeProvenanceMeta(db, "2027-01-01T00:00:00.000Z");
    expect(db.prepare("SELECT meta_value FROM provenance_meta WHERE meta_key='provenance_started_at'").get()).toEqual({ meta_value: "2026-08-03T00:00:00.000Z" });
  });

  it.each([
    ["required stage still active", eventOnlyPolicy([requiredEvent()]), [{ stage: "analyze", event_type: "started" }], "running"],
    ["required completed", eventOnlyPolicy([requiredEvent()]), [{ stage: "analyze", event_type: "completed" }], "done"],
    ["allowed skip", eventOnlyPolicy([requiredEvent()]), [{ stage: "analyze", event_type: "skipped" }], "done"],
    ["required failed", eventOnlyPolicy([requiredEvent()]), [{ stage: "analyze", event_type: "failed" }], "failed"],
    ["required cancelled", eventOnlyPolicy([requiredEvent()]), [{ stage: "analyze", event_type: "failed", error: { reason_code: "cancelled" } }], "cancelled"],
    ["non-blocking failure after required completion", eventOnlyPolicy([
      requiredEvent(), { stage: "derive_opportunity", execution_kind: "event_only", criticality: "non_blocking", allowed_terminal_events: ["completed", "failed"], skip_is_success: false },
    ]), [{ stage: "analyze", event_type: "completed" }, { stage: "derive_opportunity", event_type: "failed" }], "partial"],
  ])("projects truth-table row: %s", (_label, policy, events, expected) => {
    const db = dbWithTrace(policy);
    for (const event of events) appendGenerationEvent(db, { trace_id: "trace_1", ...event });
    expect(projectTrace(db, "trace_1")).toBe(expected);
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: expected });
  });

  it("requires both the linked Run aggregation and terminal event for a run stage", () => {
    const db = dbWithTrace(eventOnlyPolicy([{
      stage: "analyze", execution_kind: "run", criticality: "required", allowed_terminal_events: ["completed", "failed", "cancelled"], skip_is_success: false,
    }]));
    insertRun(db, {
      id: "run_1", kind: "analyze", target: { topic_id: "topic_a" }, status: "running", started_at: "2026-08-03T00:00:00.000Z",
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: "trace_1",
    });
    appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "completed" });
    expect(projectTrace(db, "trace_1")).toBe("running");
    finishRun(db, "run_1", { status: "done", duration_ms: 1 });
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: "done" });
  });

  it("uses the newest Run/event attempt, keeping a retry in progress running before its success", () => {
    const db = dbWithTrace(eventOnlyPolicy([{
      stage: "analyze", execution_kind: "run", criticality: "required", allowed_terminal_events: ["completed", "failed", "cancelled"], skip_is_success: false,
    }]));
    const run = (id: string, status: "running" | "failed", retryOf: string | null) => insertRun(db, {
      id, kind: "analyze", target: { topic_id: "topic_a" }, status, started_at: `2026-08-03T00:00:0${id.at(-1)}.000Z`,
      ended_at: status === "failed" ? "2026-08-03T00:00:01.000Z" : null, duration_ms: status === "failed" ? 1 : null,
      cost: null, error: status === "failed" ? { type: "Retryable", message: "retry me" } : null, retry_of: retryOf, trace_id: "trace_1",
    });
    run("run_1", "failed", null);
    appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_1", stage: "analyze", attempt: 1, event_type: "started" });
    appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_1", stage: "analyze", attempt: 1, event_type: "failed" });
    expect(projectTrace(db, "trace_1")).toBe("failed");

    run("run_2", "running", "run_1");
    appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_2", stage: "analyze", attempt: 2, event_type: "started" });
    expect(projectTrace(db, "trace_1")).toBe("running");

    appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_2", stage: "analyze", attempt: 2, event_type: "completed" });
    finishRun(db, "run_2", { status: "done", duration_ms: 1 });
    expect(projectTrace(db, "trace_1")).toBe("done");
  });

  it("keeps every stage linked to a shared source-collect ingest Run", () => {
    const db = dbWithTrace(sourceCollectCompletionPolicy());
    insertRun(db, {
      id: "run_ingest", kind: "ingest", target: { source_id: "source_a" }, status: "running", started_at: "2026-08-03T00:00:00.000Z",
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: "trace_1",
    });
    for (const stage of ["collect", "normalize"]) {
      appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_ingest", stage, event_type: "started" });
      appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_ingest", stage, event_type: "completed" });
    }
    finishRun(db, "run_ingest", { status: "done", duration_ms: 1 });
    expect(projectTrace(db, "trace_1")).toBe("done");
  });

  it("reads non-empty P0a completion-policy snapshots when finishing a linked Run", () => {
    const db = dbWithTrace();
    db.prepare("UPDATE generation_trace SET completion_policy=? WHERE id='trace_1'")
      .run(JSON.stringify({ schema_version: 1, planning: true }));
    insertRun(db, {
      id: "run_1", kind: "analyze", target: { topic_id: "topic_a" }, status: "running", started_at: "2026-08-03T00:00:00.000Z",
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: "trace_1",
    });
    appendGenerationEvent(db, { trace_id: "trace_1", run_id: "run_1", stage: "analyze", event_type: "completed" });
    expect(() => finishRun(db, "run_1", { status: "done", duration_ms: 1 })).not.toThrow();
    expect(db.prepare("SELECT status FROM run WHERE id='run_1'").get()).toEqual({ status: "done" });
  });

  it("reads scheduled-topic, source-collect and manual-decision P0a policy snapshots", () => {
    const scheduled = dbWithTrace();
    scheduled.prepare("UPDATE generation_trace SET completion_policy=? WHERE id='trace_1'")
      .run(JSON.stringify({ schema_version: 1, planning: true, report_type: "brief" }));
    expect(() => projectTrace(scheduled, "trace_1")).not.toThrow();

    const sourceCollect = dbWithTrace();
    sourceCollect.prepare("UPDATE generation_trace SET scope_kind='source_collect',completion_policy=? WHERE id='trace_1'")
      .run(JSON.stringify({ schema_version: 1, execution_kind: "sync", required_stages: ["collect", "normalize"] }));
    expect(() => projectTrace(sourceCollect, "trace_1")).not.toThrow();

    const manual = dbWithTrace();
    manual.prepare("UPDATE generation_trace SET scope_kind='manual_decision',completion_policy=? WHERE id='trace_1'")
      .run(JSON.stringify({ schema_version: 1, execution_kind: "event_only", required_stages: ["direction_change"] }));
    appendGenerationEvent(manual, { trace_id: "trace_1", stage: "direction_change", event_type: "config_changed" });
    expect(projectTrace(manual, "trace_1")).toBe("done");
  });

  it("rolls back the Run terminal write when trace projection fails", () => {
    const db = dbWithTrace();
    db.prepare("UPDATE generation_trace SET completion_policy=? WHERE id='trace_1'").run(JSON.stringify({ schema_version: 99 }));
    insertRun(db, {
      id: "run_1", kind: "analyze", target: { topic_id: "topic_a" }, status: "running", started_at: "2026-08-03T00:00:00.000Z",
      ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: "trace_1",
    });
    expect(() => finishRun(db, "run_1", { status: "done", duration_ms: 1 })).toThrow("invalid_completion_policy");
    expect(db.prepare("SELECT status,ended_at FROM run WHERE id='run_1'").get()).toEqual({ status: "running", ended_at: null });
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: "running" });
  });

  it("allows only attempted or skipped delivery events", () => {
    const policy = eventOnlyPolicy([
      { ...requiredEvent("analyze"), allowed_terminal_events: ["completed"] },
      { stage: "deliver", execution_kind: "event_only", criticality: "non_blocking", allowed_terminal_events: ["completed", "skipped"], skip_is_success: true },
    ]);
    const attempted = dbWithTrace(policy);
    appendGenerationEvent(attempted, { trace_id: "trace_1", stage: "analyze", event_type: "completed" });
    appendGenerationEvent(attempted, { trace_id: "trace_1", stage: "deliver", event_type: "attempted" });
    expect(projectTrace(attempted, "trace_1")).toBe("done");

    const invalid = dbWithTrace(policy);
    appendGenerationEvent(invalid, { trace_id: "trace_1", stage: "analyze", event_type: "completed" });
    appendGenerationEvent(invalid, { trace_id: "trace_1", stage: "deliver", event_type: "completed" });
    expect(projectTrace(invalid, "trace_1")).toBe("partial");
  });

  it("管理员时间线只投影登记的非负整数指标", () => {
    const db = dbWithTrace();
    appendGenerationEvent(db, {
      trace_id: "trace_1", stage: "generate_report", event_type: "completed",
      metrics: { published_insight_count: 2, citation_pass: 3, supplemental_candidate_count: 4, supplemental_published_insight_count: 2 },
    });
    expect(listGenerationTraceTimeline(db, "trace_1")[0]).toMatchObject({
      stage: "generate_report", metrics: { published_insight_count: 2, citation_pass: 3, supplemental_candidate_count: 4, supplemental_published_insight_count: 2 },
    });
  });

  it("在写入前拒绝敏感或未登记的 metrics/version_context，且保留安全事件的重放语义", () => {
    const db = dbWithTrace();
    const safe = {
      trace_id: "trace_1", stage: "analyze", event_type: "started",
      metrics: { input_content_count: 2 },
      version_context: {
        source_config_revision: `source-v1:${"a".repeat(64)}`,
        collection_mode: "feed",
      },
    };
    const first = appendGenerationEvent(db, safe);
    expect(appendGenerationEvent(db, safe)).toEqual({ ...first, replayed: true });
    expect(db.prepare("SELECT metrics,version_context FROM generation_event WHERE id=?").get(first.id)).toEqual({
      metrics: '{"input_content_count":2}',
      version_context: `{"collection_mode":"feed","source_config_revision":"source-v1:${"a".repeat(64)}"}`,
    });

    for (const field of ["prompt", "raw_content", "secret"]) {
      expect(() => appendGenerationEvent(db, {
        trace_id: "trace_1", stage: "validate", event_type: "started", metrics: { [field]: 1 },
      })).toThrow("generation_event_metric_not_allowed");
      expect(() => appendGenerationEvent(db, {
        trace_id: "trace_1", stage: "validate", event_type: "started", version_context: { [field]: "do not persist" },
      })).toThrow("generation_event_version_context_not_allowed");
    }
    expect(() => appendGenerationEvent(db, {
      trace_id: "trace_1", stage: "validate", event_type: "started", metrics: { citation_total: -1 },
    })).toThrow("generation_event_metric_invalid");
    expect(() => appendGenerationEvent(db, {
      trace_id: "trace_1", stage: "validate", event_type: "started", version_context: { source_config_revision: "raw-secret" },
    })).toThrow("generation_event_version_context_not_allowed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM generation_event").get()).toEqual({ count: 1 });
  });

  it("分页 timeline 聚合 ref_count，且按 event 分页 refs", () => {
    const db = dbWithTrace();
    for (let i = 1; i <= 3; i += 1) {
      appendGenerationEvent(db, {
        trace_id: "trace_1", stage: ["analyze", "validate", "generate_report"][i - 1], event_type: "started",
        input_refs: [{ type: "content_item", locator: { kind: "id", id: `content_${i}` }, revision: "v1", role: "input" }],
      });
    }
    const first = listGenerationTraceTimelinePage(db, "trace_1", { limit: 2 });
    expect(first.items.map((event) => [event.sequence, event.ref_count])).toEqual([[1, 1], [2, 1]]);
    expect(first).toMatchObject({ truncated: true, nextCursor: "2" });
    const second = listGenerationTraceTimelinePage(db, "trace_1", { afterSequence: 2, limit: 2 });
    expect(second.items.map((event) => event.sequence)).toEqual([3]);
    expect(second.truncated).toBe(false);
    const refs = listGenerationEventRefs(db, "trace_1", 1, { limit: 1 });
    expect(refs?.items[0]).toMatchObject({ type: "content_item", revision: "v1", role: "input", visibility_class: "admin_only" });
    expect(refs?.items[0].entity_key).toMatch(/^content_item:v1:/);
    expect(refs?.truncated).toBe(false);
    expect(listGenerationEventRefs(db, "trace_1", 99)).toBeNull();
  });

  it("受限 timeline/ref 查询使用索引且不建立临时排序", () => {
    const db = dbWithTrace();
    const event = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "content" }, revision: "v1", role: "input" },
    ] });
    const timelinePlan = db.prepare(`EXPLAIN QUERY PLAN SELECT e.id,e.sequence,
      (SELECT COUNT(*) FROM generation_entity_ref r WHERE r.event_id=e.id) AS ref_count
      FROM generation_event e WHERE e.trace_id='trace_1' AND e.sequence>0 ORDER BY e.sequence LIMIT 101`).all() as { detail: string }[];
    const refsPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM generation_entity_ref
      WHERE trace_id='trace_1' AND event_id=? AND rowid>0 ORDER BY rowid LIMIT 101`).all(event.id) as { detail: string }[];
    const detail = [...timelinePlan, ...refsPlan].map((row) => row.detail).join("\n");
    expect(detail).toContain("idx_generation_event_trace_sequence");
    expect(detail).toContain("idx_generation_entity_ref_trace_event");
    expect(detail).not.toContain("USE TEMP B-TREE");
  });

  it("ref 投影图的 event 入口保持 rowid 顺序而不建立临时排序", () => {
    const db = dbWithTrace();
    const event = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "content" }, revision: "v1", role: "input" },
    ] });
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT r.rowid,r.event_id,event.sequence
      FROM generation_entity_ref r INDEXED BY idx_generation_entity_ref_trace_event CROSS JOIN generation_event event ON event.id=r.event_id
      WHERE r.trace_id='trace_1' AND r.event_id=? ORDER BY r.rowid LIMIT 501`).all(event.id) as { detail: string }[];
    const detail = plan.map((row) => row.detail).join("\n");
    expect(detail).toContain("idx_generation_entity_ref_trace_event");
    expect(detail).not.toContain("USE TEMP B-TREE");
  });

  it("限制单 trace 图遍历的深度和元素数，并安全处理环", () => {
    const db = dbWithTrace();
    const first = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started" });
    const second = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started" });
    const third = appendGenerationEvent(db, { trace_id: "trace_1", stage: "generate_report", event_type: "started" });
    const edge = (eventId: string, from: string, to: string) => db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`).run(eventId, from, to);
    edge(first.id, "a", "b"); edge(second.id, "b", "c"); edge(third.id, "c", "a");
    const shallow = buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 1, maxElements: 20 });
    expect(shallow?.edges).toHaveLength(1);
    expect(shallow).toMatchObject({ truncated: true, truncation_reason: "depth_budget" });
    const cyclic = buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 4, maxElements: 20 });
    expect(cyclic?.nodes.filter((node) => node.type !== "event")).toHaveLength(3);
    expect(cyclic?.edges).toHaveLength(3);
    const capped = buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 4, maxElements: 3 });
    expect(capped).toMatchObject({ truncated: true, truncation_reason: "element_budget" });
  });

  it("图遍历的种子查询命中 P0c trace/from 索引", () => {
    const db = dbWithTrace();
    const event = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started" });
    db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity','a','v1','entity','b','v1','derived_from','admin_only')`).run(event.id);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM generation_edge
      WHERE trace_id='trace_1' AND from_type='entity' AND from_key='a' AND from_revision='v1'`).all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_generation_edge_trace_from");
    expect(plan.map((row) => row.detail).join("\n")).not.toContain("USE TEMP B-TREE");
  });

  it("同一层的多个新节点都会进入下一层遍历", () => {
    const db = dbWithTrace();
    const one = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started" });
    const two = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started" });
    const three = appendGenerationEvent(db, { trace_id: "trace_1", stage: "generate_report", event_type: "started" });
    const four = appendGenerationEvent(db, { trace_id: "trace_1", stage: "derive_lead", event_type: "started" });
    const edge = (eventId: string, from: string, to: string) => db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`).run(eventId, from, to);
    edge(one.id, "a", "b"); edge(two.id, "b", "c"); edge(three.id, "b", "e"); edge(four.id, "c", "d");
    const graph = buildGenerationTraceGraph(db, "trace_1", { rootSequence: one.sequence, depth: 3, maxElements: 30 });
    expect(graph?.nodes.filter((node) => node.type !== "event").map((node) => node.entity_key).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("在尚未写 generation_edge 的生产路径中，从 entity refs 投影受限图", () => {
    const db = dbWithTrace();
    const first = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "shared" }, revision: "v1", role: "input" },
    ] });
    const second = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "shared" }, revision: "v1", role: "input" },
    ] });
    const graph = buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 3, maxElements: 20 });
    expect(graph?.edges).toHaveLength(2);
    expect(graph?.nodes.some((node) => node.type === "event" && node.entity_key === second.id)).toBe(true);
  });

  it("合并渐进写入的 refs 和 generation_edge，不因根事件无 edge 而漏掉后续关系", () => {
    const db = dbWithTrace();
    const first = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "shared" }, revision: "v1", role: "input" },
    ] });
    const second = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started", input_refs: [
      { type: "content_item", locator: { kind: "id", id: "shared" }, revision: "v1", role: "input" },
    ] });
    db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity','a','v1','entity','b','v1','derived_from','admin_only')`).run(second.id);
    const graph = buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 3, maxElements: 30 });
    expect(graph?.edges.some((edge) => edge.relation === "derived_from")).toBe(true);
    expect(graph?.nodes.map((node) => node.entity_key)).toEqual(expect.arrayContaining(["a", "b", second.id]));
  });

  it("图元素预算不足时不会误报为深度截断", () => {
    const db = dbWithTrace();
    const first = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started" });
    const second = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started" });
    const edge = (eventId: string, from: string, to: string) => db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`).run(eventId, from, to);
    edge(first.id, "a", "b"); edge(second.id, "b", "c");
    expect(buildGenerationTraceGraph(db, "trace_1", { rootSequence: first.sequence, depth: 2, maxElements: 4 }))
      .toMatchObject({ truncated: true, truncation_reason: "element_budget" });
  });

  it("宽 frontier 的单节点 fanout 溢出会明确标记元素截断", () => {
    const db = dbWithTrace();
    const root = appendGenerationEvent(db, { trace_id: "trace_1", stage: "analyze", event_type: "started" });
    const add = (eventId: string, from: string, to: string) => db.prepare(`INSERT INTO generation_edge
      (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
      VALUES ('trace_1',?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`).run(eventId, from, to);
    add(root.id, "a", "b");
    for (let index = 0; index < 8; index += 1) {
      const event = appendGenerationEvent(db, { trace_id: "trace_1", stage: "validate", event_type: "started" });
      add(event.id, "b", `child_${index}`);
    }
    expect(buildGenerationTraceGraph(db, "trace_1", { rootSequence: root.sequence, depth: 2, maxElements: 20 }))
      .toMatchObject({ truncated: true, truncation_reason: "element_budget" });
  });
});

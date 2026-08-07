import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendGenerationEvent, canonicalHash, canonicalJson, captureRevision, entityKey, initializeProvenanceMeta, projectTrace } from "./provenance-facts.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { listGenerationTraceTimeline } from "./provenance.js";

function dbWithTrace() {
  const db = openDb(":memory:");
  applyProvenanceMigrations(db);
  db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
    VALUES ('trace_1','topic_pipeline','api','running','{}','complete','{}','{}','2026-08-03T00:00:00.000Z')`).run();
  return db;
}

describe("provenance facts", () => {
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

  it("projects non-blocking planning failure to partial after required stages complete", () => {
    const db = dbWithTrace();
    for (const stage of ["analyze", "validate", "generate_report"]) appendGenerationEvent(db, { trace_id: "trace_1", stage, event_type: "completed" });
    appendGenerationEvent(db, { trace_id: "trace_1", stage: "derive_opportunity", event_type: "failed", error: { reason_code: "failed" } });
    expect(projectTrace(db, "trace_1")).toBe("partial");
    expect(db.prepare("SELECT status FROM generation_trace WHERE id='trace_1'").get()).toEqual({ status: "partial" });
  });

  it("管理员时间线只投影登记的非负整数指标，不泄露任意 metrics 字段", () => {
    const db = dbWithTrace();
    appendGenerationEvent(db, {
      trace_id: "trace_1", stage: "generate_report", event_type: "completed",
      metrics: { published_insight_count: 2, citation_pass: 3, prompt: "secret", negative: -1, enabled: true },
    });
    expect(listGenerationTraceTimeline(db, "trace_1")[0]).toMatchObject({
      stage: "generate_report", metrics: { published_insight_count: 2, citation_pass: 3 },
    });
    expect(listGenerationTraceTimeline(db, "trace_1")[0].metrics).not.toHaveProperty("prompt");
  });
});

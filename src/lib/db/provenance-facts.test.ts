import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendGenerationEvent, canonicalHash, canonicalJson, captureRevision, entityKey, initializeProvenanceMeta, projectTrace } from "./provenance-facts.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { buildGenerationTraceGraph, listGenerationEventRefs, listGenerationTraceTimeline, listGenerationTraceTimelinePage } from "./provenance.js";

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
      metrics: { published_insight_count: 2, citation_pass: 3, supplemental_candidate_count: 4, supplemental_published_insight_count: 2, prompt: "secret", negative: -1, enabled: true },
    });
    expect(listGenerationTraceTimeline(db, "trace_1")[0]).toMatchObject({
      stage: "generate_report", metrics: { published_insight_count: 2, citation_pass: 3, supplemental_candidate_count: 4, supplemental_published_insight_count: 2 },
    });
    expect(listGenerationTraceTimeline(db, "trace_1")[0].metrics).not.toHaveProperty("prompt");
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

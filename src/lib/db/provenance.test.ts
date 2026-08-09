import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertTopic } from "./repos.js";
import {
  claimNextGenerationDispatch,
  createDeepDiveTraceRequest,
  createScheduledTraceRequest,
  getGenerationTraceStatus,
  hashIdempotencyKey,
  retryFailedTraceRequest,
} from "./provenance.js";

describe("generation provenance dispatch", () => {
  let db: DB;
  const now = new Date("2026-08-03T00:00:00.000Z");

  beforeEach(() => {
    db = openDb(":memory:");
    applyProvenanceMigrations(db);
    insertTopic(db, {
      id: "topic_a", name: "Topic A", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
      archetype: "deep_vertical", facets: [],
    });
  });

  it("atomically accepts then replays the same Idempotency-Key", () => {
    const hash = hashIdempotencyKey("abcdefgh", "test-secret");
    const first = createDeepDiveTraceRequest(db, { topicId: "topic_a", idempotencyKeyHash: hash, planning: true, now });
    if (first.kind !== "accepted") throw new Error("expected accepted request");
    const replay = createDeepDiveTraceRequest(db, { topicId: "topic_a", idempotencyKeyHash: hash, planning: true, now });
    expect(first.kind).toBe("accepted");
    expect(replay).toEqual({ kind: "replayed", traceId: first.traceId, requestId: first.requestId });
    expect(db.prepare("SELECT COUNT(*) AS count FROM generation_dispatch").get()).toEqual({ count: 1 });
  });

  it("keeps an accepted reservation active until the dispatch is terminal", () => {
    const first = createDeepDiveTraceRequest(db, {
      topicId: "topic_a", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "secret-a"), planning: true, now,
    });
    if (first.kind !== "accepted") throw new Error("expected accepted request");
    const conflict = createDeepDiveTraceRequest(db, {
      topicId: "topic_a", idempotencyKeyHash: hashIdempotencyKey("ijklmnop", "secret-a"), planning: true, now,
    });
    expect(first.kind).toBe("accepted");
    expect(conflict).toEqual({ kind: "conflict", activeTraceId: first.traceId });
  });

  it("claims once and safely takes over an expired claim", () => {
    const accepted = createDeepDiveTraceRequest(db, {
      topicId: "topic_a", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "secret-a"), planning: false, now,
    });
    if (accepted.kind !== "accepted") throw new Error("expected accepted request");
    const first = claimNextGenerationDispatch(db, now);
    expect(first?.traceId).toBe(accepted.traceId);
    expect(first?.claimEpoch).toBe(1);
    expect(first?.rootRunId).toMatch(/^run_/);
    expect(getGenerationTraceStatus(db, accepted.traceId)?.root_run_id).toBe(first?.rootRunId);
    expect(claimNextGenerationDispatch(db, new Date(now.getTime() + 1_000))).toBeNull();

    db.prepare("UPDATE generation_dispatch SET lease_expires_at=? WHERE id=?").run("2026-08-02T23:00:00.000Z", first!.dispatchId);
    db.prepare("UPDATE generation_lease SET expires_at=? WHERE trace_id=?").run("2026-08-02T23:00:00.000Z", accepted.traceId);
    const takeover = claimNextGenerationDispatch(db, new Date("2026-08-03T01:00:00.000Z"));
    expect(takeover?.claimEpoch).toBe(2);
    expect(takeover?.fencingEpoch).toBe(2);
    expect(takeover?.ownerToken).not.toBe(first?.ownerToken);
    expect(takeover?.rootRunId).toBe(first?.rootRunId);
    expect(getGenerationTraceStatus(db, accepted.traceId)?.dispatch_state).toBe("claimed");
  });

  it("deduplicates a cron Brief by topic and UTC period, with a reconstructable worker payload", () => {
    db.prepare("INSERT INTO deployment_record(id,image_digest,git_sha,deployed_at,actor) VALUES (?,?,?,?,?)")
      .run("deploy_1", `sha256:${"a".repeat(64)}`, "b".repeat(40), "2026-08-02T00:00:00.000Z", "test");
    const first = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
    });
    const replay = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
    });
    if (first.kind !== "accepted") throw new Error("expected accepted request");
    expect(replay).toEqual({ kind: "replayed", traceId: first.traceId, requestId: first.requestId });
    expect(db.prepare("SELECT payload FROM generation_dispatch WHERE trace_id=?").get(first.traceId)).toEqual({
      payload: JSON.stringify({ topic_id: "topic_a", planning: true, report_type: "brief", window_hours: 168, window_end: now.toISOString(), items: 15, schema_version: 1 }),
    });
    expect(getGenerationTraceStatus(db, first.traceId)).toMatchObject({
      deployment_image_digest: `sha256:${"a".repeat(64)}`, deployment_git_sha: "b".repeat(40),
      runtime_version: JSON.stringify({ schema_version: 1, image_digest: `sha256:${"a".repeat(64)}`, git_sha: "b".repeat(40) }),
    });
  });

  it("creates an auditable full retry for a terminal failed scheduled trace", () => {
    const original = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
    });
    if (original.kind !== "accepted") throw new Error("expected accepted request");
    db.prepare("UPDATE generation_trace SET status='failed',ended_at=? WHERE id=?").run(now.toISOString(), original.traceId);
    db.prepare("UPDATE generation_trace_request SET state='terminal' WHERE trace_id=?").run(original.traceId);
    db.prepare("UPDATE generation_dispatch SET state='failed' WHERE trace_id=?").run(original.traceId);
    db.prepare("UPDATE generation_lease SET state='released',released_at=? WHERE trace_id=?").run(now.toISOString(), original.traceId);
    // 兼容上线前未冻结 window_end 的生产 dispatch：从原 trace 受理时间重建窗口右边界。
    db.prepare("UPDATE generation_dispatch SET payload=? WHERE trace_id=?").run(
      JSON.stringify({ topic_id: "topic_a", planning: true, report_type: "brief", window_hours: 168, items: 15, schema_version: 1 }),
      original.traceId,
    );

    const hash = hashIdempotencyKey("retry-key", "secret-a");
    const retried = retryFailedTraceRequest(db, { traceId: original.traceId, idempotencyKeyHash: hash, now });
    if (retried.kind !== "accepted") throw new Error(`expected accepted retry, got ${retried.kind}`);
    const replay = retryFailedTraceRequest(db, { traceId: original.traceId, idempotencyKeyHash: hash, now });

    expect(replay).toEqual({ kind: "replayed", traceId: retried.traceId, requestId: retried.requestId });
    expect(db.prepare("SELECT status,retry_of_trace_id,trigger_kind FROM generation_trace WHERE id=?").get(retried.traceId)).toEqual({
      status: "running", retry_of_trace_id: original.traceId, trigger_kind: "retry",
    });
    expect(db.prepare("SELECT scope_key,state FROM generation_trace_request WHERE trace_id=?").get(retried.traceId)).toEqual({
      scope_key: `retry:${original.traceId}:${hash}:1`, state: "accepted",
    });
    const dispatch = db.prepare("SELECT payload,state FROM generation_dispatch WHERE trace_id=?").get(retried.traceId) as { payload: string; state: string };
    expect({ ...dispatch, payload: JSON.parse(dispatch.payload) }).toEqual({
      payload: { topic_id: "topic_a", planning: true, report_type: "brief", window_hours: 168, window_end: now.toISOString(), items: 15, schema_version: 1 },
      state: "queued",
    });
    expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(original.traceId)).toEqual({ status: "failed" });
  });
});

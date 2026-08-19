import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertSource, insertTopic } from "./repos.js";
import {
  claimNextGenerationDispatch,
  claimSourceCollectTrace,
  createScheduledSourceCollectTrace,
  createDeepDiveTraceRequest,
  createScheduledTraceRequest,
  finishGenerationDispatch,
  getGenerationTraceStatus,
  hashIdempotencyKey,
  recordManualDecision,
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
    insertSource(db, {
      id: "source_a", name: "Source A", type: "rss", endpoint: "https://example.test/feed",
      topic_ids: ["topic_a"], fetch_interval: "1h", backfill: null, enabled: true,
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
    const policy = JSON.parse((db.prepare("SELECT completion_policy FROM generation_trace WHERE id=?").get(first.traceId) as { completion_policy: string }).completion_policy);
    expect(policy).toMatchObject({ schema_version: 1 });
    expect(policy.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "analyze", execution_kind: "run", criticality: "required", allowed_terminal_events: ["completed", "failed", "cancelled"], skip_is_success: false }),
      expect.objectContaining({ stage: "derive_lead", execution_kind: "event_only", criticality: "non_blocking" }),
      expect.objectContaining({ stage: "deliver", execution_kind: "event_only", criticality: "non_blocking" }),
    ]));
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

  it("records an admin-triggered brief atomically with its audit and planned event", () => {
    const accepted = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
      triggerKind: "api", actorId: "admin_1", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "test-secret"),
    });
    if (accepted.kind !== "accepted") throw new Error("expected accepted request");
    expect(db.prepare("SELECT trigger_kind FROM generation_trace WHERE id=?").get(accepted.traceId)).toEqual({ trigger_kind: "api" });
    expect(db.prepare("SELECT idempotency_key_hash FROM generation_trace_request WHERE id=?").get(accepted.requestId))
      .toEqual({ idempotency_key_hash: hashIdempotencyKey("abcdefgh", "test-secret") });
    expect(db.prepare("SELECT actor,action,target FROM audit_log").all())
      .toEqual([{ actor: "admin_1", action: "topic_brief_trigger", target: "topic_a" }]);
    expect(db.prepare("SELECT stage,event_type,actor_type,actor_id,audit_log_id,reason_code FROM generation_event WHERE trace_id=?").all(accepted.traceId))
      .toEqual([{ stage: "select", event_type: "planned", actor_type: "user", actor_id: "admin_1", audit_log_id: 1, reason_code: "admin_topic_brief_trigger" }]);
  });

  it("does not accept an API scheduled request without an attributed actor and key hash", () => {
    expect(() => createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
      triggerKind: "api",
    })).toThrow("manual_scheduled_request_missing_actor_or_idempotency_key");
    expect(db.prepare("SELECT COUNT(*) AS count FROM generation_trace").get()).toEqual({ count: 0 });
  });

  it("deduplicates scheduled source collection by UTC hour and grants exactly one owned lease", () => {
    const first = createScheduledSourceCollectTrace(db, { sourceId: "source_a", now });
    const replay = createScheduledSourceCollectTrace(db, { sourceId: "source_a", now: new Date("2026-08-03T00:59:59.000Z") });
    if (first.kind !== "accepted") throw new Error("expected accepted source trace");
    expect(replay).toEqual({ kind: "replayed", traceId: first.traceId });
    expect(db.prepare("SELECT scope_key FROM generation_trace_request WHERE trace_id=?").get(first.traceId)).toEqual({
      scope_key: "source_collect:source_a:2026-08-03T00",
    });
    expect(JSON.parse((db.prepare("SELECT completion_policy FROM generation_trace WHERE id=?").get(first.traceId) as { completion_policy: string }).completion_policy).stages)
      .toEqual(expect.arrayContaining([expect.objectContaining({ stage: "collect", execution_kind: "run", criticality: "required" }), expect.objectContaining({ stage: "normalize", execution_kind: "run", criticality: "required" })]));
    expect(claimSourceCollectTrace(db, first.traceId, now)).toMatchObject({ traceId: first.traceId, fencingEpoch: 1 });
    expect(claimSourceCollectTrace(db, first.traceId, now)).toBeNull();
  });

  it("atomically records an idempotent manual decision with its audit, revision, and terminal trace", () => {
    const before = { type: "topic_direction", locator: { kind: "id" as const, id: "direction_a" }, revision: "direction-v1:before", role: "input" as const };
    const output = { ...before, revision: "direction-v1:after", role: "output" as const };
    let writes = 0;
    const input = {
      entity: { type: before.type, locator: before.locator }, previous: before, topicId: "topic_a",
      stage: "direction_change" as const, terminalEvent: "config_changed" as const, action: "topic_direction_update",
      actorId: "user_1", detail: { from_version: 1, to_version: 2 }, idempotencyKeyHash: hashIdempotencyKey("manual-key", "secret"), now,
      mutate: () => { writes += 1; return true; },
      snapshot: () => ({ id: "direction_a", version: 2 }), output: () => output,
    };
    const first = recordManualDecision(db, input);
    if (first.kind !== "accepted") throw new Error("expected accepted manual decision");
    const replay = recordManualDecision(db, input);
    expect(replay).toEqual({ kind: "replayed", traceId: first.traceId, requestId: first.requestId });
    expect(writes).toBe(1);
    expect(getGenerationTraceStatus(db, first.traceId)).toMatchObject({ status: "done", topic_id: "topic_a", scope_kind: "manual_decision" });
    expect(JSON.parse((db.prepare("SELECT completion_policy FROM generation_trace WHERE id=?").get(first.traceId) as { completion_policy: string }).completion_policy).stages)
      .toEqual([expect.objectContaining({ stage: "direction_change", execution_kind: "event_only", criticality: "required", allowed_terminal_events: ["completed", "failed", "cancelled"] })]);
    expect(db.prepare("SELECT state FROM generation_trace_request WHERE trace_id=?").get(first.traceId)).toEqual({ state: "terminal" });
    expect(db.prepare("SELECT state FROM generation_lease WHERE trace_id=?").get(first.traceId)).toEqual({ state: "released" });
    expect(db.prepare("SELECT stage,event_type,actor_id,audit_log_id FROM generation_event WHERE trace_id=? ORDER BY sequence").all(first.traceId)).toEqual([
      { stage: "direction_change", event_type: "started", actor_id: "user_1", audit_log_id: null },
      { stage: "direction_change", event_type: "config_changed", actor_id: "user_1", audit_log_id: 1 },
    ]);
    expect(db.prepare("SELECT actor,action FROM audit_log").all()).toEqual([{ actor: "user_1", action: "topic_direction_update" }]);
    expect(db.prepare("SELECT entity_type,revision FROM provenance_revision WHERE entity_type='topic_direction'").all()).toEqual([{ entity_type: "topic_direction", revision: "direction-v1:after" }]);
  });

  it("expires an unclaimed synchronous source lease instead of permanently blocking the next hour", () => {
    const first = createScheduledSourceCollectTrace(db, { sourceId: "source_a", now });
    if (first.kind !== "accepted") throw new Error("expected accepted source trace");
    const next = createScheduledSourceCollectTrace(db, {
      sourceId: "source_a", now: new Date("2026-08-03T01:00:00.000Z"),
    });
    expect(next.kind).toBe("accepted");
    expect(getGenerationTraceStatus(db, first.traceId)).toMatchObject({ status: "failed" });
    expect(db.prepare("SELECT state FROM generation_lease WHERE trace_id=?").get(first.traceId)).toEqual({ state: "released" });
  });

  it("creates an auditable full retry for a terminal failed scheduled trace", () => {
    const original = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15, now,
    });
    if (original.kind !== "accepted") throw new Error("expected accepted request");
    const claim = claimNextGenerationDispatch(db, now);
    if (!claim) throw new Error("expected dispatch claim");
    expect(finishGenerationDispatch(db, claim, {
      status: "failed", error: { reason_code: "dispatch_failed", message: "synthetic failure" },
    }, now)).toBe(true);
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

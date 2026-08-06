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
      payload: JSON.stringify({ topic_id: "topic_a", planning: true, report_type: "brief", window_hours: 168, items: 15, schema_version: 1 }),
    });
    expect(getGenerationTraceStatus(db, first.traceId)).toMatchObject({
      deployment_image_digest: `sha256:${"a".repeat(64)}`, deployment_git_sha: "b".repeat(40),
      runtime_version: JSON.stringify({ schema_version: 1, image_digest: `sha256:${"a".repeat(64)}`, git_sha: "b".repeat(40) }),
    });
  });
});

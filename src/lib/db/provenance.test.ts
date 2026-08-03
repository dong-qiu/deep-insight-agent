import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertTopic } from "./repos.js";
import {
  claimNextGenerationDispatch,
  createDeepDiveTraceRequest,
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
});

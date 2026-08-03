import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { assertGenerationDispatchClaim, claimNextGenerationDispatch, createDeepDiveTraceRequest, hashIdempotencyKey } from "../db/provenance.js";
import { insertTopic } from "../db/repos.js";
import type { Report } from "../types.js";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";

describe("generation dispatch worker", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    applyProvenanceMigrations(db);
    insertTopic(db, {
      id: "topic_a", name: "Topic A", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
      archetype: "deep_vertical", facets: [],
    });
  });

  function accept(): { traceId: string } {
    const result = createDeepDiveTraceRequest(db, {
      topicId: "topic_a", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "test-secret"), planning: true,
    });
    if (result.kind !== "accepted") throw new Error("expected accepted request");
    return result;
  }

  it("claims durable work, passes its trace/root Run to the pipeline, then closes the reservation", async () => {
    const accepted = accept();
    let received: { topicId: string; traceId?: string; rootRunId?: string } | null = null;
    const result = await runGenerationDispatchOnce(db, async (runDb, topicId, opts) => {
      const traceId = opts?.traceId;
      const rootRunId = opts?.rootRunId;
      if (!rootRunId) throw new Error("dispatcher must provide its root Run");
      received = { topicId, traceId, rootRunId };
      // runAnalysis normally closes the root Run. The fake pipeline reproduces that terminal write.
      runDb.prepare("UPDATE run SET status='done', ended_at=? WHERE id=?").run(new Date().toISOString(), rootRunId);
      return {} as Report;
    });

    expect(result).toEqual({ claimed: true, traceId: accepted.traceId, status: "done" });
    expect(received).toMatchObject({ topicId: "topic_a", traceId: accepted.traceId, rootRunId: expect.stringMatching(/^run_/) });
    expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(accepted.traceId)).toEqual({ status: "done" });
    expect(db.prepare("SELECT state FROM generation_dispatch WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "done" });
    expect(db.prepare("SELECT state FROM generation_lease WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "released" });
  });

  it("marks the trace and its root Run failed when execution fails before runAnalysis starts", async () => {
    const accepted = accept();
    const result = await runGenerationDispatchOnce(db, async () => {
      throw new Error("synthetic pipeline failure");
    });

    expect(result).toEqual({ claimed: true, traceId: accepted.traceId, status: "failed" });
    expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(accepted.traceId)).toEqual({ status: "failed" });
    expect(db.prepare("SELECT status FROM run WHERE trace_id=?").get(accepted.traceId)).toEqual({ status: "failed" });
    expect(db.prepare("SELECT state FROM generation_dispatch WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "failed" });
  });

  it("rejects an old claim after its lease is taken over", () => {
    accept();
    const now = new Date("2026-08-03T00:00:00.000Z");
    const first = claimNextGenerationDispatch(db, now)!;
    const second = claimNextGenerationDispatch(db, new Date(now.getTime() + 121_000))!;
    expect(second.ownerToken).not.toBe(first.ownerToken);
    expect(() => assertGenerationDispatchClaim(db, first, new Date(now.getTime() + 121_000))).toThrow("generation_fence_lost");
    expect(() => assertGenerationDispatchClaim(db, second, new Date(now.getTime() + 121_000))).not.toThrow();
  });
});

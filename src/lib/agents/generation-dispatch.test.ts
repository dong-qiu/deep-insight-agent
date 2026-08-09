import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { assertGenerationDispatchClaim, claimNextGenerationDispatch, createDeepDiveTraceRequest, createScheduledTraceRequest, hashIdempotencyKey } from "../db/provenance.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import { captureRevision, entityKey, type EntityRef } from "../db/provenance-facts.js";
import type { ContentItem, Report, Source } from "../types.js";
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

  it("records a revision conflict through the real scheduled dispatcher without leaving a running root Run", async () => {
    const source: Source = {
      id: "source_a", name: "Source A", type: "rss", endpoint: "https://example.test/feed",
      topic_ids: ["topic_a"], fetch_interval: "1h", backfill: null, enabled: true,
    };
    const item: ContentItem = {
      id: "content_a", source_id: source.id, url: "https://example.test/article", title: "article",
      author: null, published_at: null, fetched_at: new Date().toISOString(), language: "en",
      topic_ids: ["topic_a"], tags: [], body: "body", body_kind: "article", raw_ref: "raw",
      content_hash: "hash_content_a", fetch_status: "ok",
    };
    insertSource(db, source);
    insertContentItem(db, item);
    const ref: EntityRef = { type: "content_item", locator: { kind: "id", id: item.id }, revision: `content-v2:${item.content_hash}`, role: "input" };
    captureRevision(db, {
      entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision,
      snapshot: {
        url: item.url, source_id: item.source_id, published_at: item.published_at,
        body_length: item.body.length + 1, content_hash: item.content_hash,
      },
    });
    const accepted = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-09", windowHours: 24, items: 1,
    });
    if (accepted.kind !== "accepted") throw new Error("expected accepted request");

    await expect(runGenerationDispatchOnce(db)).resolves.toEqual({ claimed: true, traceId: accepted.traceId, status: "failed" });

    expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(accepted.traceId)).toEqual({ status: "failed" });
    expect(db.prepare("SELECT state FROM generation_dispatch WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "failed" });
    expect(db.prepare("SELECT status FROM run WHERE trace_id=?").get(accepted.traceId)).toEqual({ status: "failed" });
    expect(db.prepare("SELECT stage,event_type,error FROM generation_event WHERE trace_id=? ORDER BY sequence").all(accepted.traceId)).toEqual([
      { stage: "analyze", event_type: "started", error: null },
      { stage: "analyze", event_type: "failed", error: '{"reason_code":"provenance_revision_conflict"}' },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM analysis_batch").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM run WHERE trace_id=?").get(accepted.traceId)).toEqual({ count: 1 });
  });

  it("passes the persisted Brief plan to the worker executor", async () => {
    const accepted = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15,
    });
    if (accepted.kind !== "accepted") throw new Error("expected accepted request");
    let received: { reportType: string; windowHours?: number; windowEnd?: string; items?: number; traceId?: string } | null = null;
    const result = await runGenerationDispatchOnce(db, async (runDb, _topicId, opts) => {
      received = opts;
      runDb.prepare("UPDATE run SET status='done', ended_at=? WHERE id=?").run(new Date().toISOString(), opts.rootRunId);
    });
    expect(result).toMatchObject({ claimed: true, traceId: accepted.traceId, status: "done" });
    expect(received).toMatchObject({ reportType: "brief", windowHours: 168, windowEnd: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), items: 15, traceId: accepted.traceId });
  });

  it("records no-content as an explicit skipped cron trace instead of an untraced failure", async () => {
    const accepted = createScheduledTraceRequest(db, {
      topicId: "topic_a", reportType: "brief", period: "2026-08-03", windowHours: 168, items: 15,
    });
    if (accepted.kind !== "accepted") throw new Error("expected accepted request");
    expect(await runGenerationDispatchOnce(db)).toMatchObject({ claimed: true, traceId: accepted.traceId, status: "done" });
    expect(db.prepare("SELECT stage,event_type,reason_code FROM generation_event WHERE trace_id=?").all(accepted.traceId))
      .toEqual([{ stage: "select", event_type: "skipped", reason_code: "no_content" }]);
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

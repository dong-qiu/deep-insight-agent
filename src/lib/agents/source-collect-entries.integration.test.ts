/** Production-entry coverage for source collection provenance. Routes use the
 * real trace factory/claim/collector; source fetch is the only mocked edge. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { getRun, insertSource, setCircuit } from "../db/repos.js";
import { claimSourceCollectTrace, createSourceCollectTrace, getGenerationTraceStatus } from "../db/provenance.js";
import { collectSource } from "./collector.js";
import type { RawItem } from "../sources/types.js";
import type { Source } from "../types.js";

const state = vi.hoisted(() => ({ db: null as DB | null, raws: [] as RawItem[], failure: null as Error | null }));
vi.mock("../db/index.js", async (original) => ({
  ...(await original<typeof import("../db/index.js")>()),
  getDb: () => {
    if (!state.db) throw new Error("integration_db_not_ready");
    return state.db;
  },
}));
vi.mock("../sources/index.js", () => ({
  fetchFromSource: vi.fn(async () => {
    if (state.failure) throw state.failure;
    return state.raws;
  }),
}));
vi.mock("../config/index.js", async (original) => ({
  ...(await original<typeof import("../config/index.js")>()),
  getEffectiveSources: vi.fn(() => []),
  loadStaticConfig: vi.fn(() => ({})),
}));

const { POST: collectRoute } = await import("../../app/api/admin/sources/[id]/collect/route.js");
const { POST: retryRoute } = await import("../../app/api/admin/runs/[id]/retry/route.js");

const source: Source = {
  id: "source_entry", name: "Entry source", type: "rss", endpoint: "https://example.test/feed",
  topic_ids: [], fetch_interval: "1h", backfill: null, enabled: true,
};
const raw = (suffix: string): RawItem => ({
  url: `https://example.test/${suffix}`, title: suffix, author: null, published_at: null,
  body: `body ${suffix}`, raw: `raw ${suffix}`,
});
let db: DB;

async function flushCollector(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectCompletedFacts(traceId: string): void {
  expect(getGenerationTraceStatus(db, traceId)).toMatchObject({ trace_id: traceId, status: "done", source_id: source.id });
  expect(db.prepare("SELECT COUNT(*) AS count FROM run WHERE trace_id=? AND kind='ingest' AND status='done'").get(traceId)).toEqual({ count: 1 });
  expect(db.prepare("SELECT stage,event_type FROM generation_event WHERE trace_id=? ORDER BY sequence").all(traceId))
    .toEqual(expect.arrayContaining([{ stage: "collect", event_type: "started" }, { stage: "normalize", event_type: "completed" }]));
  const revisions = db.prepare("SELECT COUNT(*) AS count FROM provenance_revision WHERE entity_type='content_item'").get() as { count: number };
  expect(revisions.count).toBeGreaterThanOrEqual(1);
  const refs = db.prepare("SELECT COUNT(*) AS count FROM generation_entity_ref WHERE trace_id=?").get(traceId) as { count: number };
  expect(refs.count).toBeGreaterThanOrEqual(2);
  expect(db.prepare(`SELECT COUNT(*) AS count FROM generation_entity_ref ref
    LEFT JOIN provenance_revision revision ON revision.entity_type=ref.entity_type AND revision.entity_key=ref.entity_key AND revision.revision=ref.revision
    WHERE ref.trace_id=? AND revision.entity_type IS NULL`).get(traceId)).toEqual({ count: 0 });
}

beforeEach(() => {
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertSource(db, source);
  state.db = db;
  state.raws = [];
  state.failure = null;
});
afterEach(() => { state.db = null; state.raws = []; state.failure = null; });

describe("source collection production entries", () => {
  it("on-demand route creates the claimed API trace and its completed ingest facts", async () => {
    state.raws = [raw("ondemand")];
    const response = await collectRoute(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: source.id }) });
    expect(response.status).toBe(202);
    const body = await response.json() as { trace_id: string };
    await flushCollector();
    expectCompletedFacts(body.trace_id);
    expect(db.prepare("SELECT trigger_kind FROM generation_trace WHERE id=?").get(body.trace_id)).toEqual({ trigger_kind: "api" });
  });

  it("ingest retry route preserves the failed Run and links a fresh retry trace", async () => {
    const original = createSourceCollectTrace(db, { sourceId: source.id, triggerKind: "api" });
    if (original.kind !== "accepted") throw new Error("expected original trace");
    const claim = claimSourceCollectTrace(db, original.traceId);
    if (!claim) throw new Error("expected original claim");
    state.failure = new Error("fixture failure");
    await expect(collectSource(db, source, { traceClaim: claim })).rejects.toThrow("fixture failure");
    const originalRun = db.prepare("SELECT root_run_id FROM generation_trace WHERE id=?").get(original.traceId) as { root_run_id: string };
    expect(getRun(db, originalRun.root_run_id)?.status).toBe("failed");

    state.failure = null;
    state.raws = [raw("retry")];
    const response = await retryRoute(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: originalRun.root_run_id }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { trace_id: string; new_run_id: string };
    expectCompletedFacts(body.trace_id);
    expect(getRun(db, originalRun.root_run_id)?.status).toBe("failed");
    expect(getRun(db, body.new_run_id)).toMatchObject({ retry_of: originalRun.root_run_id, trace_id: body.trace_id });
    expect(db.prepare("SELECT retry_of_trace_id,trigger_kind FROM generation_trace WHERE id=?").get(body.trace_id))
      .toEqual({ retry_of_trace_id: original.traceId, trigger_kind: "retry" });
    expect(db.prepare("SELECT DISTINCT actor_type FROM generation_event WHERE trace_id=?").all(body.trace_id))
      .toEqual([{ actor_type: "system" }]);
  });

  it("half-open probe runs through the scheduler's claimed probe trace", async () => {
    setCircuit(db, source.id);
    state.raws = [raw("probe")];
    const { runCollectionCycle } = await import("./scheduler.js");
    const summary = await runCollectionCycle(db);
    expect(summary.circuitRevived).toEqual([source.id]);
    const trace = db.prepare("SELECT id FROM generation_trace WHERE source_id=? AND trigger_kind='probe'").get(source.id) as { id: string };
    expectCompletedFacts(trace.id);
  });
});

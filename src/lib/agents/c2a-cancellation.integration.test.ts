/** Only SDK transport is replaced: dispatch → scheduler → pipeline → Job → agents → LLM is real. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", async (original) => {
  const actual = await original<typeof import("@anthropic-ai/sdk")>();
  return { ...actual, default: Object.assign(class { messages = { stream }; }, { APIConnectionError: actual.default.APIConnectionError, RateLimitError: actual.default.RateLimitError, InternalServerError: actual.default.InternalServerError }) };
});
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn(), notifyBudget: vi.fn(), notifyReport: vi.fn(), notifyThinBrief: vi.fn(), notifyBriefAcceptance: vi.fn() }));
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { createScheduledTraceRequest, claimNextGenerationDispatch } from "../db/provenance.js";
import { getAnalysisBatch, saveAnalysisBatch } from "../db/analysis.js";
import { insertContentItem, insertSource, insertTopic, listRuns } from "../db/repos.js";
import { planRawArchive, writePlannedRawArchive } from "../db/raw-archive.js";
import { contentHash } from "../sources/normalize.js";
import { MODELS, callStructured } from "../runtime/llm.js";
import { z } from "zod/v4";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";
import { runPipelineForTopic } from "./scheduler.js";
import { verifyQuoteSelfContained } from "./analyzer.js";
import { judgeWithRetry } from "./validator.js";
import { resetRelayRecoveryStateForTest } from "../runtime/relay-recovery.js";
import { runAnalysis, runValidation } from "./pipeline.js";
import type { AnalysisBatch, ContentItem, Topic } from "../types.js";
let db: DB; let dir: string; const originalModels = { ...MODELS };
const topic: Topic = { id: "t1", name: "topic", keywords: ["Agent"], facets: [], language: "en", enabled: true, brief_schedule: "daily" };
let item: ContentItem;
const emptyResponse = () => ({ stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2 }, content: [{ type: "tool_use", name: "respond_with_structured_output", input: { no_significant_event: true, insights: [] } }] });
beforeEach(() => {
  vi.useFakeTimers(); stream.mockReset(); resetRelayRecoveryStateForTest();
  vi.stubEnv("LLM_PROVIDER", "anthropic"); vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
  vi.stubEnv("ANALYSIS_CACHE", "0"); vi.stubEnv("CONSISTENCY_CACHE", "0"); vi.stubEnv("REPORT_PUSH", "0");
  Object.assign(MODELS, { analyzer: "claude-sonnet-4-6", validator: "claude-opus-4-7", coverage: "test-independent-coverage" });
  dir = mkdtempSync(join(tmpdir(), "ia-c2a-")); vi.stubEnv("DATA_DIR", dir);
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertTopic(db, topic);
  insertSource(db, { id: "s1", name: "source", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true });
  const body = "Agent release with benchmark evidence.";
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: body, source_body_kind: "article", source_item_raw: "<item>synthetic</item>", structured_body_sha256: contentHash(body) }) + "\n";
  item = { id: "ci1", source_id: "s1", url: "https://example.test/one", title: "Agent", body, body_kind: "article", author: null, published_at: new Date().toISOString(), fetched_at: new Date().toISOString(), language: "en", topic_ids: [topic.id], tags: [], raw_ref: "", content_hash: contentHash(body), fetch_status: "ok" };
  insertContentItem(db, item);
  const archive = planRawArchive(db, { contentId: item.id, raw }); writePlannedRawArchive(db, archive, raw);
  item.raw_ref = archive.rawRef;
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); resetRelayRecoveryStateForTest(); vi.unstubAllEnvs(); Object.assign(MODELS, originalModels); });
function controlled() {
  let resolve!: (value: ReturnType<typeof emptyResponse>) => void; let reject!: (error: unknown) => void;
  const final = new Promise<ReturnType<typeof emptyResponse>>((r, j) => { resolve = r; reject = j; });
  const abort = vi.fn(); stream.mockReturnValue({ finalMessage: () => final, abort });
  return { resolve, reject, abort, signal: () => stream.mock.calls[0][1].signal as AbortSignal };
}
function accept() {
  const accepted = createScheduledTraceRequest(db, { topicId: topic.id, reportType: "brief", period: "2026-10-04", windowHours: 168, items: 1 });
  if (accepted.kind !== "accepted") throw new Error("fixture acceptance failed");
  return accepted.traceId;
}
it("pre-cancelled production pipeline sends zero SDK requests", async () => {
  const external = new AbortController(); external.abort(new Error("synthetic-private"));
  await expect(runPipelineForTopic(db, topic.id, { signal: external.signal })).rejects.toThrow("cancelled");
  expect(stream).not.toHaveBeenCalled(); expect(listRuns(db)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["resolve", "reject"])("deadline reaches SDK/stream.abort; ignores provider late %s and starts no later stage", async (late) => {
  const provider = controlled();
  const pending = runPipelineForTopic(db, topic.id, { deadlineAt: Date.now() + 10 });
  const rejected = expect(pending).rejects.toThrow("task_deadline_exceeded");
  await vi.advanceTimersByTimeAsync(0); expect(stream).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10); await rejected;
  expect(provider.signal().aborted).toBe(true); expect(provider.abort).toHaveBeenCalledOnce();
  if (late === "resolve") provider.resolve(emptyResponse()); else provider.reject(new Error("synthetic-private-late"));
  await vi.advanceTimersByTimeAsync(0);
  expect(listRuns(db)).toHaveLength(1); expect(listRuns(db)[0].kind).toBe("analyze");
  for (const table of ["analysis_batch", "validation_result", "report", "analysis_cache", "consistency_cache", "tech_lead", "technology_opportunity"]) expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(JSON.stringify(listRuns(db))).not.toContain("synthetic-private"); expect(vi.getTimerCount()).toBe(0);
});
it.each(["false", "throw"])("lease heartbeat %s aborts actual SDK and prevents even failed Run/trace writes", async (failure) => {
  const traceId = accept(); const provider = controlled(); let guard!: () => void;
  // Wrap the real scheduler only to capture its production ownership guard.
  const pending = runGenerationDispatchOnce(db, async (runDb, topicId, opts) => {
    guard = opts.assertWrite!;
    return runPipelineForTopic(runDb, topicId, opts);
  }, { heartbeatMs: 10, heartbeat: () => { if (failure === "throw") throw new Error("synthetic-private-heartbeat"); return false; } });
  await vi.advanceTimersByTimeAsync(0); expect(stream).toHaveBeenCalledOnce();
  const before = db.prepare("SELECT * FROM generation_event WHERE trace_id=?").all(traceId);
  await vi.advanceTimersByTimeAsync(10);
  await expect(pending).resolves.toMatchObject({ status: "failed" });
  expect(provider.signal().aborted).toBe(true); expect(provider.abort).toHaveBeenCalledOnce();
  expect(guard).toThrow("generation_fence_lost");
  provider.resolve(emptyResponse()); await vi.advanceTimersByTimeAsync(0);
  expect(db.prepare("SELECT * FROM generation_event WHERE trace_id=?").all(traceId)).toEqual(before);
  expect(listRuns(db)[0].status).toBe("running"); expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "claimed" });
  expect(db.prepare("SELECT COUNT(*) n FROM analysis_batch").get()).toEqual({ n: 0 }); expect(vi.getTimerCount()).toBe(0);
});
it("actual expired-claim takeover rejects stale guard independently of heartbeat cancellation", async () => {
  vi.stubEnv("LLM_TIMEOUT_MS", "300000");
  accept(); const provider = controlled(); let guard!: () => void;
  const pending = runGenerationDispatchOnce(db, async (runDb, topicId, opts) => { guard = opts.assertWrite!; return runPipelineForTopic(runDb, topicId, opts); }, { heartbeatMs: 200_000 });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(121_000); expect(claimNextGenerationDispatch(db)).not.toBeNull();
  expect(guard).toThrow("generation_fence_lost"); expect(provider.signal().aborted).toBe(true);
  await expect(pending).resolves.toMatchObject({ status: "failed" }); provider.resolve(emptyResponse());
  await vi.advanceTimersByTimeAsync(0); expect(listRuns(db)[0].status).toBe("running"); expect(vi.getTimerCount()).toBe(0);
});
it("LLM transient retry backoff cancellation sends no second request", async () => {
  vi.stubEnv("LLM_TRANSIENT_RETRY_BACKOFF_MS", "100");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  stream.mockReturnValue({ finalMessage: async () => { throw Object.assign(new Error("socket hang up synthetic-private"), { name: "synthetic-private-name" }); }, abort: vi.fn() });
  const external = new AbortController(); const pending = runAnalysis(db, topic, [item], { start: "2026-10-01", end: "2026-10-04" }, { signal: external.signal });
  const rejected = expect(pending).rejects.toThrow("cancelled"); await vi.advanceTimersByTimeAsync(0);
  expect(stream).toHaveBeenCalledOnce(); external.abort(new Error("synthetic-private")); await rejected;
  await vi.advanceTimersByTimeAsync(1000); expect(stream).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-private"); warning.mockRestore();
});
it("normal production analysis retains output and request parameters", async () => {
  stream.mockReturnValue({ finalMessage: async () => emptyResponse(), abort: vi.fn() });
  const batch = await runAnalysis(db, topic, [item], { start: "2026-10-01", end: "2026-10-04" });
  expect(batch).toMatchObject({ status: "done", insights: [], no_significant_event: true }); expect(getAnalysisBatch(db, batch.id)).not.toBeNull();
  expect(stream.mock.calls[0][0]).toMatchObject({ model: MODELS.analyzer, max_tokens: 12000, tool_choice: { type: "tool", name: "respond_with_structured_output" }, thinking: undefined });
  expect(stream.mock.calls[0][0].messages[0].content).toContain(item.id); expect(vi.getTimerCount()).toBe(0);
});
it("pre-cancelled callStructured avoids SDK independently of Job", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(callStructured({ role: "analyzer", system: "s", user: "u", schema: z.object({ ok: z.boolean() }), signal: controller.signal })).rejects.toBe(controller.signal.reason);
  expect(stream).not.toHaveBeenCalled();
});

it.each(["coverage", "judge", "relay"])("%s actual agent retry wait cancels without another SDK request", async (operation) => {
  vi.stubEnv("LLM_TRANSIENT_RETRIES", "0"); vi.stubEnv("VALIDATOR_RETRY_BACKOFF_MS", "100");
  const error = operation === "relay" ? Object.assign(new Error("synthetic-private"), { status: 429 }) : new Error("socket hang up");
  stream.mockReturnValue({ finalMessage: async () => { throw error; }, abort: vi.fn() });
  const external = new AbortController();
  const work = operation === "coverage"
    ? verifyQuoteSelfContained({ content_item_id: item.id, quote: item.body, locator: { paragraph_index: 0, char_start: 0, char_end: item.body.length } }, undefined, external.signal)
    : judgeWithRetry("Agent released", item.body, undefined, undefined, item.body, external.signal);
  const rejected = expect(work).rejects.toThrow("cancelled");
  // Attach a handler before any rejection, then check the actual reason after abort.
  await vi.advanceTimersByTimeAsync(0); expect(stream).toHaveBeenCalledOnce();
  const reason = new Error("cancelled"); external.abort(reason);
  await rejected;
  await expect(work).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100000); expect(stream).toHaveBeenCalledOnce();
});
it("Volcengine actual fetch receives cancellation; late transport response cannot persist business results", async () => {
  vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic-key"); vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  let release!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => { release = r; })); vi.stubGlobal("fetch", fetchMock);
  try {
    const external = new AbortController(); const pending = runPipelineForTopic(db, topic.id, { signal: external.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled"); await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce(); const signal = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].signal!;
    external.abort(new Error("synthetic-private")); await rejected;
    expect(signal.aborted).toBe(true);
    release(new Response('data: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(db.prepare("SELECT COUNT(*) n FROM analysis_batch").get()).toEqual({ n: 0 }); expect(listRuns(db)).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it("runValidation wires the actual judge request and cannot save a late verdict/cache", async () => {
  vi.stubEnv("CONSISTENCY_CACHE", "1"); const provider = controlled();
  const batch: AnalysisBatch = { id: "b1", topic_id: topic.id, time_window: { start: "2026-10-01", end: "2026-10-04" }, status: "done", no_significant_event: false, insights: [{ id: "i1", topic_id: topic.id, type: "aggregation", event_id: null, statement: item.body, headline: "", importance: 3, importance_basis: "test", citations: [{ content_item_id: item.id, claim: item.body, quote: item.body, locator: { paragraph_index: 0, char_start: 0, char_end: item.body.length } }], source_count: 1, multi_source: false, time_window: { start: "2026-10-01", end: "2026-10-04" }, confidence: "high", language: "en", is_followup: false, entities: [], tags: [] }] };
  saveAnalysisBatch(db, batch);
  const external = new AbortController(); const pending = runValidation(db, batch, [item], { signal: external.signal });
  const rejected = expect(pending).rejects.toThrow("cancelled"); await vi.advanceTimersByTimeAsync(0);
  expect(stream).toHaveBeenCalledOnce(); expect(stream.mock.calls[0][0].model).toBe(MODELS.validator);
  external.abort(); await rejected; expect(provider.signal().aborted).toBe(true);
  provider.resolve(emptyResponse()); await vi.advanceTimersByTimeAsync(0);
  expect(db.prepare("SELECT COUNT(*) n FROM validation_result").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM consistency_cache").get()).toEqual({ n: 0 }); expect(vi.getTimerCount()).toBe(0);
});
it("normal complete production dispatch remains publishable and releases its lease", async () => {
  const traceId = accept(); stream.mockReturnValue({ finalMessage: async () => emptyResponse(), abort: vi.fn() });
  await expect(runGenerationDispatchOnce(db)).resolves.toMatchObject({ traceId, status: "done" });
  expect(db.prepare("SELECT status FROM report").get()).toEqual({ status: "done" });
  expect(db.prepare("SELECT state FROM generation_lease").get()).toEqual({ state: "released" });
  expect(vi.getTimerCount()).toBe(0);
});
it("configured dispatch deadline and external cancellation yield one terminal trace", async () => {
  const traceId = accept(); const provider = controlled(); const external = new AbortController();
  const pending = runGenerationDispatchOnce(db, undefined, { signal: external.signal, deadlineAt: Date.now() + 10 });
  await vi.advanceTimersByTimeAsync(0); external.abort(new Error("synthetic-private"));
  await vi.advanceTimersByTimeAsync(10);
  await expect(pending).resolves.toMatchObject({ status: "failed" });
  provider.resolve(emptyResponse()); await vi.advanceTimersByTimeAsync(0);
  expect(db.prepare("SELECT status FROM generation_trace WHERE id=?").get(traceId)).toEqual({ status: "cancelled" });
  expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "failed" });
  expect(listRuns(db)).toHaveLength(1); expect(listRuns(db)[0].error).toEqual({ type: "cancelled", message: "cancelled" }); expect(vi.getTimerCount()).toBe(0);
});
it("SDK abort hook failure does not leak an event exception or change cancellation reason", async () => {
  const provider = controlled(); provider.abort.mockImplementation(() => { throw new Error("synthetic-private-hook"); });
  const external = new AbortController(); const pending = runPipelineForTopic(db, topic.id, { signal: external.signal });
  const rejected = expect(pending).rejects.toThrow("cancelled"); await vi.advanceTimersByTimeAsync(0);
  external.abort(); await rejected; provider.reject(new Error("synthetic-private-late")); await vi.advanceTimersByTimeAsync(0);
  expect(listRuns(db)[0].error).toEqual({ type: "cancelled", message: "cancelled" }); expect(vi.getTimerCount()).toBe(0);
});
it("real report-generation composition passes the synchronous deadline checkpoint into anchored persistence", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { MemoryAnchorStore } = await import("../db/integrity-anchors.js");
  const keys = generateKeyPairSync("ed25519"); const deadlineAt = Date.now() + 10;
  const store = new MemoryAnchorStore(); const put = vi.spyOn(store, "putIfAbsent");
  const signing = vi.fn(async (bytes: Uint8Array) => { vi.setSystemTime(deadlineAt); return sign(null, bytes, keys.privateKey); });
  stream.mockReturnValue({ finalMessage: async () => emptyResponse(), abort: vi.fn() });
  await expect(runPipelineForTopic(db, topic.id, { deadlineAt, anchor: { store, signer: { key_id: "c2a-managed", public_key: keys.publicKey, sign: signing }, issuedAt: "2026-10-04T00:00:00Z", retainUntil: "2027-10-04T00:00:00Z", retentionEnds: ["2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z", "2027-10-04T00:00:00Z"] } })).rejects.toThrow("task_deadline_exceeded");
  expect(signing).toHaveBeenCalledOnce(); expect(put).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) n FROM generation_anchor_effect").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM report_index").get()).toEqual({ n: 0 });
  expect(listRuns(db).find((run) => run.kind === "report-gen")?.error?.message).toBe("task_deadline_exceeded"); expect(vi.getTimerCount()).toBe(0);
});
it("invalid independent-stage deadline writes neither started trace event nor Run", async () => {
  const traceId = accept(); const before = db.prepare("SELECT * FROM generation_event WHERE trace_id=?").all(traceId);
  await expect(runAnalysis(db, topic, [item], { start: "2026-10-01", end: "2026-10-04" }, { traceId, deadlineAt: NaN })).rejects.toThrow("invalid_task_deadline");
  expect(db.prepare("SELECT * FROM generation_event WHERE trace_id=?").all(traceId)).toEqual(before); expect(listRuns(db)).toEqual([]); expect(stream).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

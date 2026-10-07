import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import * as provenance from "../db/provenance.js";
import * as repos from "../db/repos.js";
import * as rawArchive from "../db/raw-archive.js";
import * as jobs from "../runtime/jobs.js";
import { enrollBudgetRun, recordBudgetCost, withTaskBudget } from "../runtime/task-budget.js";
import * as shadowStore from "./podcast-shadow-store.js";
import { collectSource } from "./collector.js";
import type { Source } from "../types.js";
import type { RawItem } from "../sources/types.js";

const { fetchSource, fetchArticle, fetchTranscript, fetchProgram } = vi.hoisted(() => ({
  fetchSource: vi.fn(), fetchArticle: vi.fn(), fetchTranscript: vi.fn(), fetchProgram: vi.fn(),
}));
vi.mock("../sources/index.js", () => ({ fetchFromSource: fetchSource }));
vi.mock("../sources/article.js", () => ({ fetchArticle, articleFetchEnabled: () => false, articleFetchKilled: () => false }));
vi.mock("../sources/rss.js", async (original) => ({
  ...await original<typeof import("../sources/rss.js")>(), fetchTranscript, fetchPodcastProgramPage: fetchProgram,
}));
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn() }));

const source: Source = { id: "s_control", name: "Synthetic", type: "rss", endpoint: "https://source.example.invalid/feed", topic_ids: ["t_control"], fetch_interval: "1h", backfill: null, enabled: true };
const raw = (id = "one"): RawItem => ({ url: `https://source.example.invalid/${id}`, title: "Coding agent synthetic entry", author: null, published_at: null, body: "Synthetic complete body.", raw: "synthetic source bytes" });
const podcast: Source = { ...source, transcript_mode: "observe", transcript_strategy: "all", transcript_policy_version: "synthetic-policy-v1", transcript_host_qps: 1000, transcript_timeout_budget_ms: 5000, transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 5000 };
const episode = (): RawItem => ({ ...raw(), is_podcast_episode: true, body_kind: "show_notes", transcript_url: "https://transcript.example.invalid/one.txt" });
const transcript = { outcome: "success", stable_url: "https://transcript.example.invalid/one.txt", raw_payload: "Synthetic transcript.", cleaned_body: "Synthetic transcript.", bytes: 21, duration_ms: 1, content_type: "text/plain" };
const program = { outcome: "success", stable_url: "https://source.example.invalid/one", raw_payload: "<html>Synthetic episode</html>", bytes: 30, duration_ms: 1, content_type: "text/html" };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let db: DB;
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "collector-control-")); vi.stubEnv("DATA_DIR", dataDir);
  db = openDb(":memory:"); applyProvenanceMigrations(db); repos.insertSource(db, source);
  repos.insertTopic(db, { id: "t_control", name: "Synthetic", keywords: ["coding agent"], language: "en", enabled: true, brief_schedule: "daily", facets: [] });
  fetchSource.mockReset().mockResolvedValue([raw()]); fetchArticle.mockReset().mockResolvedValue(null);
  fetchTranscript.mockReset().mockResolvedValue(transcript); fetchProgram.mockReset().mockResolvedValue(program);
  vi.stubEnv("TRANSCRIPT_FETCH", "1"); vi.stubEnv("TRANSCRIPT_SHADOW_FETCH", "1");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); db.close(); });
function claim() {
  const result = provenance.createScheduledSourceCollectTrace(db, { sourceId: source.id });
  if (result.kind !== "accepted") throw new Error("synthetic trace not accepted");
  const lease = provenance.claimSourceCollectTrace(db, result.traceId);
  if (!lease) throw new Error("synthetic trace not claimed"); return lease;
}
function rows(table: string) { return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; }
function failedEvent(traceId: string) {
  const row = db.prepare("SELECT output_refs,metrics,reason_code FROM generation_event WHERE trace_id=? AND event_type='failed' ORDER BY sequence DESC LIMIT 1").get(traceId) as { output_refs: string; metrics: string; reason_code: string };
  return { refs: JSON.parse(row.output_refs), metrics: JSON.parse(row.metrics), reason: row.reason_code };
}

describe("collector optional task admission", () => {
  it.each(["cancel", "expired", "invalidDeadline", "zeroCap", "invalidCap"])("%s starts no source/article/shadow work", async (mode) => {
    const controller = new AbortController(); if (mode === "cancel") controller.abort();
    const options = mode === "cancel" ? { signal: controller.signal } : mode === "expired" ? { deadlineAt: Date.now() - 1 } : mode === "invalidDeadline" ? { deadlineAt: NaN } : { taskBudgetUsd: mode === "zeroCap" ? 0 : Infinity };
    await expect(collectSource(db, source, options)).rejects.toThrow();
    expect(fetchSource).not.toHaveBeenCalled(); expect(fetchArticle).not.toHaveBeenCalled(); expect(fetchTranscript).not.toHaveBeenCalled();
    expect(rows("content_item")).toEqual([]); expect(rows("generation_effect")).toEqual([]);
    if (mode === "cancel" || mode === "expired" || mode === "zeroCap") expect(rows("run")[0].status).toBe("failed");
    else expect(rows("run")).toEqual([]);
  });
  it("inherits parent zero budget without allowing a funded child to override", async () => {
    await expect(withTaskBudget(db, { taskBudgetUsd: 0 }, () => collectSource(db, source, { taskBudgetUsd: 100 }))).rejects.toThrow("task_budget_exceeded");
    expect(fetchSource).not.toHaveBeenCalled();
  });
  it.each(["cancel", "deadline", "lease", "budget"])("%s is authoritative after a parent budget fault", async (mode) => {
    const waiting = deferred<RawItem[]>(); fetchSource.mockReturnValue(waiting.promise); const lease = claim(); const controller = new AbortController();
    await withTaskBudget(db, { taskBudgetUsd: 1 }, async () => {
      enrollBudgetRun("synthetic-parent", null);
      const work = collectSource(db, source, { signal: controller.signal, traceClaim: lease, ...(mode === "deadline" ? { deadlineAt: Date.now() + 20 } : {}) });
      const rejected = expect(work).rejects.toThrow(mode === "lease" ? "source_collect_fence_lost" : mode === "deadline" ? "task_deadline_exceeded" : mode === "budget" ? "task_budget_exceeded" : "cancelled");
      await vi.waitFor(() => expect(fetchSource).toHaveBeenCalledOnce());
      recordBudgetCost("synthetic-parent", { amount: 1, tokens: 1 });
      if (mode === "lease") { db.prepare("UPDATE generation_lease SET expires_at='2000-01-01' WHERE trace_id=?").run(lease.traceId); controller.abort(); }
      else if (mode === "cancel") controller.abort(); else if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 30));
      waiting.resolve([raw()]); await rejected;
    });
    expect(rows("content_item")).toEqual([]);
    expect(rows("run")[0].status).toBe(mode === "lease" ? "running" : "failed");
  });
  it.each([undefined, 1])("keeps normal collection and actual raw bytes at cap %j", async (cap) => {
    const result = await collectSource(db, source, { taskBudgetUsd: cap });
    expect(result).toMatchObject({ fetched: 1, inserted: 1, updated: 0, skipped: 0 });
    const content = rows("content_item")[0];
    expect(JSON.parse(readFileSync(join(dataDir, content.raw_ref as string), "utf8"))).toMatchObject({ source_body: raw().body, source_item_raw: raw().raw });
    expect(rows("generation_effect")[0].status).toBe("committed"); expect(rows("run")[0]).toMatchObject({ status: "done", cost: null });
  });
});

describe("collector late await and owned finalization", () => {
  it.each(["resolve", "reject", "deadline"])("suppresses late source %s without claiming source termination", async (mode) => {
    const waiting = deferred<RawItem[]>(); fetchSource.mockReturnValue(waiting.promise);
    const controller = new AbortController(); const lease = claim();
    const work = collectSource(db, source, { signal: controller.signal, traceClaim: lease, ...(mode === "deadline" ? { deadlineAt: Date.now() + 50 } : {}) });
    const rejected = expect(work).rejects.toThrow(mode === "deadline" ? "task_deadline_exceeded" : "cancelled");
    await vi.waitFor(() => expect(fetchSource).toHaveBeenCalledOnce());
    if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 70)); else controller.abort();
    let ended = false; void work.finally(() => { ended = true; }).catch(() => {});
    await Promise.resolve(); expect(ended).toBe(false); // Original source is genuinely joined.
    if (mode === "reject") waiting.reject(new Error("synthetic late source failure")); else waiting.resolve([raw()]);
    await rejected;
    expect(rows("content_item")).toEqual([]); expect(rows("generation_effect")).toEqual([]);
    expect(failedEvent(lease.traceId).reason).toBe(mode === "deadline" ? "task_deadline_exceeded" : "cancelled");
    expect(rows("run")[0].status).toBe("failed");
  });
  it("suppresses late article fallback, retaining its pre-existing normal failure behavior", async () => {
    const waiting = deferred<null>(); fetchArticle.mockReturnValue(waiting.promise);
    const controller = new AbortController(); const work = collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchArticle).toHaveBeenCalledOnce()); controller.abort(); waiting.resolve(null); await rejected;
    expect(rows("content_item")).toEqual([]); expect(rows("generation_effect")).toEqual([]);
  });
  it("retains first cancellation when source settles only after deadline", async () => {
    const waiting = deferred<RawItem[]>(); fetchSource.mockReturnValue(waiting.promise);
    const controller = new AbortController(); const work = collectSource(db, source, { signal: controller.signal, deadlineAt: Date.now() + 50 });
    const rejected = expect(work).rejects.toThrow("cancelled"); controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 70)); waiting.resolve([raw()]); await rejected;
  });
  it.each(["false", "throw"])("heartbeat %s becomes ownership loss without uncaught interval or failed writes", async (mode) => {
    vi.useFakeTimers(); const waiting = deferred<RawItem[]>(); fetchSource.mockReturnValue(waiting.promise);
    const lease = claim(); const controller = new AbortController();
    vi.spyOn(provenance, "heartbeatSourceCollectTrace").mockImplementation(() => { if (mode === "throw") throw new Error("synthetic SQL failure"); return false; });
    const work = collectSource(db, source, { traceClaim: lease, signal: controller.signal }); const rejected = expect(work).rejects.toThrow("source_collect_fence_lost");
    await vi.advanceTimersByTimeAsync(30_000); controller.abort(); waiting.resolve([raw()]); await rejected;
    expect(rows("run")[0].status).toBe("running"); expect(rows("content_item")).toEqual([]);
    expect(rows("generation_event").filter((event) => event.event_type === "failed")).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("actual stale lease wins cancellation and forbids Run/event/trace failure updates", async () => {
    const waiting = deferred<RawItem[]>(); fetchSource.mockReturnValue(waiting.promise); const lease = claim(); const controller = new AbortController();
    const work = collectSource(db, source, { traceClaim: lease, signal: controller.signal }); const rejected = expect(work).rejects.toThrow("source_collect_fence_lost");
    await vi.waitFor(() => expect(fetchSource).toHaveBeenCalledOnce());
    db.prepare("UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z' WHERE trace_id=?").run(lease.traceId);
    controller.abort(); waiting.resolve([raw()]); await rejected;
    expect(rows("run")[0].status).toBe("running"); expect(rows("content_item")).toEqual([]); expect(rows("generation_trace_request")[0].state).toBe("accepted");
  });
  it.each(["cancel", "lease"])("outer scope observes %s after real Job done before trace finish", async (mode) => {
    const lease = claim(); const controller = new AbortController(); const actual = jobs.runJob;
    vi.spyOn(jobs, "runJob").mockImplementation(async (database, spec, fn) => { const result = await actual(database, spec, fn); if (mode === "cancel") controller.abort(); else db.prepare("UPDATE generation_lease SET expires_at='2000-01-01' WHERE trace_id=?").run(lease.traceId); return result; });
    await expect(collectSource(db, source, { traceClaim: lease, signal: controller.signal })).rejects.toThrow(mode === "cancel" ? "cancelled" : "source_collect_fence_lost");
    expect(rows("run")[0].status).toBe("done"); expect(rows("generation_effect")[0].status).toBe("committed");
    if (mode === "cancel") expect(failedEvent(lease.traceId).metrics.committed_output_ref_count).toBe(1);
    else expect(rows("generation_event").filter((event) => event.event_type === "failed")).toEqual([]);
  });
});

describe("collector raw effect and metadata boundaries", () => {
  it("lease loss after intent commit leaves planned effect and forbids collector unknown/failure writes", async () => {
    const lease = claim(); const actual = rawArchive.planRawArchive;
    vi.spyOn(rawArchive, "planRawArchive").mockImplementation((database, input) => { const result = actual(database, input); db.prepare("UPDATE generation_lease SET expires_at='2000-01-01' WHERE trace_id=?").run(lease.traceId); return result; });
    const mark = vi.spyOn(rawArchive, "markRawArchiveUnknown"); const write = vi.spyOn(rawArchive, "writePlannedRawArchive");
    await expect(collectSource(db, source, { traceClaim: lease })).rejects.toThrow("source_collect_fence_lost");
    expect(rows("generation_effect")[0].status).toBe("planned"); expect(rows("content_item")[0].reader_eligible).toBe(0);
    expect(mark).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(rows("run")[0].status).toBe("running");
    expect(rows("generation_event").filter((event) => event.event_type === "failed")).toEqual([]);
  });
  it("intent committed before cancellation becomes exact unknown output with no external archive write", async () => {
    const lease = claim(); const controller = new AbortController(); const actual = rawArchive.planRawArchive;
    vi.spyOn(rawArchive, "planRawArchive").mockImplementation((database, input) => { const result = actual(database, input); controller.abort(); return result; });
    const write = vi.spyOn(rawArchive, "writePlannedRawArchive");
    await expect(collectSource(db, source, { traceClaim: lease, signal: controller.signal })).rejects.toThrow("cancelled");
    const item = rows("content_item")[0]; expect(item.reader_eligible).toBe(0); expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, item.raw_ref as string))).toBe(false); expect(rows("generation_effect")[0].status).toBe("unknown");
    const failed = failedEvent(lease.traceId); expect(failed.refs).toEqual([expect.objectContaining({ locator: { kind: "id", id: item.id } })]);
    expect(failed.metrics).toMatchObject({ committed_output_ref_count: 0, unknown_output_ref_count: 1, rolled_back_output_ref_count: 0 });
  });
  it.each(["checkpoint", "telemetry"])("records committed exact ref before failing %s", async (mode) => {
    const lease = claim(); const controller = new AbortController(); const actual = rawArchive.writePlannedRawArchive;
    const telemetry = { recordCollector: vi.fn(() => { throw new Error("synthetic telemetry failure"); }), recordAnalysis: vi.fn(), recordValidation: vi.fn(), freezeDueDay: () => false };
    if (mode === "checkpoint") vi.spyOn(rawArchive, "writePlannedRawArchive").mockImplementation((database, plan, bytes) => { actual(database, plan, bytes); controller.abort(); });
    await expect(collectSource(db, source, { traceClaim: lease, signal: controller.signal, ...(mode === "telemetry" ? { telemetry } : {}) })).rejects.toThrow();
    const item = rows("content_item")[0]; expect(item.reader_eligible).toBe(1); expect(rows("generation_effect")[0].status).toBe("committed");
    expect(failedEvent(lease.traceId)).toMatchObject({ refs: [expect.objectContaining({ locator: { kind: "id", id: item.id } })], metrics: { committed_output_ref_count: 1, unknown_output_ref_count: 0, rolled_back_output_ref_count: 0 } });
  });
  it("already committed first item stays; telemetry cancellation admits no second item", async () => {
    fetchSource.mockResolvedValue([raw("one"), raw("two")]); const lease = claim(); const controller = new AbortController();
    const telemetry = { recordCollector: vi.fn(() => controller.abort()), recordAnalysis: vi.fn(), recordValidation: vi.fn(), freezeDueDay: () => false };
    await expect(collectSource(db, source, { traceClaim: lease, signal: controller.signal, telemetry })).rejects.toThrow("cancelled");
    expect(rows("content_item")).toHaveLength(1); expect(rows("generation_effect")[0].status).toBe("committed"); expect(telemetry.recordCollector).toHaveBeenCalledOnce();
    expect(failedEvent(lease.traceId).metrics.committed_output_ref_count).toBe(1);
  });
  it("metadata control is not swallowed into second diagnostic or Content output", async () => {
    fetchSource.mockResolvedValue([episode()]); const controller = new AbortController(); const actual = repos.appendTranscriptAcquisitionFact;
    vi.spyOn(repos, "appendTranscriptAcquisitionFact").mockImplementation((database, fact) => { const result = actual(database, fact); controller.abort(); return result; });
    await expect(collectSource(db, podcast, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(rows("transcript_acquisition_fact")).toHaveLength(1); expect(rows("content_item")).toEqual([]); expect(fetchTranscript).not.toHaveBeenCalled();
  });
});

describe("collector true shadow lifetime", () => {
  it.each(["resolve", "reject"])("joins program-page %s without late archive or terminal", async (mode) => {
    fetchSource.mockResolvedValue([episode()]); const waiting = deferred<typeof program>(); fetchProgram.mockReturnValue(waiting.promise);
    const controller = new AbortController(); const actual = shadowStore.createPodcastShadowStore; let close = vi.fn();
    vi.spyOn(shadowStore, "createPodcastShadowStore").mockImplementation((input) => { const store = actual(input); close = vi.fn(() => store.close()); return { ...store, close }; });
    const work = collectSource(db, podcast, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchProgram).toHaveBeenCalledOnce()); controller.abort(); expect(close).not.toHaveBeenCalled();
    if (mode === "resolve") waiting.resolve(program); else waiting.reject(new Error("synthetic late program failure")); await rejected;
    expect(close).toHaveBeenCalledOnce();
    const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db")); expect(shadow.prepare("SELECT stage FROM transcript_acquisition_fact WHERE stage='terminal'").all()).toEqual([]); shadow.close();
  });
  it("first shadow fact may remain; cancellation inside sink blocks next fact and fetch", async () => {
    fetchSource.mockResolvedValue([episode()]); const controller = new AbortController(); const actual = shadowStore.createPodcastShadowStore;
    vi.spyOn(shadowStore, "createPodcastShadowStore").mockImplementation((input) => { const store = actual(input); const append = store.sink.append; return { ...store, sink: { ...store.sink, append(fact) { const result = append(fact); controller.abort(); return result; } } }; });
    await expect(collectSource(db, podcast, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchTranscript).not.toHaveBeenCalled(); const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db"));
    expect(shadow.prepare("SELECT stage FROM transcript_acquisition_fact").all()).toEqual([{ stage: "candidate" }]); shadow.close();
  });
  it("ordinary shadow error still leaves normal production RSS collection successful", async () => {
    fetchSource.mockResolvedValue([episode()]); fetchTranscript.mockRejectedValue(new Error("synthetic ordinary shadow failure"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await collectSource(db, podcast, { taskBudgetUsd: 1 })).toMatchObject({ inserted: 1, fetched: 1 });
    expect(rows("run")[0].status).toBe("done"); expect(rows("generation_effect")[0].status).toBe("committed"); expect(warning).toHaveBeenCalledOnce();
  });
  it.each(["resolve", "reject"])("joins shadow transcript %s before close and denies late shadow writes", async (mode) => {
    fetchSource.mockResolvedValue([episode()]); const waiting = deferred<typeof transcript>(); fetchTranscript.mockReturnValue(waiting.promise);
    const controller = new AbortController(); const actual = shadowStore.createPodcastShadowStore; let close = vi.fn();
    vi.spyOn(shadowStore, "createPodcastShadowStore").mockImplementation((input) => { const store = actual(input); close = vi.fn(() => store.close()); return { ...store, close }; });
    const work = collectSource(db, podcast, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchTranscript).toHaveBeenCalledOnce()); controller.abort(); await Promise.resolve(); expect(close).not.toHaveBeenCalled();
    if (mode === "resolve") waiting.resolve(transcript); else waiting.reject(new Error("synthetic late transcript failure")); await rejected;
    expect(close).toHaveBeenCalledOnce(); expect(fetchProgram).not.toHaveBeenCalled();
    const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db"));
    expect(shadow.prepare("SELECT stage FROM transcript_acquisition_fact WHERE stage='terminal'").all()).toEqual([]); shadow.close();
    expect(rows("generation_effect")[0].status).toBe("committed");
  });
  it("guard rechecks after original shadow QPS policy await before transport", async () => {
    vi.useFakeTimers(); fetchSource.mockResolvedValue([episode()]); const controller = new AbortController();
    // Same origin forces the program-page gate to await the actual original host policy.
    fetchTranscript.mockImplementation(async (url, opts) => { await opts.beforeRequest(url); return transcript; });
    const dispatched = vi.fn(); fetchProgram.mockImplementation(async (_url, opts) => { await opts.beforeRequest("https://transcript.example.invalid/one-page"); dispatched(); return program; });
    const work = collectSource(db, { ...podcast, transcript_host_qps: 0.5 }, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
    for (let i = 0; i < 30 && !fetchProgram.mock.calls.length; i++) await Promise.resolve();
    expect(fetchProgram).toHaveBeenCalledOnce(); controller.abort(); await vi.advanceTimersByTimeAsync(2000); await rejected;
    expect(dispatched).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, 1])("normal configured shadow remains enabled at cap %j", async (cap) => {
    fetchSource.mockResolvedValue([episode()]); await collectSource(db, podcast, { taskBudgetUsd: cap });
    expect(fetchTranscript).toHaveBeenCalledOnce(); expect(fetchProgram).toHaveBeenCalledOnce();
    const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db")); const terminal = shadow.prepare("SELECT outcome,raw_ref FROM transcript_acquisition_fact WHERE stage='terminal'").get() as { outcome: string; raw_ref: string };
    expect(terminal.outcome).toBe("success"); expect(existsSync(join(dataDir, "podcast-shadow", terminal.raw_ref))).toBe(true); shadow.close();
    expect(rows("content_item")[0].body_kind).toBe("show_notes");
  });
});

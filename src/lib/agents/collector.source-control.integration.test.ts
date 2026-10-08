/** Real collector/source/HTTP bodies/SQLite/raw; only DNS, HTTP and notifications are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { insertSource, insertTopic } from "../db/repos.js";
import * as provenance from "../db/provenance.js";
import * as registry from "../sources/index.js";
import * as articles from "../sources/article.js";
import { TaskCancellationError } from "../runtime/cancellation.js";
import { runJob } from "../runtime/jobs.js";
import { recordBudgetCost, withTaskBudget } from "../runtime/task-budget.js";
import { collectSource, type CollectOptions } from "./collector.js";
import type { Source } from "../types.js";

const { dns } = vi.hoisted(() => ({ dns: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns }));
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn() }));
const source: Source = { id: "s_consumer", name: "Synthetic", type: "rss", endpoint: "https://feed.example.invalid/feed", topic_ids: ["t_consumer"], fetch_interval: "1h", backfill: null, enabled: true };
const entry = (id = "one") => `<item><title>Coding agent ${id}</title><link>https://page.example.invalid/${id}</link><description><![CDATA[<p>Synthetic notes ${id}.</p>]]></description></item>`;
const feed = (items = entry()) => `<rss><channel><title>Synthetic feed</title>${items}</channel></rss>`;
const html = `<html><body><article>${"Synthetic full article. ".repeat(80)}</article></body></html>`;
const reply = (body: string, type = "text/plain") => new Response(body, { headers: { "content-type": type } });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let db: DB; let dataDir: string;
let http: ReturnType<typeof vi.fn<(url: URL | string, opts?: RequestInit) => Promise<Response>>>;
let releases: (() => void)[]; let joined: Promise<unknown>[];
function observe<T>(work: Promise<T>) {
  const state = { settled: false };
  const outcome = work.then(value => { state.settled = true; return { ok: true as const, value }; }, error => { state.settled = true; return { ok: false as const, error }; });
  joined.push(outcome); return { state, outcome };
}
function rows(table: string) { return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; }
function claim() {
  const accepted = provenance.createScheduledSourceCollectTrace(db, { sourceId: source.id });
  if (accepted.kind !== "accepted") throw new Error("fixture trace not accepted");
  const lease = provenance.claimSourceCollectTrace(db, accepted.traceId);
  if (!lease) throw new Error("fixture trace not claimed"); return lease;
}
function calls() { return http.mock.calls.map(([url]) => String(url)); }
function signalFor(url: string) { return http.mock.calls.find(([input]) => String(input) === url)![1]!.signal!; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function noBusinessOutput() {
  expect(rows("content_item")).toEqual([]); expect(rows("generation_effect")).toEqual([]);
  expect(rows("generation_event").filter(event => event.stage === "normalize" && event.event_type === "completed")).toEqual([]);
}
function failed(reason: string) {
  expect(rows("run")[0]).toMatchObject({ status: "failed" });
  const event = rows("generation_event").find(row => row.event_type === "failed")!;
  expect(event.reason_code).toBe(reason); expect(JSON.parse(event.error as string)).toEqual({ reason_code: reason, retryable: false });
}
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "collector-source-consumer-")); vi.stubEnv("DATA_DIR", dataDir);
  vi.stubEnv("ARTICLE_FETCH", ""); vi.stubEnv("ARTICLE_FETCH_MAX_PER_RUN", "25");
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertSource(db, source);
  insertTopic(db, { id: "t_consumer", name: "Synthetic", keywords: ["coding agent"], language: "en", enabled: true, brief_schedule: "daily", facets: [] });
  dns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  http = vi.fn(async input => String(input).endsWith("/robots.txt") ? reply("User-agent: *\nDisallow:") : String(input) === source.endpoint ? reply(feed(), "application/rss+xml") : reply(html, "text/html"));
  vi.stubGlobal("fetch", http); releases = []; joined = [];
});
afterEach(async () => {
  for (const release of releases) release();
  await Promise.all(joined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); db.close();
});

it.each(["default", "trace", "budget", "parentBudget", "probe", "retry", "telemetry", "signal", "deadline"] as const)("%s preserves normal source/raw output and enables only explicit source control", async mode => {
  const fetchSource = vi.spyOn(registry, "fetchFromSource"); const fetchArticle = vi.spyOn(articles, "fetchArticle");
  const controller = new AbortController();
  const opts: CollectOptions = mode === "trace" ? { traceClaim: claim() } : mode === "budget" ? { taskBudgetUsd: 1 } : mode === "probe" ? { probe: true }
    : mode === "telemetry" ? { telemetry: { recordCollector: vi.fn(), recordAnalysis: vi.fn(), recordValidation: vi.fn(), freezeDueDay: () => false } }
    : mode === "signal" ? { signal: controller.signal } : mode === "deadline" ? { deadlineAt: Date.now() + 60_000 } : {};
  if (mode === "retry") opts.retryOf = (await runJob(db, { kind: "ingest", target: { source_id: source.id } }, async () => ({}))).run.id;
  const run = () => collectSource(db, { ...source, fetch_mode: "full_text", content_container: "article" }, opts);
  const result = mode === "parentBudget" ? await withTaskBudget(db, { taskBudgetUsd: 1 }, run) : await run();
  expect(result).toMatchObject({ fetched: 1, inserted: 1, updated: 0, skipped: 0 });
  const explicit = mode === "signal" || mode === "deadline";
  expect(fetchSource.mock.calls[0]).toHaveLength(explicit ? 2 : 1);
  expect(fetchArticle.mock.calls[0]).toHaveLength(explicit ? 3 : 2);
  if (explicit) {
    const task = fetchSource.mock.calls[0][1]!.signal!;
    expect(task).not.toBe(controller.signal); expect(task.aborted).toBe(false);
    expect(fetchArticle.mock.calls[0][2]!.signal).toBe(task);
  }
  expect(calls()).toEqual(["https://feed.example.invalid/robots.txt", source.endpoint, "https://page.example.invalid/robots.txt", "https://page.example.invalid/one"]);
  const item = rows("content_item")[0]; expect(item.reader_eligible).toBe(1); expect(item.body).toContain("Synthetic full article.");
  expect(JSON.parse(readFileSync(join(dataDir, item.raw_ref as string), "utf8"))).toMatchObject({ source_body_origin: "article_page", article_html: html });
  expect(rows("generation_effect")[0].status).toBe("committed"); expect(rows("run")[0]).toMatchObject({ status: "done", cost: null });
});

it.each([null, { opaque: "first" }])("actual RSS HTTP receives canonical task cancellation for %j and joins late body cleanup", async reason => {
  const waiting = deferred<Response>(); const cleanup = deferred<void>(); const entered = deferred<void>();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const bodyCancel = vi.fn(() => cleanup.promise); const stream = new ReadableStream<Uint8Array>({ start(c) { bodyController = c; }, cancel: bodyCancel });
  const response = new Response(stream); const controller = new AbortController(); const lease = claim();
  http.mockImplementation(async input => { if (String(input) === source.endpoint) { entered.resolve(); return waiting.promise; } return reply(""); });
  releases.push(() => { waiting.resolve(response); cleanup.resolve(); if (!bodyCancel.mock.calls.length) { try { bodyController.close(); } catch { /* Fixture already settled. */ } } });
  const work = observe(collectSource(db, source, { signal: controller.signal, traceClaim: lease }));
  await entered.promise; const transport = signalFor(source.endpoint); controller.abort(reason); controller.abort(new Error("second"));
  waiting.resolve(response); await turn();
  const facts = { taskAborted: transport.aborted, cancelCalls: bodyCancel.mock.calls.length, bodyUsed: response.bodyUsed, settled: work.state.settled, runStatus: rows("run")[0].status, traceState: rows("generation_trace_request")[0].state };
  cleanup.reject(new Error("synthetic cleanup rejected")); if (!bodyCancel.mock.calls.length) { bodyController.close(); void cleanup.promise.catch(() => {}); } const result = await work.outcome;
  console.log("collector canonical cleanup", JSON.stringify(facts));
  expect(facts).toEqual({ taskAborted: true, cancelCalls: 1, bodyUsed: true, settled: false, runStatus: "running", traceState: "accepted" });
  expect(result.ok).toBe(false); if (!result.ok) { expect(result.error).toBe(transport.reason); expect(result.error).toBeInstanceOf(TaskCancellationError); }
  expect(bodyCancel).toHaveBeenCalledWith(transport.reason); noBusinessOutput(); failed("cancelled");
});

it.each(["resolve", "reject"] as const)("explicit cancellation joins real DNS %s and starts no HTTP", async mode => {
  const waiting = deferred<{ address: string; family: number }[]>(); const entered = deferred<void>();
  dns.mockImplementation(() => { entered.resolve(); return waiting.promise; });
  releases.push(() => waiting.resolve([{ address: "8.8.8.8", family: 4 }]));
  const controller = new AbortController(); const work = observe(collectSource(db, source, { signal: controller.signal, traceClaim: claim() }));
  await entered.promise; controller.abort(); await turn(); expect(work.state.settled).toBe(false); expect(rows("run")[0].status).toBe("running");
  if (mode === "resolve") waiting.resolve([{ address: "8.8.8.8", family: 4 }]); else waiting.reject(new Error("late DNS failure"));
  expect(await work.outcome).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } });
  expect(http).not.toHaveBeenCalled(); noBusinessOutput(); failed("cancelled");
});

it.each(["robots", "feed", "articleRobots", "article"] as const)("%s real stream cleanup is joined before collector failure and business writes", async target => {
  const readerEntered = deferred<void>(); const cleanup = deferred<void>(); const cancel = vi.fn(() => cleanup.promise);
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { bodyController = c; }, cancel }); const getReader = stream.getReader.bind(stream);
  vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); readerEntered.resolve(); return reader; });
  const controller = new AbortController(); const lease = claim();
  const selected = target === "robots" ? "https://feed.example.invalid/robots.txt" : target === "feed" ? source.endpoint
    : target === "articleRobots" ? "https://page.example.invalid/robots.txt" : "https://page.example.invalid/one";
  const normal = http.getMockImplementation()!;
  http.mockImplementation(async (url, opts) => String(url) === selected ? new Response(stream, { headers: { "content-type": "text/html" } }) : normal(url, opts));
  releases.push(() => { cleanup.resolve(); if (!cancel.mock.calls.length) { try { bodyController.close(); } catch { /* Fixture already settled. */ } } });
  const work = observe(collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal, traceClaim: lease }));
  await readerEntered.promise; controller.abort(null); await turn();
  const pending = { settled: work.state.settled, status: rows("run")[0].status, cancels: cancel.mock.calls.length };
  cleanup.resolve(); if (!cancel.mock.calls.length) bodyController.close(); const result = await work.outcome;
  expect(pending).toEqual({ settled: false, status: "running", cancels: 1 });
  expect(result).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } });
  expect(signalFor(selected).aborted).toBe(true); expect(cancel).toHaveBeenCalledWith(signalFor(selected).reason);
  expect(stream.locked).toBe(false); noBusinessOutput(); failed("cancelled");
  if (target === "robots") expect(calls()).not.toContain(source.endpoint);
  if (target === "articleRobots") expect(calls()).not.toContain("https://page.example.invalid/one");
});

it.each(["robots", "feed", "article"] as const)("collector joins %s owned-response await gap cleanup with canonical first reason", async target => {
  const controller = new AbortController(); const cleanup = deferred<void>(); const cancel = vi.fn(() => cleanup.promise);
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { bodyController = c; }, cancel }), { headers: { "content-type": "text/html" } });
  let reads = 0;
  vi.spyOn(response, "status", "get").mockImplementation(() => { if (++reads === (target === "robots" ? 1 : 2)) queueMicrotask(() => controller.abort(null)); return 200; });
  const selected = target === "robots" ? "https://feed.example.invalid/robots.txt" : target === "feed" ? source.endpoint : "https://page.example.invalid/one";
  const normal = http.getMockImplementation()!;
  http.mockImplementation(async (url, opts) => String(url) === selected ? response : normal(url, opts)); releases.push(() => { cleanup.resolve(); if (!cancel.mock.calls.length) { try { bodyController.close(); } catch { /* Fixture already settled. */ } } });
  const work = observe(collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal, traceClaim: claim() }));
  await turn(); const facts = { settled: work.state.settled, cancels: cancel.mock.calls.length, bodyUsed: response.bodyUsed, status: rows("run")[0].status, traceState: rows("generation_trace_request")[0].state };
  cleanup.reject(new Error("late cleanup")); if (!cancel.mock.calls.length) { bodyController.close(); void cleanup.promise.catch(() => {}); } const result = await work.outcome;
  console.log("collector owned response", target, JSON.stringify(facts));
  expect(facts).toEqual({ settled: false, cancels: 1, bodyUsed: true, status: "running", traceState: "accepted" });
  expect(result).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } }); noBusinessOutput(); failed("cancelled");
});

it("deadline-only reaches actual HTTP and joins its late ignored response", async () => {
  const waiting = deferred<Response>(); const entered = deferred<void>();
  http.mockImplementation(async input => { if (String(input) === source.endpoint) { entered.resolve(); return waiting.promise; } return reply(""); });
  releases.push(() => waiting.resolve(reply(feed(), "application/rss+xml")));
  const work = observe(collectSource(db, source, { deadlineAt: Date.now() + 100, traceClaim: claim() }));
  await entered.promise; await vi.waitFor(() => expect(signalFor(source.endpoint).aborted).toBe(true));
  expect(work.state.settled).toBe(false); waiting.resolve(reply(feed(), "application/rss+xml"));
  expect(await work.outcome).toMatchObject({ ok: false, error: { reasonCode: "task_deadline_exceeded" } }); noBusinessOutput(); failed("task_deadline_exceeded");
});

it("first committed exact ref/raw survives while second real article cleanup is cancelled", async () => {
  const entered = deferred<void>(); const cleanup = deferred<void>(); const controller = new AbortController(); const lease = claim();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>; const cancel = vi.fn(() => cleanup.promise);
  const stream = new ReadableStream<Uint8Array>({ start(c) { bodyController = c; }, cancel }); const getReader = stream.getReader.bind(stream);
  vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); entered.resolve(); return reader; });
  const normal = http.getMockImplementation()!;
  http.mockImplementation(async (url, opts) => String(url) === source.endpoint ? reply(feed(entry("one") + entry("two")), "application/rss+xml")
    : String(url) === "https://page.example.invalid/two" ? new Response(stream, { headers: { "content-type": "text/html" } }) : normal(url, opts));
  releases.push(() => { cleanup.resolve(); if (!cancel.mock.calls.length) { try { bodyController.close(); } catch { /* Fixture already settled. */ } } });
  const work = observe(collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal, traceClaim: lease }));
  await entered.promise; const before = rows("content_item"); const effects = rows("generation_effect"); const raw = readFileSync(join(dataDir, before[0].raw_ref as string));
  controller.abort(); await turn(); expect(work.state.settled).toBe(false); cleanup.resolve(); if (!cancel.mock.calls.length) bodyController.close(); await work.outcome;
  expect(rows("content_item")).toEqual(before); expect(rows("generation_effect")).toEqual(effects); expect(readFileSync(join(dataDir, before[0].raw_ref as string))).toEqual(raw);
  const event = rows("generation_event").find(row => row.event_type === "failed")!;
  expect(JSON.parse(event.metrics as string)).toMatchObject({ committed_output_ref_count: 1, unknown_output_ref_count: 0, rolled_back_output_ref_count: 0 });
  expect(JSON.parse(event.output_refs as string)).toEqual([expect.objectContaining({ locator: { kind: "id", id: before[0].id } })]);
});

it.each(["lease", "budget"] as const)("%s loss keeps network signal live while original work joins, then refuses writes", async mode => {
  const waiting = deferred<Response>(); const entered = deferred<void>(); const lease = claim(); const controller = new AbortController();
  const run = () => collectSource(db, source, { signal: controller.signal, traceClaim: lease });
  http.mockImplementation(async input => { if (String(input) === source.endpoint) { entered.resolve(); return waiting.promise; } return reply(""); });
  releases.push(() => waiting.resolve(reply(feed(), "application/rss+xml")));
  const work = observe(mode === "budget" ? withTaskBudget(db, { taskBudgetUsd: 1 }, async () => {
    const work = run(); await entered.promise; recordBudgetCost(rows("run")[0].id as string, { tokens: 1, amount: 1 }); return work;
  }) : run());
  await entered.promise;
  if (mode === "lease") db.prepare("UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z' WHERE trace_id=?").run(lease.traceId);
  await turn(); expect(signalFor(source.endpoint).aborted).toBe(false); expect(work.state.settled).toBe(false);
  waiting.resolve(reply(feed(), "application/rss+xml")); const result = await work.outcome;
  expect(result).toMatchObject({ ok: false, error: { message: mode === "lease" ? "source_collect_fence_lost" : "task_budget_exceeded" } }); noBusinessOutput();
  if (mode === "lease") { expect(rows("run")[0].status).toBe("running"); expect(rows("generation_event").filter(row => row.event_type === "failed")).toEqual([]); }
  else failed("task_budget_exceeded");
});

it("ordinary robots availability failure and full-text null retain partial output", async () => {
  const controller = new AbortController();
  http.mockImplementation(async input => { if (String(input).endsWith("/robots.txt")) throw new Error("ordinary robots availability");
    return String(input) === source.endpoint ? reply(feed(), "application/rss+xml") : new Response("not HTML", { headers: { "content-type": "application/pdf" } }); });
  expect(await collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal })).toMatchObject({ inserted: 1 });
  expect(rows("content_item")[0]).toMatchObject({ body: "Synthetic notes one.", fetch_status: "partial" }); expect(rows("run")[0].status).toBe("done");
});

it.each(["aborted", "expired", "invalid", "zeroBudget"] as const)("%s admission creates no DNS/HTTP/content/raw work", async mode => {
  const controller = new AbortController(); controller.abort(null);
  const opts: CollectOptions = mode === "aborted" ? { signal: controller.signal } : mode === "expired" ? { deadlineAt: 0 }
    : mode === "invalid" ? { deadlineAt: NaN } : { taskBudgetUsd: 0 };
  const work = observe(collectSource(db, source, opts));
  expect(await work.outcome).toMatchObject({ ok: false }); expect(dns).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); noBusinessOutput();
});

it("task cancellation stays first when its source terminates only after deadline", async () => {
  const waiting = deferred<Response>(); const entered = deferred<void>(); const controller = new AbortController();
  http.mockImplementation(async input => { if (String(input) === source.endpoint) { entered.resolve(); return waiting.promise; } return reply(""); });
  releases.push(() => waiting.resolve(reply(feed(), "application/rss+xml")));
  const work = observe(collectSource(db, source, { signal: controller.signal, deadlineAt: Date.now() + 100, traceClaim: claim() }));
  await entered.promise; controller.abort(null); await new Promise(resolve => setTimeout(resolve, 120));
  expect(work.state.settled).toBe(false); waiting.resolve(reply(feed(), "application/rss+xml"));
  const result = await work.outcome; expect(result).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } });
  expect(signalFor(source.endpoint).reason).toMatchObject({ reasonCode: "cancelled" }); failed("cancelled"); noBusinessOutput();
});

it.each(["default", "explicit"] as const)("arxiv %s retains real queue and single-argument registry, never claiming transport cancellation", async mode => {
  vi.useFakeTimers(); const controller = new AbortController(); const waiting = deferred<Response>();
  const arxiv: Source = { ...source, type: "arxiv", endpoint: "https://arxiv.example.invalid/query" };
  const atom = '<feed><entry><id>https://page.example.invalid/arxiv</id><title>Coding agent paper</title><summary>Synthetic paper body.</summary></entry></feed>';
  const fetchSource = vi.spyOn(registry, "fetchFromSource"); http.mockImplementation(async () => waiting.promise);
  releases.push(() => waiting.resolve(reply(atom, "application/atom+xml")));
  const work = observe(collectSource(db, arxiv, mode === "explicit" ? { signal: controller.signal } : {}));
  await vi.advanceTimersByTimeAsync(0); expect(http).toHaveBeenCalledOnce(); expect(fetchSource.mock.calls[0]).toHaveLength(1);
  if (mode === "explicit") controller.abort(null);
  expect(signalFor(arxiv.endpoint).aborted).toBe(false); expect(work.state.settled).toBe(false);
  waiting.resolve(reply(atom, "application/atom+xml")); await vi.advanceTimersByTimeAsync(3_001);
  const result = await work.outcome;
  if (mode === "explicit") { expect(result).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } }); noBusinessOutput(); }
  else expect(result).toMatchObject({ ok: true, value: { fetched: 1, inserted: 1 } });
});

it.each(["redirect", "retry"] as const)("explicit task abort inside %s body cleanup prevents the next hop/retry", async mode => {
  vi.useFakeTimers(); const controller = new AbortController(); const cleanup = deferred<void>();
  const cancel = vi.fn(() => { controller.abort(null); return cleanup.promise; });
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: mode === "redirect" ? 302 : 503,
    headers: mode === "redirect" ? { location: "https://next.example.invalid/feed" } : {} });
  const normal = http.getMockImplementation()!; let feedRequests = 0;
  http.mockImplementation(async (url, opts) => String(url) === source.endpoint && ++feedRequests === 1 ? response : normal(url, opts));
  releases.push(() => { controller.abort(); cleanup.resolve(); });
  const work = observe(collectSource(db, source, { signal: controller.signal, traceClaim: claim() }));
  await vi.advanceTimersByTimeAsync(0);
  const facts = { cancels: cancel.mock.calls.length, settled: work.state.settled, status: rows("run")[0].status };
  cleanup.resolve(); await vi.advanceTimersByTimeAsync(10_000); const result = await work.outcome;
  expect(facts).toEqual({ cancels: 1, settled: false, status: "running" });
  expect(result).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } });
  expect(calls()).toEqual(["https://feed.example.invalid/robots.txt", source.endpoint]); failed("cancelled"); noBusinessOutput();
});

it("arxiv feed stays unsupported while its existing full-text article branch consumes explicit control", async () => {
  vi.useFakeTimers(); const controller = new AbortController(); const cleanup = deferred<void>(); const entered = deferred<void>();
  const arxiv: Source = { ...source, type: "arxiv", endpoint: "https://arxiv.example.invalid/query", fetch_mode: "full_text" };
  const atom = '<feed><entry><id>https://page.example.invalid/arxiv</id><title>Coding agent paper</title><summary>Synthetic paper body.</summary></entry></feed>';
  const cancel = vi.fn(() => cleanup.promise); const stream = new ReadableStream<Uint8Array>({ cancel }); const getReader = stream.getReader.bind(stream);
  vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); entered.resolve(); return reader; });
  const fetchSource = vi.spyOn(registry, "fetchFromSource"); const fetchArticle = vi.spyOn(articles, "fetchArticle");
  http.mockImplementation(async input => String(input) === arxiv.endpoint ? reply(atom, "application/atom+xml")
    : String(input).endsWith("/robots.txt") ? reply("") : new Response(stream, { headers: { "content-type": "text/html" } }));
  releases.push(() => { controller.abort(); cleanup.resolve(); });
  const work = observe(collectSource(db, arxiv, { signal: controller.signal }));
  await vi.advanceTimersByTimeAsync(0); await entered.promise; controller.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(fetchSource.mock.calls[0]).toHaveLength(1); expect(fetchArticle.mock.calls[0]).toHaveLength(3);
  expect(signalFor(arxiv.endpoint).aborted).toBe(false); expect(signalFor("https://page.example.invalid/arxiv").aborted).toBe(true);
  expect(work.state.settled).toBe(false); expect(cancel).toHaveBeenCalledOnce(); cleanup.resolve(); await vi.advanceTimersByTimeAsync(3_001);
  expect(await work.outcome).toMatchObject({ ok: false, error: { reasonCode: "cancelled" } }); noBusinessOutput();
});

it.each(["cancel", "deadline", "lease"] as const)("real source join retains %s precedence over a sticky parent budget fault", async mode => {
  const controller = new AbortController(); const waiting = deferred<Response>(); const entered = deferred<void>(); const lease = claim();
  http.mockImplementation(async input => { if (String(input) === source.endpoint) { entered.resolve(); return waiting.promise; } return reply(""); });
  releases.push(() => waiting.resolve(reply(feed(), "application/rss+xml")));
  const work = observe(withTaskBudget(db, { taskBudgetUsd: 1 }, async () => {
    const pending = collectSource(db, source, { signal: controller.signal, traceClaim: lease, ...(mode === "deadline" ? { deadlineAt: Date.now() + 100 } : {}) });
    await entered.promise; recordBudgetCost(rows("run")[0].id as string, { tokens: 1, amount: 1 });
    if (mode === "lease") db.prepare("UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z' WHERE trace_id=?").run(lease.traceId);
    if (mode !== "deadline") controller.abort(null);
    return pending;
  }));
  await entered.promise;
  await vi.waitFor(() => expect(signalFor(source.endpoint).aborted).toBe(true)); expect(work.state.settled).toBe(false);
  waiting.resolve(reply(feed(), "application/rss+xml")); const result = await work.outcome;
  const reason = mode === "lease" ? "source_collect_fence_lost" : mode === "deadline" ? "task_deadline_exceeded" : "cancelled";
  expect(result).toMatchObject({ ok: false, error: { message: reason } }); noBusinessOutput();
  if (mode === "lease") { expect(rows("run")[0].status).toBe("running"); expect(rows("generation_event").filter(row => row.event_type === "failed")).toEqual([]); }
  else failed(reason);
});

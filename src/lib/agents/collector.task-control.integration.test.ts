/** Real collector → RSS/article/robots/safeFetch → fake HTTP; real SQLite/raw/shadow storage. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { insertSource, insertTopic } from "../db/repos.js";
import * as stores from "./podcast-shadow-store.js";
import { collectSource } from "./collector.js";
import type { Source } from "../types.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
vi.mock("../runtime/alert.js", () => ({ notifyFailure: vi.fn() }));
const source: Source = { id: "s_http", name: "Synthetic HTTP", type: "rss", endpoint: "https://feed.example.invalid/feed", topic_ids: ["t_http"], fetch_interval: "1h", backfill: null, enabled: true };
const podcast: Source = { ...source, transcript_mode: "observe", transcript_strategy: "all", transcript_policy_version: "synthetic-policy-v1", transcript_host_qps: 1000, transcript_timeout_budget_ms: 5000, transcript_max_items_per_run: 2, transcript_max_bytes_per_run: 10000 };
const feed = (pod = false) => `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Synthetic feed</title><item><title>Coding agent evidence</title><link>https://page.example.invalid/episode</link><description><![CDATA[<p>Synthetic show notes.</p>]]></description>${pod ? '<enclosure url="https://audio.example.invalid/episode.mp3" type="audio/mpeg"/><podcast:transcript url="https://transcript.example.invalid/episode.txt" type="text/plain"/>' : ''}</item></channel></rss>`;
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const response = (body: string, contentType = "text/plain") => new Response(body, { status: 200, headers: { "content-type": contentType } });
let db: DB;
let dataDir: string;
let fetchMock: ReturnType<typeof vi.fn<(url: URL | string, opts?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "collector-http-control-")); vi.stubEnv("DATA_DIR", dataDir);
  vi.stubEnv("TRANSCRIPT_FETCH", "1"); vi.stubEnv("TRANSCRIPT_SHADOW_FETCH", "1");
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertSource(db, source);
  insertTopic(db, { id: "t_http", name: "Synthetic", keywords: ["coding agent"], language: "en", enabled: true, brief_schedule: "daily", facets: [] });
  fetchMock = vi.fn(async (input) => { const url = new URL(input); if (url.pathname === "/robots.txt") return response("User-agent: *\nDisallow:"); if (url.pathname === "/feed") return response(feed(), "application/rss+xml"); return response(`<html><body><article><p>${"Synthetic full article. ".repeat(80)}</p></article></body></html>`, "text/html"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });
function calls() { return fetchMock.mock.calls.map(([url]) => new URL(url).toString()); }
function count(table: string) { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

it.each([undefined, 1])("normal RSS/robots/parser/raw path stays identical at cap %j", async (cap) => {
  expect(await collectSource(db, source, { taskBudgetUsd: cap })).toMatchObject({ fetched: 1, inserted: 1, updated: 0, skipped: 0 });
  expect(calls()).toEqual(["https://feed.example.invalid/robots.txt", source.endpoint]);
  const item = db.prepare("SELECT body,raw_ref FROM content_item").get() as { body: string; raw_ref: string };
  expect(item.body).toBe("Synthetic show notes."); expect(JSON.parse(readFileSync(join(dataDir, item.raw_ref), "utf8"))).toMatchObject({ source_body: "<p>Synthetic show notes.</p>", source_body_origin: "feed" });
  expect(count("generation_effect")).toBe(1);
});

it.each(["resolve", "reject"])("late real RSS HTTP %s receives explicit task abort and returns no collector commit", async (mode) => {
  const waiting = deferred<Response>(); fetchMock.mockImplementation(async (input) => new URL(input).pathname === "/feed" ? waiting.promise : response("User-agent: *\nDisallow:"));
  const controller = new AbortController(); const work = collectSource(db, source, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(calls()).toContain(source.endpoint)); controller.abort();
  const requestSignal = fetchMock.mock.calls.find(([url]) => new URL(url).pathname === "/feed")![1]!.signal!;
  expect(requestSignal.aborted).toBe(true); // C2f opts the real RSS transport into explicit task control.
  if (mode === "resolve") waiting.resolve(response(feed(), "application/rss+xml")); else waiting.reject(new Error("SSRF 拦截: synthetic terminal failure"));
  await rejected; expect(count("content_item")).toBe(0); expect(count("generation_effect")).toBe(0);
});

it("real article robots explicit cancellation prevents fail-open payload and collector commit", async () => {
  const waiting = deferred<Response>();
  fetchMock.mockImplementation(async (input) => { const url = new URL(input); if (url.hostname === "page.example.invalid" && url.pathname === "/robots.txt") return waiting.promise; if (url.pathname === "/robots.txt") return response(""); if (url.pathname === "/feed") return response(feed(), "application/rss+xml"); return response(`<html><body><article><p>${"Synthetic full article. ".repeat(80)}</p></article></body></html>`, "text/html"); });
  const controller = new AbortController(); const work = collectSource(db, { ...source, fetch_mode: "full_text" }, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(calls()).toContain("https://page.example.invalid/robots.txt")); controller.abort(); waiting.reject(new Error("synthetic robots availability error")); await rejected;
  expect(calls()).not.toContain("https://page.example.invalid/episode"); // C2f explicit control cannot become robots allow-all.
  expect(count("content_item")).toBe(0); expect(count("generation_effect")).toBe(0);
});

it("real shadow robots catch cannot revive payload transport or late sink after cancellation", async () => {
  const waiting = deferred<Response>(); const actual = stores.createPodcastShadowStore; let close = vi.fn();
  vi.spyOn(stores, "createPodcastShadowStore").mockImplementation((input) => { const store = actual(input); close = vi.fn(() => store.close()); return { ...store, close }; });
  fetchMock.mockImplementation(async (input) => { const url = new URL(input); if (url.hostname === "transcript.example.invalid") return waiting.promise; if (url.pathname === "/robots.txt") return response(""); return response(feed(true), "application/rss+xml"); });
  const controller = new AbortController(); const work = collectSource(db, podcast, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(calls()).toContain("https://transcript.example.invalid/robots.txt")); controller.abort(); expect(close).not.toHaveBeenCalled();
  waiting.reject(new Error("synthetic robots availability error")); await rejected;
  expect(calls()).not.toContain("https://transcript.example.invalid/episode.txt"); expect(close).toHaveBeenCalledOnce();
  const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db")); expect(shadow.prepare("SELECT stage FROM transcript_acquisition_fact WHERE stage='terminal'").all()).toEqual([]); shadow.close();
  expect(count("content_item")).toBe(1); // Previously committed production show notes survive.
});

it("real shadow redirect hop is gated after task cancellation with no late archive/terminal", async () => {
  const waiting = deferred<Response>();
  fetchMock.mockImplementation(async (input) => { const url = new URL(input); if (url.pathname === "/robots.txt") return response(""); if (url.pathname === "/feed") return response(feed(true), "application/rss+xml"); if (url.hostname === "transcript.example.invalid") return waiting.promise; return response("Synthetic transcript."); });
  const controller = new AbortController(); const work = collectSource(db, podcast, { signal: controller.signal }); const rejected = expect(work).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(calls()).toContain("https://transcript.example.invalid/episode.txt")); controller.abort();
  waiting.resolve(new Response(null, { status: 302, headers: { location: "https://redirect.example.invalid/late.txt" } })); await rejected;
  expect(calls()).not.toContain("https://redirect.example.invalid/late.txt");
  const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db")); expect(shadow.prepare("SELECT stage FROM transcript_acquisition_fact WHERE stage='terminal'").all()).toEqual([]); shadow.close();
});

it.each([undefined, 1])("real normal shadow RSS/robots/transcript/program-page/archive at cap %j", async (cap) => {
  fetchMock.mockImplementation(async (input) => { const url = new URL(input); if (url.pathname === "/robots.txt") return response(""); if (url.pathname === "/feed") return response(feed(true), "application/rss+xml"); if (url.hostname === "transcript.example.invalid") return response("Synthetic complete transcript."); return response("<html><body>Synthetic episode page.</body></html>", "text/html"); });
  await collectSource(db, podcast, { taskBudgetUsd: cap });
  expect(calls()).toEqual(["https://feed.example.invalid/robots.txt", source.endpoint, "https://transcript.example.invalid/robots.txt", "https://transcript.example.invalid/episode.txt", "https://page.example.invalid/robots.txt", "https://page.example.invalid/episode"]);
  const shadow = openDb(join(dataDir, "podcast-shadow", "shadow.db")); const terminal = shadow.prepare("SELECT outcome,raw_ref FROM transcript_acquisition_fact WHERE stage='terminal'").get() as { outcome: string; raw_ref: string };
  expect(terminal.outcome).toBe("success"); expect(existsSync(join(dataDir, "podcast-shadow", terminal.raw_ref))).toBe(true); shadow.close();
  expect(count("content_item")).toBe(1); expect((db.prepare("SELECT body_kind FROM content_item").get() as { body_kind: string }).body_kind).toBe("show_notes");
});

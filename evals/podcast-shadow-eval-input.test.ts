import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPodcastTranscriptShadow } from "../src/lib/agents/podcast-shadow.js";
import { createPodcastShadowStore } from "../src/lib/agents/podcast-shadow-store.js";
import { appendTranscriptAcquisitionFact, transcriptAcquisitionEventKey } from "../src/lib/db/repos.js";
import { rawToContentItem, stripTranscript } from "../src/lib/sources/normalize.js";
import type { Source, TranscriptAcquisitionFact } from "../src/lib/types.js";
import type { RawItem, TranscriptFetchResult } from "../src/lib/sources/types.js";
import { buildLocalEvalCases } from "./build-local-eval-lib.js";

const roots: string[] = [];
const at = "2026-09-26T00:00:00.000Z";
const adapter = "rss-podcast-transcript-shadow-v1+podcast-screen-v1";
const body = "Agent systems use verified evidence. The experiment compares two isolated tools.";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const saved = { DATA_DIR: process.env.DATA_DIR, TRANSCRIPT_FETCH: process.env.TRANSCRIPT_FETCH, TRANSCRIPT_SHADOW_FETCH: process.env.TRANSCRIPT_SHADOW_FETCH };
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(sharedUrls = false, standalone = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shadow-eval-"))); roots.push(root);
  process.env.DATA_DIR = join(root, "data");
  process.env.TRANSCRIPT_FETCH = "1"; process.env.TRANSCRIPT_SHADOW_FETCH = "1";
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at));
  const sources: Source[] = [];
  for (const id of ["src_a", "src_b"]) {
    const source: Source = { id, name: id, type: "rss", endpoint: `https://${id}.example/feed`, topic_ids: ["t"],
      fetch_interval: "1h", enabled: true, backfill: null, transcript_mode: "observe", transcript_strategy: "all",
      transcript_policy_version: "fixture-v1", transcript_max_items_per_run: 4, transcript_max_bytes_per_run: 2_000_000,
      transcript_timeout_budget_ms: 20_000, transcript_host_qps: 0.25 };
    sources.push(source);
    const raws: RawItem[] = ["2", "1", "fail"].map((n) => ({ url: `https://${sharedUrls ? "src_a" : id}.example/${n}`, title: `Agent ${n}`, author: null,
      published_at: at, body: "show notes must never become the transcript", body_kind: "show_notes", is_podcast_episode: true,
      transcript_url: `https://${id}.example/${n}.txt`, raw: JSON.stringify({ title: `Agent ${n}` }) }));
    const store = createPodcastShadowStore(source);
    try {
      await runPodcastTranscriptShadow({ source, raws, topics: [{ id: "t", keywords: ["agent"] }], sink: store.sink,
        sleep: async () => {}, now: () => at,
        fetcher: async (url): Promise<TranscriptFetchResult> => url.includes("fail")
          ? { outcome: "parse_empty", stable_url: url, bytes: 0, duration_ms: 1, reason_code: "fixture_failure" }
          : { outcome: "success", stable_url: url, raw_payload: body, cleaned_body: body, bytes: body.length, duration_ms: 1, content_type: "text/plain" },
        programPageFetcher: async (url) => ({ outcome: "success", stable_url: url, raw_payload: "<html>public episode</html>", bytes: 27, duration_ms: 1, content_type: "text/html" }),
      });
    } finally { store.close(); }
  }
  vi.useRealTimers();
  const shadow = join(root, "data/podcast-shadow");
  const dbPath = join(shadow, "shadow.db");
  if (standalone) { const db = new Database(dbPath); db.pragma("journal_mode = DELETE"); db.close(); }
  const request = { version: "podcast-shadow-eval-request-v1", shadow_root: shadow, topic: { id: "t", name: "Agent research", keywords: ["agent"], language: "en" },
    time_window: { start: "2026-09-25T00:00:00.000Z", end: "2026-09-27T00:00:00.000Z" }, per_source: 2,
    sources: sources.map((s) => ({ source_id: s.id, policy_version: "fixture-v1", strategy: "all", adapter_version: adapter })) };
  const output = join(root, "output");
  return { root, shadow, dbPath, request, output, sources };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function run(f: Fixture, output = f.output, isolatedRoot: string | undefined = f.root, existingRequest?: string) {
  const requestFile = existingRequest ?? join(f.root, "request.json");
  if (!existingRequest) writeFileSync(requestFile, JSON.stringify(f.request));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", EVAL_ISOLATED_ROOT: isolatedRoot };
  if (isolatedRoot === undefined) delete env.EVAL_ISOLATED_ROOT;
  return spawnSync(process.execPath, ["--import", "tsx", "evals/build-podcast-shadow-eval-input.ts", requestFile, output], { encoding: "utf8", env, timeout: 20_000 });
}
function firstSuccess(f: Fixture): TranscriptAcquisitionFact {
  const db = new Database(f.dbPath, { readonly: true });
  const row = db.prepare("SELECT * FROM transcript_acquisition_fact WHERE source_id='src_a' AND outcome='success' ORDER BY canonical_episode_url LIMIT 1").get() as TranscriptAcquisitionFact & { semantic_payload_hash?: string };
  db.close(); delete row.semantic_payload_hash; return row;
}
function retry(f: Fixture, change: Partial<TranscriptAcquisitionFact>) {
  const old = firstSuccess(f); const db = new Database(f.dbPath);
  for (const [stage, fields] of [["attempt", { outcome: "not_attempted", evidence_status: "pending", raw_ref: null }], ["terminal", change]] as const) {
    const row = { ...old, attempt: old.attempt + 1, stage, ...fields } as TranscriptAcquisitionFact;
    row.event_key = transcriptAcquisitionEventKey(row); appendTranscriptAcquisitionFact(db, row);
  }
  db.close();
}
function rewriteEvidence(f: Fixture, mutate: (e: any) => void) {
  const fact = firstSuccess(f);
  const envelope = JSON.parse(readFileSync(join(f.shadow, fact.raw_ref!), "utf8"));
  mutate(envelope);
  const identity = { ...envelope }; delete identity.fetched_at;
  const raw_ref = `archive/${sha(`${fact.source_id}\n${JSON.stringify(identity)}`)}.json`;
  writeFileSync(join(f.shadow, raw_ref), JSON.stringify(envelope));
  retry(f, { raw_ref });
}
function fails(f: Fixture, code?: string) {
  const result = run(f);
  expect(result.status).not.toBe(0);
  if (code) expect(result.stderr).toContain(code);
  expect(existsSync(f.output)).toBe(false);
  expect(result.stderr).not.toContain(body);
  expect(result.stderr).not.toContain("https://");
}

describe("offline shadow evidence → A1 input CLI", () => {
  it("uses real shadow sampler/store, exports 2 transcripts per source, keeps DB/archives intact and emits usable A1 DTOs", async () => {
    const f = await fixture();
    const before = sha(readFileSync(f.dbPath));
    const archives = readdirSync(join(f.shadow, "archive")).map((n) => [n, sha(readFileSync(join(f.shadow, "archive", n)))]);
    chmodSync(f.dbPath, 0o400);
    const result = run(f); expect(result.status, result.stderr).toBe(0);
    const quality = JSON.parse(readFileSync(join(f.output, "quality.jsonl"), "utf8"));
    const manifestText = readFileSync(join(f.output, "manifest.json"), "utf8"); const manifest = JSON.parse(manifestText);
    expect(quality.stratum).toBe("transcript"); expect(quality.items).toHaveLength(4);
    expect(quality.items.map((i: any) => i.url)).toEqual(["https://src_a.example/1", "https://src_a.example/2", "https://src_b.example/1", "https://src_b.example/2"]);
    expect(quality.items.every((i: any) => i.body === body && i.body_kind === "transcript" && i.speaker_map_status === "unknown" && existsSync(i.raw_ref))).toBe(true);
    const cases = buildLocalEvalCases([quality.topic], () => quality.items, quality.time_window, { minBody: 1, perSource: 2, maxItems: 4, requiredSourceIds: ["src_a", "src_b"], minimumSources: 2, bodyKind: "transcript" });
    expect(cases.cases[0].items).toHaveLength(4);
    expect(cases.cases[0].items).toEqual(expect.arrayContaining(quality.items));
    expect(manifest.sources.map((s: any) => [s.eligible, s.attempted, s.succeeded, s.selected])).toEqual([[3, 3, 2, 2], [3, 3, 2, 2]]);
    expect(manifest.input_db_sha256).toBe(before); expect(manifest.sampler_commit).toBeNull();
    expect(manifest.quality_sha256).toBe(sha(readFileSync(join(f.output, "quality.jsonl"))));
    expect(manifestText).not.toContain(body); expect(manifestText).not.toContain("https://");
    expect(result.stdout + result.stderr).not.toContain(body);
    expect(sha(readFileSync(f.dbPath))).toBe(before);
    expect(readdirSync(join(f.shadow, "archive")).map((n) => [n, sha(readFileSync(join(f.shadow, "archive", n)))])).toEqual(archives);
    expect(statSync(f.output).mode & 0o777).toBe(0o700); expect(statSync(join(f.output, "quality.jsonl")).mode & 0o777).toBe(0o600);
    const second = join(f.root, "second"); expect(run(f, second).status).toBe(0);
    const again = JSON.parse(readFileSync(join(second, "manifest.json"), "utf8")); expect(again.selected).toEqual(manifest.selected); expect(again.sources).toEqual(manifest.sources);
    const original = readFileSync(join(f.output, "quality.jsonl")); expect(run(f).stderr).toContain("output_exists"); expect(readFileSync(join(f.output, "quality.jsonl"))).toEqual(original);
  });

  it.each(["policy", "source", "topic", "count", "duplicate", "adapter", "window"])("fails closed on %s request mismatch", async (kind) => {
    const f = await fixture();
    if (kind === "policy") f.request.sources[0].policy_version = "other";
    if (kind === "source") f.request.sources[0].source_id = "missing";
    if (kind === "topic") f.request.topic.id = "unbound";
    if (kind === "count") f.request.per_source = 3;
    if (kind === "duplicate") f.request.sources.push(f.request.sources[0]);
    if (kind === "adapter") f.request.sources[0].adapter_version = "future-adapter";
    if (kind === "window") f.request.time_window.end = "2026-09-24T00:00:00.000Z";
    const codes: Record<string, string> = { policy: "insufficient_source_transcripts", source: "source_topic_mismatch", topic: "source_topic_mismatch", count: "insufficient_source_transcripts", duplicate: "duplicate_source", adapter: "request_invalid", window: "time_window_invalid" };
    fails(f, codes[kind]);
  });

  it.each(["payload", "body", "episode", "schema", "mime", "page"])("rejects archive %s corruption even with a valid filename and fact identity", async (kind) => {
    const f = await fixture();
    rewriteEvidence(f, (e) => {
      if (kind === "payload") e.transcript.raw_payload += "tampered";
      if (kind === "body") e.transcript.cleaned_body_sha256 = "a".repeat(64);
      if (kind === "episode") e.episode.url = "https://wrong.example/episode";
      if (kind === "schema") e.schema_version = "future";
      if (kind === "mime") e.transcript.content_type = "application/json";
      if (kind === "page") e.program_page.stable_url = "https://wrong.example/episode";
    });
    const codes: Record<string, string> = { payload: "archive_payload_hash_mismatch", body: "cleaned_body_hash_mismatch", episode: "episode_binding_mismatch", schema: "envelope_schema_invalid", mime: "transcript_mime_unsupported", page: "episode_binding_mismatch" };
    fails(f, codes[kind]);
  });

  it.each(["missing", "symlink", "escape", "wal", "missing-db"])("rejects %s input without creating output", async (kind) => {
    const f = await fixture(), fact = firstSuccess(f), path = join(f.shadow, fact.raw_ref!);
    if (kind === "missing") rmSync(path);
    if (kind === "symlink") { const outside = join(f.root, "outside.json"); writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path); }
    if (kind === "escape") retry(f, { raw_ref: "../outside.json" });
    if (kind === "wal") writeFileSync(f.dbPath + "-wal", "");
    if (kind === "missing-db") rmSync(f.dbPath);
    fails(f);
    if (kind === "missing-db") expect(existsSync(f.dbPath)).toBe(false);
  });

  it("refuses an undeclared or non-isolated root and output under the snapshot", async () => {
    const f = await fixture();
    expect(run(f, f.output, "").status).not.toBe(0);
    expect(run(f, join(f.shadow, "output")).status).not.toBe(0);
    const alias = join(f.root, "alias"); symlinkSync(f.shadow, alias); f.request.shadow_root = alias; fails(f, "symlink_not_allowed");
  });

  it("does not reuse a successful archive after a later failed or pending attempt", async () => {
    const f = await fixture(); retry(f, { outcome: "parse_empty", evidence_status: "failed", raw_ref: null }); fails(f, "insufficient_source_transcripts");
    const pending = await fixture(); const old = firstSuccess(pending), db = new Database(pending.dbPath);
    const row = { ...old, stage: "attempt" as const, attempt: 2, outcome: "not_attempted" as const, evidence_status: "pending" as const, raw_ref: null };
    appendTranscriptAcquisitionFact(db, { ...row, event_key: transcriptAcquisitionEventKey(row) }); db.close();
    fails(pending, "insufficient_source_transcripts");
  });

  it("rejects persisted conflicting acquisition facts", async () => {
    const f = await fixture(), fact = firstSuccess(f), db = new Database(f.dbPath);
    expect(() => appendTranscriptAcquisitionFact(db, { ...fact, reason_code: "changed" })).toThrow(); db.close();
    fails(f, "fact_conflict");
  });

  it("reconstructs VTT through the same pure cleaner and ContentItem normalizer", async () => {
    const f = await fixture(); const raw = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${body}\n`;
    rewriteEvidence(f, (e) => { e.transcript.raw_payload = raw; e.transcript.archived_payload_sha256 = sha(raw); e.transcript.cleaned_body_sha256 = sha(stripTranscript(raw)); e.transcript.content_type = "text/vtt"; });
    const result = run(f); expect(result.status, result.stderr).toBe(0);
    const quality = JSON.parse(readFileSync(join(f.output, "quality.jsonl"), "utf8"));
    const expected = rawToContentItem({ url: "https://src_a.example/1", title: "Agent 1", author: null, published_at: at, body: stripTranscript(raw), body_kind: "transcript", raw: "" }, f.sources[0], at);
    expect(quality.items[0].body).toBe(expected.body); expect(quality.items[0].content_hash).toBe(expected.content_hash);
  });
  it("rejects cross-source duplicate episodes rather than inflating the sample", async () => {
    const f = await fixture(true); fails(f, "duplicate_episode");
  });

  it("rejects byte-corrupted archive identity before reading it as a transcript", async () => {
    const f = await fixture(), fact = firstSuccess(f);
    const path = join(f.shadow, fact.raw_ref!);
    const data = JSON.parse(readFileSync(path, "utf8")); data.episode.title = "swapped title";
    writeFileSync(path, JSON.stringify(data)); fails(f, "archive_identity_mismatch");
  });

  it("rejects a changed fact payload even if the SQLite file opens normally", async () => {
    const f = await fixture(), fact = firstSuccess(f), db = new Database(f.dbPath);
    db.exec("DROP TRIGGER transcript_acquisition_fact_no_update");
    db.prepare("UPDATE transcript_acquisition_fact SET reason_code='tampered' WHERE event_key=?").run(fact.event_key);
    db.close(); fails(f, "fact_payload_hash_mismatch");
  });

  it("does not migrate an incompatible shadow database", async () => {
    const f = await fixture(); rmSync(f.dbPath);
    const db = new Database(f.dbPath); db.exec("CREATE TABLE old_schema(id INTEGER)"); db.close();
    const before = sha(readFileSync(f.dbPath)); fails(f, "input_or_output_invalid");
    expect(sha(readFileSync(f.dbPath))).toBe(before);
  });

  it("rejects a symlinked request file before parsing", async () => {
    const f = await fixture(), actual = join(f.root, "actual.json"), alias = join(f.root, "alias.json");
    writeFileSync(actual, JSON.stringify(f.request)); symlinkSync(actual, alias);
    const result = run(f, f.output, f.root, alias);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("symlink_not_allowed"); expect(existsSync(f.output)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO request without blocking", async () => {
    const f = await fixture(), fifo = join(f.root, "request.pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const result = run(f, f.output, f.root, fifo);
    expect(result.status).toBe(1); expect(result.stderr).toContain("input_type_invalid"); expect(existsSync(f.output)).toBe(false);
  });

  it("rejects a cleanly closed real shadow WAL snapshot before creating any sidecars", async () => {
    const f = await fixture(false, false);
    const before = readFileSync(f.dbPath); expect(before[18]).toBe(2); expect(before[19]).toBe(2);
    const files = readdirSync(f.shadow).sort(); expect(files).toEqual(["archive", "shadow.db"]);
    fails(f, "delete_journal_snapshot_required"); fails(f, "delete_journal_snapshot_required");
    expect(readdirSync(f.shadow).sort()).toEqual(files); expect(readFileSync(f.dbPath)).toEqual(before);
  });

});

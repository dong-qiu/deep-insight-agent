import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openReadonlyDb, type DB } from "../src/lib/db/connection.js";
import { queryReportIndex } from "../src/lib/db/reports.js";
import { loadTopicInsights } from "../src/lib/db/graph.js";
import { bundlePage, repo } from "./d3-report-list-bundle.js";
import { assertPage, cardIds, protocol, samplePage, summarizeRounds, validateOutputPath } from "./d3-report-list-benchmark.js";
import { observe, setBenchmarkDb, stats } from "./d3-report-list-runtime.js";
import { assertRows, assertSnapshotUnchanged, conditions, createReportListFixture, filesIdentity, matches, type Fixture } from "./fixtures/d3-report-list.js";

let db: DB;
vi.mock("../src/lib/db/index.js", async original => ({ ...await original<typeof import("../src/lib/db/index.js")>(), getDb: () => db }));
import ReportsPage from "../src/app/reports/page.js";
let directory: string, fixture: Fixture;
let plain: Awaited<ReturnType<typeof bundlePage>>, observed: Awaited<ReturnType<typeof bundlePage>>;
const priorData = process.env.DATA_DIR;
beforeAll(async () => {
  mkdirSync(resolve(repo, ".cache"), { recursive: true });
  directory = mkdtempSync(resolve(repo, ".cache/d3-report-list-test-"));
  const root = resolve(directory, "fixture"); mkdirSync(root);
  fixture = createReportListFixture(root, 50);
  process.env.DATA_DIR = root;
  db = openReadonlyDb(fixture.dbPath); setBenchmarkDb(db);
  plain = await bundlePage(directory, false); observed = await bundlePage(directory, true);
}, 15_000);
afterAll(() => {
  db?.close(); setBenchmarkDb(undefined);
  if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("uses real schema/FK, standalone readonly contract and zero snapshot writes", async () => {
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
  expect(db.pragma("query_only", { simple: true })).toBe(1);
  expect(() => db.exec("DELETE FROM report")).toThrow();
  const before = filesIdentity(fixture.root), mtime = statSync(fixture.dbPath).mtimeMs;
  await samplePage(plain.page, {});
  assertSnapshotUnchanged(fixture.root, before, db);
  expect(statSync(fixture.dbPath).mtimeMs).toBe(mtime);
});

it.each(conditions)("executes authentic page and card/render/filter path: $name", async ({ params }) => {
  const direct = await samplePage(ReportsPage, params), a = await samplePage(plain.page, params);
  const b = await observe(db, fixture.root, () => samplePage(observed.page, params));
  expect(a.markup).toBe(direct.markup); expect(b.result.markup).toBe(a.markup);
  assertPage(a.markup, fixture, db, params);
  expect(Object.values(b.observation.sql).reduce((n, s) => n + s.calls, 0)).toBe(14);
  expect(Object.keys(b.observation.fs)).toEqual([]);
  expect(b.observation.functions.reportReaderVisibilitySql?.calls).toBe(4);
  expect(b.observation.functions.reportRedactionVisibilitySql?.calls).toBe(4);
  expect(b.observation.functions.rowToIndex?.calls ?? 0).toBe(cardIds(a.markup).length);
  expect(a.totalMs).toBeGreaterThan(0);
});

it("FS observer catches real archive reads and fail-closed errors; historical list keeps snapshots", async () => {
  const current = await observe(db, fixture.root, () => loadTopicInsights(db, "topic-0"));
  expect(current.result.map(r => r.id)).toEqual(["insight-valid"]);
  expect(current.observation.fs.readFileSync?.bytes).toBeGreaterThan(0);
  expect(current.observation.fs.openSync?.errors).toBeGreaterThan(0);
  const list = queryReportIndex(db);
  expect(new Set(list.map(r => r.report_id))).toEqual(new Set(fixture.records.filter(r => r.visible).map(r => r.entry.report_id)));
  expect(fixture.records.filter(r => r.visible && r.mode >= 1 && r.mode <= 6).every(r => list.some(x => x.report_id === r.entry.report_id))).toBe(true);
  for (const row of db.prepare("SELECT insight_ids FROM report WHERE status='done'").all() as Array<{ insight_ids: string }>) {
    expect(row.insight_ids).not.toMatch(/blocked|unchecked/);
  }
  const failure = await observe(db, fixture.root, () => {
    expect(() => readFileSync(resolve(fixture.root, "raw/does-not-exist"))).toThrow();
  });
  expect(failure.observation.fs.readFileSync?.errors).toBe(1);
});

it("observer restores FS and connection and never swallows callback errors", async () => {
  const before = readFileSync;
  await expect(observe(db, fixture.root, () => { throw new Error("sentinel"); })).rejects.toThrow("sentinel");
  expect(readFileSync).toBe(before);
  expect((await samplePage(plain.page, {})).markup).toContain("报告库");
  const failedDb = openReadonlyDb(fixture.dbPath); failedDb.close();
  await expect(observe(failedDb, fixture.root, () => samplePage(observed.page, {}))).rejects.toThrow();
});

it("has deterministic logical/schema/ledger identity while rejecting existing or invalid fixture targets", () => {
  const otherRoot = resolve(directory, "other"); mkdirSync(otherRoot);
  const other = createReportListFixture(otherRoot, 50);
  expect(other.logicalHash).toBe(fixture.logicalHash);
  expect(other.schemaHash).toBe(fixture.schemaHash);
  expect(other.ledgerHash).toBe(fixture.ledgerHash);
  expect(() => createReportListFixture(otherRoot, 50)).toThrow("new empty");
  const invalidRoot = resolve(directory, "invalid"); mkdirSync(invalidRoot);
  expect(() => createReportListFixture(invalidRoot, NaN)).toThrow("invalid fixture");
});

it("rejects missing, duplicated and incorrect top-k results including FTS boundary; preserves real reader limits", () => {
  const root = resolve(directory, "large"); mkdirSync(root);
  const large = createReportListFixture(root, 1200), connection = openReadonlyDb(large.dbPath);
  try {
    const rows = queryReportIndex(connection);
    expect(rows).toHaveLength(100); assertRows(large, connection, rows, {});
    expect(() => assertRows(large, connection, rows.slice(1), {})).toThrow();
    expect(() => assertRows(large, connection, [rows[0]!, ...rows.slice(0, -1)], {})).toThrow();
    const all = queryReportIndex(connection, { limit: 500 });
    expect(all).toHaveLength(500);
    assertRows(large, connection, all, {}, 500);
    expect(queryReportIndex(connection, { limit: 0 })).toHaveLength(1);
    expect(queryReportIndex(connection, { limit: 900 })).toHaveLength(all.length);
    expect(() => assertRows(large, connection, all.slice(-100), {})).toThrow("better ranked");
    const fts = queryReportIndex(connection, { q: "raretoken", limit: 500 });
    expect(fts).toHaveLength(matches(large, { q: "raretoken" }).length);
    assertRows(large, connection, fts.slice(0, 100), { q: "raretoken" });
    expect(() => assertRows(large, connection, fts.slice(1), { q: "raretoken" })).toThrow();
    const wrong = fts.map(r => ({ ...r, snippet: "raretoken" }));
    expect(() => assertRows(large, connection, wrong, { q: "raretoken" })).toThrow();
    // Higher/lower score corruption must be rejected even when the returned subset is internally sorted.
    const ranked = queryReportIndex(connection, { q: "raretoken" });
    assertRows(large, connection, ranked, { q: "raretoken" });
    expect(() => assertRows(large, connection, fts.slice(-100), { q: "raretoken" })).toThrow("better ranked");
  } finally { connection.close(); }
});

it("pins sample plan, validates statistics/noise, and rejects invalid numbers and public outputs", () => {
  expect(protocol).toMatchObject({ rounds: 3, warmup: 10, samples: 40, diagnosticPairs: 40, scales: [50, 400, 1200, 2400] });
  expect(stats(Array.from({ length: 40 }, (_, i) => i + 1))).toMatchObject({ n: 40, p50: 20, p95: 38, min: 1, max: 40, iqr: 20, mad: 10 });
  expect(() => stats([1])).toThrow(); expect(() => stats(Array(40).fill(NaN))).toThrow();
  const round = (total: number) => ({ samples: Array.from({ length: 40 }, () => ({ totalMs: total, pageMs: total / 2, renderMs: total / 2 })) });
  expect(summarizeRounds([round(1), round(1), round(1)]).noisy).toBe(false);
  expect(summarizeRounds([round(1), round(1.2), round(1)]).noisy).toBe(true);
  expect(() => validateOutputPath("evals/fixtures/results.json")).toThrow();
  expect(() => validateOutputPath("evals/out/d3-report-list/../escape.json")).toThrow();
  assert(validateOutputPath("evals/out/d3-report-list/test.json"));
  expect(plain.identity.rewrites).toEqual([]);
  expect(observed.identity.rewrites).toHaveLength(4);
  expect(observed.identity.sources).toEqual(plain.identity.sources);
});

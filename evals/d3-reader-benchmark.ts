/** Offline synthetic full-reader A/B; never reads DB_PATH/.env or contacts a provider. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { openReadonlyDb, type DB } from "../src/lib/db/connection.js";
import * as production from "../src/lib/db/graph.js";
import { createD3Fixture, fixtureVersion, since } from "./fixtures/d3-reader.js";
import { digest, loadFrozenD3 } from "./fixtures/d3-frozen.js";

type Reader = typeof production;
const conditions = ["node-all", "node-window", "edge-all", "empty"] as const;
type Condition = typeof conditions[number];
function read(reader: Reader, db: DB, condition: Condition) {
  if (condition === "edge-all") return reader.insightsCooccurring(db, "target", "Atlas", "Beacon");
  return reader.insightsMentioningEntity(db, condition === "empty" ? "empty" : "target", "Atlas", condition === "node-window" ? since : undefined);
}
function payload(reader: Reader, db: DB, condition: Condition) {
  return JSON.stringify({ items: reader.groupDrillInsights(read(reader, db, condition), reader.reportLinksByInsight(db, condition === "empty" ? "empty" : "target")) });
}
const quantile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.ceil(p * samples.length) - 1]!;
function diagnostics(reader: Reader, db: DB, condition: Condition) {
  const statements = new Map<string, { executions: number; ms: number; plan: unknown[] }>();
  const instrumented = new Proxy(db, { get(target, prop) {
    if (prop !== "prepare") { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; }
    return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, member) {
        const value = Reflect.get(stmt, member);
        if (member !== "all" && member !== "get") return typeof value === "function" ? value.bind(stmt) : value;
        return (...args: unknown[]) => {
          const start = performance.now();
          const result = (value as (...a: unknown[]) => unknown).apply(stmt, args);
          const ms = performance.now() - start;
          let entry = statements.get(sql);
          if (!entry) {
            entry = { executions: 0, ms: 0, plan: sql.trim().startsWith("SELECT") ? target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) : [] };
            statements.set(sql, entry);
          }
          entry.executions++; entry.ms += ms;
          return result;
        };
      } });
    };
  } });
  const start = performance.now();
  const result = read(reader, instrumented, condition);
  return { wallMs: performance.now() - start, returned: result.length,
    citationQueries: [...statements].filter(([sql]) => /^SELECT \* FROM citation WHERE insight_id/.test(sql)).reduce((n, [, value]) => n + value.executions, 0),
    statements: [...statements].map(([sql, value]) => ({ sql, ...value })) };
}

const sourcePaths = ["src/lib/db/graph.ts", "src/lib/db/analysis.ts", "evals/fixtures/d3-reader.ts", "evals/fixtures/d3-frozen.ts", "evals/d3-reader-benchmark.ts", "evals/fixtures/d3-citation-batch.patch"];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(path))]));
const hashesAtStart = sourceHashes();
const startedAt = new Date().toISOString();
let sqliteVersion: unknown;
const output = process.argv[2];
if (!output) throw new Error("Usage: tsx evals/d3-reader-benchmark.ts <output.json> [--trial]");
mkdirSync(dirname(output), { recursive: true });
let frozen: Awaited<ReturnType<typeof loadFrozenD3>> | undefined;
let trial: Awaited<ReturnType<typeof loadFrozenD3>> | undefined;
const prior = process.env.DATA_DIR;
const results = [];
try {
  frozen = await loadFrozenD3();
  trial = process.argv.includes("--trial") ? await loadFrozenD3(true) : undefined;
  const current = trial?.graph ?? production;
  for (const size of [50, 400, 1200, 2400]) {
    const root = mkdtempSync(join(tmpdir(), "d3-benchmark-"));
    process.env.DATA_DIR = root;
    const fixture = createD3Fixture(root, size);
    const db = openReadonlyDb(fixture.dbPath);
    sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get();
    const before = digest(readFileSync(fixture.dbPath));
    const changes = db.prepare("SELECT total_changes() AS n").get();
    try {
      for (const condition of conditions) {
        // First-read: baseline first, before correctness; OS cache is not controlled.
        const firstReadMs = [frozen.graph, current].map(reader => {
          const start = performance.now(); read(reader, db, condition); return performance.now() - start;
        });
        const old = read(frozen.graph, db, condition);
        const value = read(current, db, condition);
        const expected = fixture.expected.filter(id => condition === "empty" ? false : condition === "edge-all"
          ? Number(id.split("-i")[1]) % 2 === 0 : condition === "node-window" ? Math.floor(Number(id.split("-i")[1]) / 12) % 6 >= 1 : true);
        assert.deepEqual(old.map(i => i.id), expected);
        assert.deepEqual(value, old);
        assert.equal(payload(current, db, condition), payload(frozen.graph, db, condition));
        const rounds: Array<{
          samples: Record<"baseline" | "current", Record<"reader" | "payload", number[]>>;
          percentiles: Record<string, Record<string, { p50: number; p95: number }>>;
        }> = [];
        for (let round = 0; round < 3; round++) {
          for (let n = 0; n < 10; n++) for (const reader of [frozen.graph, current]) { read(reader, db, condition); payload(reader, db, condition); }
          const samples = { baseline: { reader: [] as number[], payload: [] as number[] }, current: { reader: [] as number[], payload: [] as number[] } };
          for (let n = 0; n < 40; n++) for (const label of (n + round) % 2 === 0 ? ["baseline", "current"] as const : ["current", "baseline"] as const) {
            const reader = label === "baseline" ? frozen.graph : current;
            let start = performance.now(); read(reader, db, condition); samples[label].reader.push(performance.now() - start);
            start = performance.now(); payload(reader, db, condition); samples[label].payload.push(performance.now() - start);
          }
          const percentiles = Object.fromEntries(Object.entries(samples).map(([label, paths]) => [label,
            Object.fromEntries(Object.entries(paths).map(([path, values]) => [path, { p50: quantile(values, 0.5), p95: quantile(values, 0.95) }]))]));
          rounds.push({ samples, percentiles });
        }
        results.push({ size, condition, fixture, firstReadMs, returned: value.length, resultHash: digest(JSON.stringify(old)),
          diagnostics: { baseline: diagnostics(frozen.graph, db, condition), current: diagnostics(current, db, condition) }, rounds,
          summary: Object.fromEntries((["baseline", "current"] as const).map(label => [label,
            Object.fromEntries((["reader", "payload"] as const).map(path => [path, {
              p50: quantile(rounds.map(r => quantile(r.samples[label][path], 0.5)), 0.5),
              p95: quantile(rounds.map(r => quantile(r.samples[label][path], 0.95)), 0.5),
            }]))])) });
        console.log(JSON.stringify({ size, condition, returned: value.length, queries: results.at(-1)!.diagnostics } , (key, value) => key === "statements" ? undefined : value));
      }
      assert.deepEqual(db.prepare("SELECT total_changes() AS n").get(), changes);
      assert.equal(digest(readFileSync(fixture.dbPath)), before);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  assert.deepEqual(sourceHashes(), hashesAtStart);
  writeFileSync(output, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), sqliteVersion, version: "d3-reader-benchmark-v1", fixtureVersion, timing: "single synchronous full call; warm OS/SQLite; stationary DB; no concurrency",
    warmups: 10, samples: 40, rounds: 3, quantile: "nearest-rank", identity: frozen.identity,
    candidate: { mode: trial ? "offline-citation-batch-trial" : "production", trialIdentity: trial?.identity, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      hashes: hashesAtStart },
    environment: { node: process.version, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), platform: platform(), release: release(), arch: arch() }, results }, null, 2));
} finally {
  if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior;
  if (frozen) rmSync(frozen.directory, { recursive: true, force: true });
  if (trial) rmSync(trial.directory, { recursive: true, force: true });
}

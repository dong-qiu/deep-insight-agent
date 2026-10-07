/** Fixed, offline, single-hotspot baseline. No .env, user DB, provider or production entry. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { openReadonlyDb, type DB } from "../src/lib/db/connection.js";
import { queryReportIndex, distinctIndexValues } from "../src/lib/db/reports.js";
import { bundlePage, repo, type Page } from "./d3-report-list-bundle.js";
import { median, observe, setBenchmarkDb, stats, type Observation } from "./d3-report-list-runtime.js";
import { assertRows, assertSnapshotUnchanged, conditions, createReportListFixture, digest, filesIdentity, matches, sizes, type Fixture } from "./fixtures/d3-report-list.js";

export const protocol = { version: "d3-report-list-v1", rounds: 3, warmup: 10, samples: 40, diagnosticPairs: 40,
  scales: sizes, conditions, order: "ascending scales; round-rotated conditions; alternating diagnostic pair order" } as const;
export async function samplePage(page: Page, params: Record<string, string>) {
  const start = performance.now();
  const tree = await page({ searchParams: Promise.resolve(params) });
  const assembled = performance.now();
  const markup = renderToStaticMarkup(tree);
  const end = performance.now();
  return { totalMs: end - start, pageMs: assembled - start, renderMs: end - assembled, markup };
}
export function cardIds(markup: string) { return [...markup.matchAll(/href="\/reports\/(rep_[a-f0-9]+)"/g)].map(m => m[1]!); }
export function assertPage(markup: string, fixture: Fixture, db: DB, params: Record<string, string>) {
  const rows = queryReportIndex(db, params);
  assertRows(fixture, db, rows, params);
  assert.deepEqual(cardIds(markup), rows.map(r => r.report_id));
  for (const column of ["source_ids", "tags", "entity_names"] as const) {
    const expected = [...new Set(fixture.records.filter(r => r.visible).flatMap(r => r.entry[column]))].sort();
    assert.deepEqual(distinctIndexValues(db, column), expected);
  }
  assert(!markup.includes("hidden-source-") && !markup.includes("hidden-tag-") && !markup.includes("hidden-entity-"));
  assert(markup.includes("retired-source"), "missing historical source fallback");
}
function sourceIdentity() {
  const paths = ["package.json", "package-lock.json", "docs/plan/specs/d3-report-list-measurement.md",
    "evals/d3-report-list-benchmark.ts", "evals/d3-report-list-bundle.ts", "evals/d3-report-list-runtime.ts", "evals/fixtures/d3-report-list.ts",
    "src/lib/db/schema.ts", "src/lib/db/startup.ts", "src/lib/db/connection.ts", "src/lib/db/legacy-bootstrap.ts",
    "src/lib/db/migration-runner.ts", "src/lib/db/migration-definitions.ts", "src/lib/db/migration-ledger.ts", "src/lib/db/raw-archive.ts",
    "src/lib/db/analysis.ts", "src/lib/db/repos.ts", "src/lib/db/provenance-migrations.ts"];
  return Object.fromEntries(paths.map(path => [path, digest(readFileSync(resolve(repo, path)))]));
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
/** Inspect command lines locally, disclose only known workload labels/pids, never arbitrary arguments. */
export function hostState() {
  const heavy: Array<{ pid: number; kind: string }> = [];
  const patterns = [
    ["build", /(?:^|\s)(?:[^\s]*\/)?(?:node\s+[^\n]*next[^\n]*\sbuild|npm\s+run\s+build)/],
    ["test", /(?:^|\s)(?:[^\s]*\/)?(?:node\s+[^\n]*(?:vitest|playwright)|npm\s+run\s+test|npm\s+test)/],
    ["typecheck-or-lint", /(?:^|\s)(?:[^\s]*\/)?(?:node\s+[^\n]*(?:\/tsc|eslint)|npm\s+run\s+(?:typecheck|lint))/],
    ["dependency-install", /(?:^|\s)(?:[^\s]*\/)?npm\s+ci(?:\s|$)/],
  ] as const;
  for (const line of execFileSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" }).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !/(?:node|npm|vitest|next|playwright)$/.test(m[2]!)) continue;
    for (const [kind, pattern] of patterns) if (pattern.test(m[3]!)) { heavy.push({ pid: Number(m[1]), kind }); break; }
  }
  return { at: new Date().toISOString(), loadavg: loadavg(), heavy };
}
function quietHost() { const host = hostState(); assert.equal(host.heavy.length, 0, "known heavy workload: sampling stopped"); return host; }
type Sample = { totalMs: number; pageMs: number; renderMs: number };
export function summarizeRounds(rounds: Array<{ samples: Sample[] }>) {
  assert.equal(rounds.length, 3);
  const perRound = rounds.map(r => ({ total: stats(r.samples.map(s => s.totalMs)), page: stats(r.samples.map(s => s.pageMs)), render: stats(r.samples.map(s => s.renderMs)) }));
  return { perRound, totalP50: median(perRound.map(r => r.total.p50)), totalP95: median(perRound.map(r => r.total.p95)),
    pageP50: median(perRound.map(r => r.page.p50)), renderP50: median(perRound.map(r => r.render.p50)),
    noisy: Math.max(...perRound.map(r => r.total.p50)) / Math.min(...perRound.map(r => r.total.p50)) > 1.15
      || perRound.some(r => r.total.p95 / r.total.p50 > 1.5) };
}
function summarizeObservations(entries: Observation[], db: DB) {
  const sqls = [...new Set(entries.flatMap(e => Object.keys(e.sql)))];
  const functions = [...new Set(entries.flatMap(e => Object.keys(e.functions)))];
  return {
    functions: Object.fromEntries(functions.map(name => [name, { calls: entries[0]!.functions[name]!.calls,
      medianMs: median(entries.map(e => e.functions[name]!.ms)) }])),
    queriesPerRead: Object.values(entries[0]!.sql).reduce((n, s) => n + s.calls, 0),
    logicalBytesPerRead: Object.values(entries[0]!.sql).reduce((n, s) => n + s.logicalBytes, 0),
    sql: sqls.map(sql => ({ sql, calls: entries[0]!.sql[sql]!.calls, rows: entries[0]!.sql[sql]!.rows,
      logicalBytes: entries[0]!.sql[sql]!.logicalBytes, medianExecuteMs: median(entries.map(e => e.sql[sql]!.ms)),
      medianPrepareMs: median(entries.map(e => e.sql[sql]!.prepareMs)),
      plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...entries[0]!.sql[sql]!.args) })),
    fsCallsPerRead: Object.values(entries[0]!.fs).reduce((n, e) => n + e.calls, 0),
    fsBytesPerRead: Object.values(entries[0]!.fs).reduce((n, e) => n + e.bytes, 0),
    errors: entries.reduce((n, e) => n + Object.values(e.sql).reduce((m, x) => m + x.errors, 0)
      + Object.values(e.fs).reduce((m, x) => m + x.errors, 0) + Object.values(e.functions).reduce((m, x) => m + x.errors, 0), 0),
  };
}
export function validateOutputPath(path: string) {
  const abs = resolve(repo, path), allowed = resolve(repo, "evals/out/d3-report-list");
  assert(relative(allowed, abs) && !relative(allowed, abs).startsWith("..") && abs.endsWith(".json"), "output must be private evals/out/d3-report-list/*.json");
  return abs;
}

export async function runBenchmark(outputPath: string) {
  const output = validateOutputPath(outputPath);
  assert(!existsSync(output), "output already exists; do not overwrite prior evidence");
  assert(/^v24\.19\.0$/.test(process.version), "use pinned Node v24.19.0");
  assert.equal(execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), "11.17.0");
  const previousMask = process.umask(0o077), priorData = process.env.DATA_DIR;
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(dirname(output)), dirname(output), "private output directory cannot use symlinks");
  chmodSync(dirname(output), 0o700);
  mkdirSync(resolve(repo, ".cache/d3-report-list"), { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(resolve(repo, ".cache/d3-report-list/run-"));
  const startedAt = new Date().toISOString(), hashes = sourceIdentity();
  const results: Array<Record<string, unknown>> = [];
  const require = createRequire(import.meta.url);
  const dependencies = Object.fromEntries(["better-sqlite3", "esbuild", "react", "react-dom", "next", "tsx"].map(name => [name, require(`${name}/package.json`).version as string]));
  const evidence: Record<string, unknown> = { protocol, startedAt, directory, status: "running", results, sourceHashes: hashes,
    dependencies, sqliteBindingHash: digest(readFileSync(resolve(repo, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"))),
    base: "41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1", head: git("rev-parse", "HEAD"), gitStatus: git("status", "--short"),
    environment: { node: process.version, npm: "11.17.0", os: platform(), release: release(), arch: arch(),
      cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem() } };
  let active: DB | undefined;
  try {
    const plain = await bundlePage(directory, false), observed = await bundlePage(directory, true);
    assert.deepEqual(plain.identity.sources, observed.identity.sources);
    evidence.bundles = { plain: plain.identity, observed: observed.identity };
    for (const size of sizes) {
      const root = mkdtempSync(resolve(directory, `fixture-${size}-`)), fixture = createReportListFixture(root, size);
      process.env.DATA_DIR = root;
      const before = filesIdentity(root), beforeMtime = statSync(fixture.dbPath).mtimeMs;
      const openStart = performance.now();
      const db = active = openReadonlyDb(fixture.dbPath), readonlyOpenMs = performance.now() - openStart;
      setBenchmarkDb(db);
      const sqlite = db.prepare("SELECT sqlite_version() AS version").get();
      const firstRead = await samplePage(plain.page, conditions[0]!.params);
      const firstReadMs = firstRead.totalMs;
      assertPage(firstRead.markup, fixture, db, conditions[0]!.params);
      const scale: Record<string, unknown> = { size, sqlite, fixture: { version: fixture.version, logicalHash: fixture.logicalHash,
        schemaHash: fixture.schemaHash, ledgerHash: fixture.ledgerHash, filesHash: digest(JSON.stringify(before)),
        dbHash: digest(readFileSync(fixture.dbPath)), dbBytes: statSync(fixture.dbPath).size,
        files: before, buildMs: fixture.buildMs, readonlyOpenMs, firstReadMs, visibleCount: fixture.visibleCount }, conditions: [] };
      results.push(scale);
      const records = conditions.map(condition => ({ name: condition.name, params: condition.params,
        matched: matches(fixture, condition.params).length, outputCount: 0, outputHash: "", markupBytes: 0,
        rounds: [] as Array<{ round: number; hostStart: ReturnType<typeof hostState>; hostEnd: ReturnType<typeof hostState>; samples: Sample[] }>,
        diagnostic: undefined as unknown }));
      scale.conditions = records;
      for (const record of records) {
        const read = await samplePage(plain.page, record.params);
        assertPage(read.markup, fixture, db, record.params);
        record.outputHash = digest(read.markup); record.outputCount = cardIds(read.markup).length; record.markupBytes = Buffer.byteLength(read.markup);
      }
      for (let round = 0; round < protocol.rounds; round++) for (let offset = 0; offset < records.length; offset++) {
        const record = records[(offset + round) % records.length]!;
        const hostStart = quietHost();
        for (let n = 0; n < protocol.warmup; n++) assert.equal(digest((await samplePage(plain.page, record.params)).markup), record.outputHash);
        const samples: Sample[] = [], item = { round, hostStart, hostEnd: hostStart, samples };
        record.rounds.push(item);
        for (let n = 0; n < protocol.samples; n++) {
          const read = await samplePage(plain.page, record.params);
          samples.push({ totalMs: read.totalMs, pageMs: read.pageMs, renderMs: read.renderMs });
          assert.equal(digest(read.markup), record.outputHash, "output changed during sampling");
        }
        item.hostEnd = quietHost();
        console.log(`baseline ${size}/${record.name} round ${round + 1}: n=${samples.length}`);
      }
      // Separate diagnostic pairs; no production candidate or baseline sampling instrumentation.
      for (const record of records) {
        const hostStart = quietHost();
        for (let n = 0; n < protocol.warmup; n++) await observe(db, root, () => samplePage(observed.page, record.params));
        const pairs: Array<{ plain: Sample; observed: Sample; observation: Observation }> = [];
        for (let n = 0; n < protocol.diagnosticPairs; n++) {
          const plainRead = () => samplePage(plain.page, record.params);
          const observedRead = () => observe(db, root, () => samplePage(observed.page, record.params));
          const a = n % 2 ? await observedRead() : await plainRead();
          const b = n % 2 ? await plainRead() : await observedRead();
          const p = (n % 2 ? b : a) as Awaited<ReturnType<typeof plainRead>>;
          const o = (n % 2 ? a : b) as Awaited<ReturnType<typeof observedRead>>;
          assert.equal(digest(p.markup), record.outputHash); assert.equal(digest(o.result.markup), record.outputHash);
          const { markup: _p, ...plainSample } = p, { markup: _o, ...observedSample } = o.result;
          pairs.push({ plain: plainSample, observed: observedSample, observation: o.observation });
        }
        const deltaMs = median(pairs.map(p => p.observed.totalMs - p.plain.totalMs));
        const deltaRatio = median(pairs.map(p => (p.observed.totalMs - p.plain.totalMs) / p.plain.totalMs));
        record.diagnostic = { pairs, hostStart, hostEnd: quietHost(), deltaMs, deltaRatio,
          instrumentationWarning: deltaMs > 0.1 || deltaRatio > 0.05,
          summary: summarizeObservations(pairs.map(p => p.observation), db) };
        assert.equal((record.diagnostic as { summary: { errors: number } }).summary.errors, 0);
        (record as typeof record & { summary: ReturnType<typeof summarizeRounds> }).summary = summarizeRounds(record.rounds);
        console.log(`diagnostic ${size}/${record.name}: n=${pairs.length}, overhead=${deltaMs.toFixed(3)}ms`);
      }
      assertSnapshotUnchanged(root, before, db);
      assert.equal(statSync(fixture.dbPath).mtimeMs, beforeMtime);
      db.close(); active = undefined; setBenchmarkDb(undefined);
    }
    assert.deepEqual(sourceIdentity(), hashes, "source changed during run");
    evidence.status = "complete";
  } catch (error) {
    evidence.status = "failed";
    evidence.failure = { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown" };
    throw error;
  } finally {
    active?.close(); setBenchmarkDb(undefined);
    evidence.finishedAt = new Date().toISOString();
    try { writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    finally {
      process.umask(previousMask);
      if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
    }
  }
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Usage: tsx evals/d3-report-list-benchmark.ts evals/out/d3-report-list/<new-file>.json");
  await runBenchmark(process.argv[2]!);
}

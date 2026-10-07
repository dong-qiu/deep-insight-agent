/** Publish aggregates only. Individual samples, file manifests and machine paths stay private. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { protocol, summarizeRounds } from "./d3-report-list-benchmark.js";
import { repo } from "./d3-report-list-bundle.js";
import { median, type Observation } from "./d3-report-list-runtime.js";
import { digest } from "./fixtures/d3-report-list.js";

type Sample = { totalMs: number; pageMs: number; renderMs: number };
type Pair = { plain: Sample; observed: Sample; observation: Observation };
interface Raw {
  status: string; base: string; head: string; startedAt: string; finishedAt: string;
  protocol: typeof protocol; environment: unknown; dependencies: unknown; sqliteBindingHash: string;
  sourceHashes: Record<string, string>;
  bundles: { plain: { sources: Record<string, string>; bundleHash: string }; observed: { sources: Record<string, string>; bundleHash: string; rewrites: unknown } };
  results: Array<{ size: number; sqlite: unknown; fixture: {
    version: string; logicalHash: string; schemaHash: string; ledgerHash: string; filesHash: string; dbHash: string; dbBytes: number;
    buildMs: number; readonlyOpenMs: number; firstReadMs: number; visibleCount: number;
    files: Array<{ path: string; bytes: number; mode: number; sha256: string | null }>;
  }; conditions: Array<{ name: string; params: Record<string, string>; matched: number; outputCount: number; outputHash: string; markupBytes: number;
    rounds: Array<{ round: number; hostStart: { loadavg: number[]; heavy: unknown[] }; hostEnd: { loadavg: number[]; heavy: unknown[] }; samples: Sample[] }>;
    summary: ReturnType<typeof summarizeRounds>;
    diagnostic: { pairs: Pair[]; deltaMs: number; deltaRatio: number; instrumentationWarning: boolean; summary: {
      queriesPerRead: number; logicalBytesPerRead: number; fsCallsPerRead: number; fsBytesPerRead: number; errors: number;
      functions: Record<string, { calls: number; medianMs: number }>;
      sql: Array<{ sql: string; calls: number; rows: number; logicalBytes: number; medianExecuteMs: number; medianPrepareMs: number; plan: unknown[] }>;
    } };
  }> }>;
}

export function buildSummary(bytes: Buffer) {
  const raw = JSON.parse(bytes.toString("utf8")) as Raw;
  assert.equal(raw.status, "complete", "incomplete evidence");
  assert.deepEqual(raw.protocol, protocol, "protocol drift");
  assert.deepEqual(raw.results.map(r => r.size), [...protocol.scales]);
  const statementDefinitions: Record<string, string> = {}, queryPlans: Record<string, unknown[]> = {};
  const scales = raw.results.map(scale => {
    assert.deepEqual(scale.conditions.map(c => ({ name: c.name, params: c.params })), protocol.conditions);
    return { size: scale.size, sqlite: scale.sqlite, fixture: { version: scale.fixture.version, logicalHash: scale.fixture.logicalHash,
      schemaHash: scale.fixture.schemaHash, ledgerHash: scale.fixture.ledgerHash, filesHash: scale.fixture.filesHash,
      dbHash: scale.fixture.dbHash, dbBytes: scale.fixture.dbBytes, buildMs: scale.fixture.buildMs,
      readonlyOpenMs: scale.fixture.readonlyOpenMs, firstReadMs: scale.fixture.firstReadMs, visibleCount: scale.fixture.visibleCount,
      archiveFiles: scale.fixture.files.filter(f => f.path.startsWith("raw/")).length,
      archiveBytes: scale.fixture.files.filter(f => f.path.startsWith("raw/")).reduce((n, f) => n + f.bytes, 0),
      reportFiles: scale.fixture.files.filter(f => f.path.startsWith("reports/")).length,
      reportBytes: scale.fixture.files.filter(f => f.path.startsWith("reports/")).reduce((n, f) => n + f.bytes, 0) },
      conditions: scale.conditions.map(c => {
        assert.deepEqual(c.rounds.map(r => r.round), [0, 1, 2]);
        for (const round of c.rounds) {
          assert.equal(round.samples.length, protocol.samples);
          assert.equal(round.hostStart.heavy.length + round.hostEnd.heavy.length, 0);
        }
        const summary = summarizeRounds(c.rounds);
        assert.deepEqual(summary, c.summary, "stored statistics differ from raw samples");
        const pairs = c.diagnostic.pairs;
        assert.equal(pairs.length, protocol.diagnosticPairs);
        const facetMs = (p: Pair) => ["source_ids", "tags", "entity_names"].reduce((n, key) => n + p.observation.functions[`facet:${key}`]!.ms, 0);
        for (const p of pairs) {
          assert.equal(Object.values(p.observation.sql).reduce((n, s) => n + s.calls, 0), 14);
          assert.deepEqual(p.observation.fs, {});
          assert.equal(p.observation.functions.reportReaderVisibilitySql!.calls, 4);
          assert.equal(p.observation.functions.rowToIndex?.calls ?? 0, c.outputCount);
          assert.equal(Object.values(p.observation.sql).reduce((n, s) => n + s.errors, 0), 0);
        }
        const deltaMs = median(pairs.map(p => p.observed.totalMs - p.plain.totalMs));
        const deltaRatio = median(pairs.map(p => (p.observed.totalMs - p.plain.totalMs) / p.plain.totalMs));
        assert.equal(deltaMs, c.diagnostic.deltaMs); assert.equal(deltaRatio, c.diagnostic.deltaRatio);
        assert.equal(deltaMs > 0.1 || deltaRatio > 0.05, c.diagnostic.instrumentationWarning);
        assert.equal(c.outputCount, Math.min(100, c.matched));
        assert.equal(c.diagnostic.summary.errors, 0);
        const { sql, ...diagnosticCounts } = c.diagnostic.summary;
        const statements = sql.map(({ sql: template, plan, ...counts }) => {
          const templateHash = digest(template), planHash = digest(JSON.stringify(plan));
          statementDefinitions[templateHash] = template; queryPlans[planHash] = plan;
          return { templateHash, planHash, ...counts };
        });
        return { name: c.name, params: c.params, inputReports: scale.size, visibleReports: scale.fixture.visibleCount,
          matched: c.matched, outputCount: c.outputCount, visibilityRemovedRatio: 1 - scale.fixture.visibleCount / scale.size,
          filterRemovedRatio: 1 - c.matched / scale.fixture.visibleCount, limitRemoved: Math.max(0, c.matched - c.outputCount),
          outputHash: c.outputHash, markupBytes: c.markupBytes, baseline: summary,
          diagnostic: { pairedN: pairs.length, plainP50: median(pairs.map(p => p.plain.totalMs)), observedP50: median(pairs.map(p => p.observed.totalMs)),
            deltaMs, deltaRatio, instrumentationWarning: c.diagnostic.instrumentationWarning,
            facetDisjointCallsMedianMs: median(pairs.map(facetMs)),
            facetObservedWallFractionMedian: median(pairs.map(p => facetMs(p) / p.observed.totalMs)),
            queryAndNativeRowsMedianMs: median(pairs.map(p => Object.values(p.observation.sql).reduce((n, s) => n + s.ms, 0))),
            prepareMedianMs: median(pairs.map(p => Object.values(p.observation.sql).reduce((n, s) => n + s.prepareMs, 0))),
            ...diagnosticCounts, statements },
          loadavgRange: { min: Math.min(...c.rounds.flatMap(r => [r.hostStart.loadavg[0]!, r.hostEnd.loadavg[0]!])),
            max: Math.max(...c.rounds.flatMap(r => [r.hostStart.loadavg[0]!, r.hostEnd.loadavg[0]!])) },
        };
      }) };
  });
  return { version: "d3-report-list-summary-v1", scope: "synthetic readonly ReportsPage + React static markup; no Next request/HTTP/browser or optimization",
    rawSha256: digest(bytes), rawBytes: bytes.length, base: raw.base, measuredHead: raw.head, startedAt: raw.startedAt, finishedAt: raw.finishedAt,
    environment: raw.environment, dependencies: raw.dependencies, sqliteBindingHash: raw.sqliteBindingHash, protocol: raw.protocol,
    sourceHashes: raw.sourceHashes, bundleSources: raw.bundles.plain.sources,
    bundles: { plainHash: raw.bundles.plain.bundleHash, observedHash: raw.bundles.observed.bundleHash, rewrites: raw.bundles.observed.rewrites },
    statementDefinitions, queryPlans, scales };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, "Usage: tsx evals/d3-report-list-summary.ts <private-raw.json> <new-summary.json>");
  const summary = buildSummary(readFileSync(resolve(repo, process.argv[2]!)));
  writeFileSync(resolve(repo, process.argv[3]!), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

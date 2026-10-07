import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { repo } from "./d3-report-list-bundle.js";
import { protocol, summarizeRounds } from "./d3-report-list-benchmark.js";
import { buildSummary } from "./d3-report-list-summary.js";
import { digest } from "./fixtures/d3-report-list.js";

const artifact = JSON.parse(readFileSync(resolve(repo, "evals/fixtures/d3-report-list-baseline.v1.json"), "utf8")) as ReturnType<typeof buildSummary>;
it("binds aggregate evidence to frozen production and measured tool bytes without locking future production changes", () => {
  expect(artifact.protocol).toEqual(protocol);
  expect(artifact.scales.map(s => s.size)).toEqual([50, 400, 1200, 2400]);
  for (const [path, hash] of Object.entries({ ...artifact.sourceHashes, ...artifact.bundleSources })) {
    const frozenProduction = path.startsWith("src/") || /^package(?:-lock)?\.json$/.test(path);
    // A historical measurement must remain bound to its measured base, not freeze every future app edit.
    const bytes = frozenProduction ? execFileSync("git", ["show", `${artifact.base}:${path}`], { cwd: repo })
      : readFileSync(resolve(repo, path));
    expect(digest(bytes), path).toBe(hash);
  }
  for (const scale of artifact.scales) for (const c of scale.conditions) {
    expect(c.baseline.perRound.map(r => r.total.n)).toEqual([40, 40, 40]);
    expect(c.diagnostic).toMatchObject({ pairedN: 40, queriesPerRead: 14, fsCallsPerRead: 0, fsBytesPerRead: 0, errors: 0 });
    expect(c.outputCount).toBe(Math.min(c.matched, 100));
    for (const statement of c.diagnostic.statements) {
      expect(digest(artifact.statementDefinitions[statement.templateHash]!)).toBe(statement.templateHash);
      expect(digest(JSON.stringify(artifact.queryPlans[statement.planHash]))).toBe(statement.planHash);
    }
  }
  const text = JSON.stringify(artifact);
  expect(/"samples":\[|"(?:pairs|markup|files|directory|gitStatus)"|\/Users\/|\.data\//.test(text)).toBe(false);
  expect(artifact.rawSha256).toMatch(/^[a-f0-9]{64}$/);
});

// Deliberately synthetic raw receipt exercises verifier failures independently of the private measurement.
function rawFixture() {
  const samples = Array.from({ length: 40 }, () => ({ totalMs: 2, pageMs: 1, renderMs: 1 }));
  const rounds = [0, 1, 2].map(round => ({ round, hostStart: { heavy: [], loadavg: [1] }, hostEnd: { heavy: [], loadavg: [1] }, samples }));
  const pairs = Array.from({ length: 40 }, () => ({ plain: samples[0], observed: samples[0], observation: {
    sql: { sql: { calls: 14, errors: 0, ms: 0.5, prepareMs: 0.1 } }, fs: {},
    functions: { reportReaderVisibilitySql: { calls: 4 }, "facet:source_ids": { ms: 0.1 }, "facet:tags": { ms: 0.1 }, "facet:entity_names": { ms: 0.1 } },
  } }));
  return { status: "complete", protocol, sourceHashes: {}, bundles: { plain: { sources: {} }, observed: { sources: {} } },
    results: protocol.scales.map(size => ({ size, fixture: { files: [], visibleCount: 8 },
      conditions: protocol.conditions.map(c => ({ ...c, matched: 0, outputCount: 0, rounds, summary: summarizeRounds(rounds),
        diagnostic: { pairs, deltaMs: 0, deltaRatio: 0, instrumentationWarning: false, summary: { errors: 0, sql: [] } } })) })) };
}
const encode = (raw: unknown) => Buffer.from(JSON.stringify(raw));
it("verifies raw counts/quantiles and omits injected raw content; rejects stale summaries, incomplete runs and missing samples", () => {
  const raw = rawFixture();
  expect(buildSummary(encode({ ...raw, privateContent: "sentinel-original-text" })).scales).toHaveLength(4);
  expect(JSON.stringify(buildSummary(encode({ ...raw, privateContent: "sentinel-original-text" })))).not.toContain("sentinel-original-text");
  expect(() => buildSummary(encode({ ...raw, status: "failed" }))).toThrow("incomplete");
  const missing = structuredClone(raw); missing.results[0]!.conditions[0]!.rounds[0]!.samples.pop();
  expect(() => buildSummary(encode(missing))).toThrow();
  const stale = structuredClone(raw); stale.results[0]!.conditions[0]!.summary.totalP50 = 3;
  expect(() => buildSummary(encode(stale))).toThrow("stored statistics");
  const altered = structuredClone(raw); altered.results[0]!.conditions[0]!.diagnostic.pairs[0]!.observation.sql.sql.calls = 13;
  expect(() => buildSummary(encode(altered))).toThrow();
});

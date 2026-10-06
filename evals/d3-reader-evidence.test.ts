/** Independently checks the retained experiment's samples and reconstructable candidate identity. */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { digest, loadFrozenD3 } from "./fixtures/d3-frozen.js";

it("retained experiment binds the discarded trial and unchanged synthetic seed, and contains all preplanned rounds", async () => {
  const evidence = JSON.parse(readFileSync("evals/fixtures/d3-citation-batch-measurement.json", "utf8"));
  const trial = await loadFrozenD3(true);
  try {
    for (const name of ["analysis", "graph"]) {
      const path = `src/lib/db/${name}.ts`;
      expect(digest(readFileSync(join(trial.directory, path)))).toBe(evidence.candidate.hashes[path]);
    }
    expect(digest(readFileSync("evals/fixtures/d3-reader.ts"))).toBe(evidence.candidate.hashes["evals/fixtures/d3-reader.ts"]);
    expect(evidence.fixtureVersion).toBe("d3-reader-v2");
    expect(evidence.identity.baselineCommit).toBe("1d8925f7559bc648a2be288f2e9977336a4e0d17");
    expect(evidence.results.map((result: { size: number; condition: string }) => [result.size, result.condition]))
      .toEqual([50, 400, 1200, 2400].flatMap(size => ["node-all", "node-window", "edge-all", "empty"].map(condition => [size, condition])));
    for (const result of evidence.results) {
      expect(result.rounds).toHaveLength(3);
      expect(result.diagnostics.baseline.citationQueries).toBe(result.returned);
      expect(result.diagnostics.current.citationQueries).toBe(Math.ceil(result.returned / 400));
      for (const label of ["baseline", "current"]) for (const path of ["reader", "payload"]) {
        for (const percentile of ["p50", "p95"]) {
          const roundValues = [];
          for (const round of result.rounds) {
            const samples = round.samples[label][path] as number[];
            expect(samples).toHaveLength(40);
            expect(samples.every(value => Number.isFinite(value) && value > 0)).toBe(true);
            const sorted = [...samples].sort((a, b) => a - b);
            const value = sorted[percentile === "p50" ? 19 : 37];
            expect(round.percentiles[label][path][percentile]).toBe(value);
            roundValues.push(value!);
          }
          expect(result.summary[label][path][percentile]).toBe(roundValues.sort((a, b) => a - b)[1]);
        }
      }
    }
  } finally { rmSync(trial.directory, { recursive: true, force: true }); }
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReaderPerformance, verifyReaderPerformanceEvidence } from "./report-reader-performance-policy.js";
import fullFixture from "./report-reader-p0c-fixture.v3.json";

const invoke = (args: string[]) => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", ...args], { encoding: "utf8", timeout: 30000 });
describe("production benchmark and CI CLI", () => {
  it("refuses A/A enforcement before any benchmark runs", () => {
    const result = invoke(["evals/report-reader-p0c-benchmark.ts", "--diagnostic-aa", "--enforce"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("diagnostic_aa_is_not_gate_evidence");
    expect(result.stdout).toBe("");
  });

  it("runs real readers, preserves evidence on failure, and makes CI decide from numbers", () => {
    const directory = mkdtempSync(join(tmpdir(), "reader-performance-cli-"));
    try {
      const fixture = JSON.parse(readFileSync("evals/report-reader-p0c-fixture.v3.json", "utf8"));
      const fixturePath = join(directory, "fixture.json");
      // Only shorten timing loops for the wiring test. Real P0c dataset/baseline remains intact.
      writeFileSync(fixturePath, JSON.stringify({ ...fixture,
        warmup_samples: 1, measurement_samples: 2, measurement_rounds: 1, operations_per_sample: 1 }));
      const measured = invoke(["evals/report-reader-p0c-benchmark.ts", `--fixture=${fixturePath}`, "--enforce"]);
      expect(measured.error).toBeUndefined();
      const evidence = JSON.parse(measured.stdout);
      const policy = evaluateReaderPerformance(evidence.baseline.p95_ms, evidence.current.p95_ms);
      expect(measured.status).toBe(policy.passed ? 0 : 1);
      expect(evidence.baseline.p95_rounds_ms).toHaveLength(1);
      expect(() => verifyReaderPerformanceEvidence(evidence)).toThrow("invalid_report_reader_sampling");
      const path = join(directory, "evidence.json");
      writeFileSync(path, JSON.stringify(evidence));
      expect(invoke(["evals/check-report-reader-performance.ts", path]).status).toBe(1);
      // Deliberately synthetic CLI policy fixtures, not the timing result above. Keep every
      // summary consistent with its rounds; real shortened measurements must not pass CI.
      for (const [current, expectedStatus] of [[1.06, 0], [1.2, 1]]) {
        writeFileSync(path, JSON.stringify({ ...evidence,
          warmup_samples: fullFixture.warmup_samples, measurement_samples: fullFixture.measurement_samples,
          measurement_rounds: fullFixture.measurement_rounds, operations_per_sample: fullFixture.operations_per_sample,
          baseline: { ...evidence.baseline, p95_ms: 1, p95_rounds_ms: Array(5).fill(1) },
          current: { ...evidence.current, p95_ms: current, p95_rounds_ms: Array(5).fill(current) }, ...evaluateReaderPerformance(1, current) }));
        const checked = invoke(["evals/check-report-reader-performance.ts", path]);
        expect(checked.status).toBe(expectedStatus);
        expect(checked.stderr).toContain("::warning::");
        if (expectedStatus === 1) expect(checked.stderr).toContain("BOTH 10% and 0.1 ms");
      }
      writeFileSync(path, JSON.stringify({ ...evidence, comparison_mode: "current-vs-current", gate_eligible: false }));
      expect(invoke(["evals/check-report-reader-performance.ts", path]).status).toBe(1);
      writeFileSync(path, "invalid-json");
      expect(invoke(["evals/check-report-reader-performance.ts", path]).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
});

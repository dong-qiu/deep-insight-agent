import { describe, expect, it } from "vitest";
import { evaluateReaderPerformance, verifyReaderPerformanceEvidence } from "./report-reader-performance-policy.js";
import fixture from "./report-reader-p0c-fixture.v3.json";
import p0c from "./provenance-p0c-fixture.v2.json";

describe("reader performance budget", () => {
  it.each([
    [1, 0.8, "pass"], [1, 1, "pass"], [1, 1.05, "pass"], [1, 1.050001, "warning"],
    [0.1, 0.15, "warning"], // relative only
    [10, 10.2, "pass"], // absolute only
    [1, 1.1, "warning"], // exact 10% and 0.1ms: no floating-point false block
    [0.2, 0.3, "warning"], [0.2, 0.300001, "fail"], // absolute boundary dominates
    [10, 11, "warning"], [10, 11.000001, "fail"], // relative boundary dominates
    [1, 1.100001, "fail"], [0.21859863999998197, 0.264257120000002, "warning"],
  ])("baseline %s current %s => %s", (baseline, current, status) => {
    const result = evaluateReaderPerformance(baseline, current);
    expect(result.status).toBe(status);
    expect(result.passed).toBe(status !== "fail");
    expect(result.warning).toBe(status !== "pass");
    expect(result.allowed_current_p95_ms).toBe(Math.max(baseline * 1.1, baseline + 0.1));
  });

  it.each([0, -1, NaN, Infinity, -Infinity, undefined, null, "0.2"])("rejects invalid timing %s", value => {
    expect(() => evaluateReaderPerformance(value as number, 1)).toThrow("invalid_report_reader_timing");
    expect(() => evaluateReaderPerformance(1, value as number)).toThrow("invalid_report_reader_timing");
  });
  it("rejects overflow instead of admitting an infinite limit", () => {
    expect(() => evaluateReaderPerformance(Number.MAX_VALUE, 1)).toThrow();
    expect(() => evaluateReaderPerformance(Number.MIN_VALUE, Number.MAX_VALUE)).toThrow();
  });
});

function evidence(baseline = 1, current = 1.06) {
  return { benchmark_version: "report-reader-p0c-v4", comparison_mode: "baseline-vs-current", gate_eligible: true,
    baseline: { p95_ms: baseline, p95_rounds_ms: Array(5).fill(baseline), reader: "getReport", commit: fixture.baseline_commit },
    current: { p95_ms: current, p95_rounds_ms: Array(5).fill(current), reader: "getReport", commit: "local-worktree" },
    dataset: { p0c_fixture: fixture.p0c_fixture, p0c_fixture_sha256: fixture.p0c_fixture_sha256,
      p0c_trace_count: p0c.traces, report_snapshot_count: p0c.traces, report_body_bytes: fixture.report_body_bytes },
    execution_environment: { node: "test", sqlite: "test", platform: "test", arch: "test", cpu: "test", cpu_count: 1 }, warmup_samples: 20, measurement_samples: 100,
    measurement_rounds: 5, operations_per_sample: 25, ...evaluateReaderPerformance(baseline, current) };
}
describe("CI reader evidence verification", () => {
  it("accepts warning as nonblocking and preserves a true failure", () => {
    expect(verifyReaderPerformanceEvidence(evidence()).status).toBe("warning");
    expect(verifyReaderPerformanceEvidence(evidence(1, 2)).passed).toBe(false);
  });
  it.each([
    { passed: true, status: "pass" }, { allowed_regression_ratio: 1.25 }, { allowed_absolute_regression_ms: 100 },
    { policy_version: "old" }, { warning: false }, { allowed_current_p95_ms: 100 },
    { benchmark_version: "report-reader-p0c-v3" }, { comparison_mode: "current-vs-current" }, { gate_eligible: false },
    { baseline: { p95_ms: null } }, { measurement_rounds: 0 }, { operations_per_sample: 1.5 }, { dataset: null },
  ])("rejects false/missing evidence %j", patch => {
    expect(() => verifyReaderPerformanceEvidence({ ...evidence(1, 2), ...patch })).toThrow();
  });
  it("rejects absent evidence", () => {
    for (const value of [null, undefined, [], {}, "passed"]) expect(() => verifyReaderPerformanceEvidence(value)).toThrow();
  });
  it("rejects missing/mutated provenance, sampling and rounds", () => {
    for (const patch of [
      { dataset: {} }, { dataset: { ...evidence().dataset, report_snapshot_count: 1 } },
      { execution_environment: {} }, { execution_environment: { ...evidence().execution_environment, cpu_count: 0 } },
      { measurement_samples: 1 }, { measurement_rounds: 1 }, { operations_per_sample: 1 },
      { baseline: { ...evidence().baseline, commit: "0".repeat(40) } },
      { current: { ...evidence().current, commit: "" } },
      { current: { ...evidence().current, reader: "mock" } },
      { current: { ...evidence().current, p95_rounds_ms: [] } },
      { current: { ...evidence().current, p95_rounds_ms: [1, 1, NaN, 1, 1] } },
      { current: { ...evidence().current, p95_rounds_ms: [1, 1, 1, 1, 1] } },
    ]) expect(() => verifyReaderPerformanceEvidence({ ...evidence(), ...patch })).toThrow();
    expect(() => verifyReaderPerformanceEvidence(evidence(), "a".repeat(40))).toThrow("invalid_report_reader_source");
  });
});

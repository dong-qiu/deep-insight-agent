import fixture from "./report-reader-p0c-fixture.v3.json";
import p0c from "./provenance-p0c-fixture.v2.json";

/** Prototype engineering budget, not a statistical confidence threshold. Units are milliseconds. */
export const READER_PERFORMANCE_POLICY = {
  version: "report-reader-budget-v1",
  warning_ratio: 1.05,
  blocking_ratio: 1.10,
  blocking_delta_ms: 0.1,
} as const;

export function evaluateReaderPerformance(baselineMs: number, currentMs: number) {
  if (![baselineMs, currentMs].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("invalid_report_reader_timing");
  }
  const limit = Math.max(baselineMs * READER_PERFORMANCE_POLICY.blocking_ratio,
    baselineMs + READER_PERFORMANCE_POLICY.blocking_delta_ms);
  const ratio = currentMs / baselineMs;
  if (!Number.isFinite(limit) || !Number.isFinite(ratio)) throw new Error("invalid_report_reader_timing");
  // Compare absolute endpoints, not a subtracted delta: 1.1 - 1 is slightly > 0.1 in IEEE754.
  const passed = currentMs <= limit;
  const warning = currentMs > baselineMs * READER_PERFORMANCE_POLICY.warning_ratio;
  return {
    policy_version: READER_PERFORMANCE_POLICY.version,
    warning_regression_ratio: READER_PERFORMANCE_POLICY.warning_ratio,
    allowed_regression_ratio: READER_PERFORMANCE_POLICY.blocking_ratio,
    allowed_absolute_regression_ms: READER_PERFORMANCE_POLICY.blocking_delta_ms,
    observed_regression_ratio: ratio,
    observed_delta_ms: currentMs - baselineMs,
    allowed_current_p95_ms: limit,
    warning,
    status: !passed ? "fail" as const : warning ? "warning" as const : "pass" as const,
    passed,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_report_reader_evidence");
  return value as Record<string, unknown>;
}

/** CI rechecks policy output; A/A and old/mislabelled evidence cannot become a passing gate. */
export function verifyReaderPerformanceEvidence(value: unknown, expectedCommit?: string) {
  const evidence = record(value);
  if (evidence.benchmark_version !== "report-reader-p0c-v4"
    || evidence.comparison_mode !== "baseline-vs-current" || evidence.gate_eligible !== true) {
    throw new Error("ineligible_report_reader_evidence");
  }
  const dataset = record(evidence.dataset);
  const expectedDataset = { p0c_fixture: fixture.p0c_fixture, p0c_fixture_sha256: fixture.p0c_fixture_sha256,
    p0c_trace_count: p0c.traces, report_snapshot_count: p0c.traces, report_body_bytes: fixture.report_body_bytes };
  for (const [key, expected] of Object.entries(expectedDataset)) {
    if (dataset[key] !== expected) throw new Error("invalid_report_reader_dataset");
  }
  const environment = record(evidence.execution_environment);
  for (const key of ["node", "sqlite", "platform", "arch", "cpu"]) {
    if (typeof environment[key] !== "string" || !(environment[key] as string).trim()) throw new Error("invalid_report_reader_environment");
  }
  if (!Number.isSafeInteger(environment.cpu_count) || (environment.cpu_count as number) <= 0) throw new Error("invalid_report_reader_environment");
  for (const key of ["warmup_samples", "measurement_samples", "measurement_rounds", "operations_per_sample"] as const) {
    if (evidence[key] !== fixture[key]) throw new Error("invalid_report_reader_sampling");
  }
  const baseline = record(evidence.baseline);
  const current = record(evidence.current);
  if (baseline.commit !== fixture.baseline_commit || typeof current.commit !== "string"
    || !/^(?:[a-f0-9]{40}|local-worktree)$/.test(current.commit)
    || (expectedCommit !== undefined && current.commit !== expectedCommit)) throw new Error("invalid_report_reader_source");
  for (const lane of [baseline, current]) {
    const rounds = lane.p95_rounds_ms;
    if (lane.reader !== "getReport" || !Array.isArray(rounds) || rounds.length !== fixture.measurement_rounds
      || !rounds.every(value => typeof value === "number" && Number.isFinite(value) && value > 0)) {
      throw new Error("invalid_report_reader_rounds");
    }
    const median = [...rounds].sort((a, b) => a - b)[Math.ceil(rounds.length / 2) - 1];
    if (median !== lane.p95_ms) throw new Error("inconsistent_report_reader_rounds");
  }
  const result = evaluateReaderPerformance(baseline.p95_ms as number, current.p95_ms as number);
  for (const [key, expected] of Object.entries(result)) {
    if (evidence[key] !== expected) throw new Error("inconsistent_report_reader_policy_evidence");
  }
  return result;
}

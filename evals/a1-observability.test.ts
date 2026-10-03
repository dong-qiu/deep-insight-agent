import { afterEach, describe, expect, it, vi } from "vitest";
import { A1PhaseClock, effectiveA1Config, presentA1Status, a1FailureCategory } from "./a1-observability.js";
import { mapA1IndependentCalls } from "./a1-independent-call-concurrency.js";
import type { EvalConfig } from "./a1-config.js";
import { a1QualityCheckpointConfigSha256 } from "./a1-quality-checkpoint.js";

// Only resolved fields needed by the projection; extra fields are deliberately hostile.
const config = {
  llm_provider: "anthropic", analyzer_model: "analyzer-fixture", validator_model: "judge-fixture", coverage_model: "coverage-fixture",
  validator_thinking: true, coverage_thinking: false, coverage_thinking_source: "explicit",
  analyze_body_chars: 10000, analyze_batch_chars: 30000, select_window_chars: 1000,
  consistency_window_chars: 600, consistency_batch_max: 8, independent_call_concurrency: 1,
  validator_batch: false, coverage_max_tokens: 2048, display_coverage_primary_max_tokens: 8192,
  display_coverage_primary_claims_per_call: 1,
  secret: "PRIVATE-SOURCE-TEXT", endpoint: "https://private.example/secret", token: "sk-ant-api03-SENSITIVE",
} as unknown as EvalConfig;
afterEach(() => vi.unstubAllEnvs());

describe("C4a observations", () => {
  it("uses default runtime getters and an explicit resolved config projection", () => {
    for (const key of ["LLM_TIMEOUT_MS", "LLM_MAX_RETRIES", "LLM_TRANSIENT_RETRIES", "LLM_TRANSIENT_RETRY_BACKOFF_MS", "VALIDATOR_RETRIES", "VALIDATOR_RETRY_BACKOFF_MS"]) vi.stubEnv(key, undefined);
    const value = effectiveA1Config(config, { topic: 1800000, judge: 300000, coverage: 300000 });
    expect(value).toMatchObject({ analyzer_model: "analyzer-fixture", analyzer_thinking: false, validator_thinking: true, coverage_thinking: false, llm_timeout_ms: 120000, sdk_retries: 2, transient_retries: 1, transient_backoff_ms: 750, validator_retries: 2, validator_backoff_ms: 800, topic_timeout_ms: 1800000 });
    expect(value).not.toHaveProperty("endpoint");
  });
  it("uses existing limits and preserves zero retry values without exposing raw env", () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "9999"); vi.stubEnv("LLM_MAX_RETRIES", "0"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "9");
    vi.stubEnv("LLM_TRANSIENT_RETRY_BACKOFF_MS", "20000"); vi.stubEnv("VALIDATOR_RETRIES", "0"); vi.stubEnv("VALIDATOR_RETRY_BACKOFF_MS", "0");
    vi.stubEnv("LLM_API_KEY", "sk-ant-api03-SENSITIVE"); vi.stubEnv("LLM_BASE_URL", "https://private.example/secret");
    vi.stubEnv("ANALYZER_MODEL", "a-later-env-value");
    const summary = effectiveA1Config(config, { topic: 50000, judge: 40000, coverage: 30000 });
    expect(summary).toMatchObject({ llm_timeout_ms: 9999, sdk_retries: 0, transient_retries: 2, transient_backoff_ms: 10000, validator_retries: 0, validator_backoff_ms: 0 });
    expect(JSON.stringify(summary)).not.toMatch(/SENSITIVE|PRIVATE|private.example/);
    expect(JSON.stringify(presentA1Status({ status: "failed", error: "PRIVATE-SOURCE-TEXT", effective_config: summary }))).not.toMatch(/PRIVATE|SENSITIVE/);
  });
  it("records unavailable config as null and provider-specific retry applicability", () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "PRIVATE-SOURCE-TEXT");
    vi.stubEnv("LLM_TRANSIENT_RETRIES", undefined);
    expect(effectiveA1Config(config, { topic: 50000, judge: 40000, coverage: 30000 }).llm_timeout_ms).toBeNull();
    expect(effectiveA1Config({ ...config, llm_provider: "volcengine-responses" }, { topic: 1, judge: 2, coverage: 3 })).toMatchObject({ sdk_retries: null, transient_retries: 1, validator_retries: null, pre_terminal_eof_retries: 1 });
  });
  it("keeps phase wall time separate from parallel call latency and repeated updates", () => {
    let now = 10; const clock = new A1PhaseClock(() => now);
    clock.enter("setup"); now = 20; clock.enter("consistency");
    now = 30; clock.enter("consistency"); now = 60; clock.enter("coverage_benchmark");
    now = 80; clock.enter("finalizing"); now = 90; clock.finish("completed");
    expect(clock.snapshot()).toMatchObject({ overall_wall_ms: 80, phases: { setup: { state: "completed", wall_ms: 10 }, quality: { state: "not_run", wall_ms: null }, consistency: { state: "completed", wall_ms: 40 }, coverage_benchmark: { wall_ms: 20 }, finalizing: { wall_ms: 10 } } });
  });
  it("measures two simultaneous calls once rather than summing their latency", async () => {
    let now = 0; const clock = new A1PhaseClock(() => now); clock.enter("consistency");
    const releases: Array<() => void> = [];
    const work = mapA1IndependentCalls([1, 2], 2, async () => {
      const start = now; await new Promise<void>((resolve) => releases.push(resolve)); return now - start;
    });
    expect(releases).toHaveLength(2); now = 40; releases.forEach((release) => release());
    const latencies = await work; clock.enter("finalizing");
    expect(latencies.reduce((sum, latency) => sum + latency, 0)).toBe(80);
    expect(clock.snapshot().phases.consistency.wall_ms).toBe(40);
  });
  it.each(["failed", "cancelled"] as const)("preserves partial %s measurements and unexecuted phases", (outcome) => {
    let now = 0; const clock = new A1PhaseClock(() => now); clock.enter("setup"); now = 20; clock.enter("quality"); now = 55; clock.finish(outcome);
    expect(clock.snapshot()).toMatchObject({ overall_wall_ms: 55, phases: { setup: { state: "completed", wall_ms: 20 }, quality: { state: "failed", wall_ms: 35 }, consistency: { state: "not_run", wall_ms: null } } });
  });
  it("retains failed settled phases and running snapshots for uncatchable interruption", () => {
    let now = 0; const clock = new A1PhaseClock(() => now); clock.enter("setup"); now = 5; clock.markFailed(); now = 10; clock.enter("quality"); now = 20;
    expect(clock.snapshot().phases).toMatchObject({ setup: { state: "failed", wall_ms: 10 }, quality: { state: "running", wall_ms: 10 } });
  });
  it("does not equate execution, quality or baseline and does not invent legacy observations", () => {
    expect(presentA1Status(null)).toMatchObject({ execution: "not_run", automatic_gate: "unknown", baseline: "unknown", timing: null });
    expect(presentA1Status({ status: "completed", auto_gate: "fail" })).toMatchObject({ execution: "completed", automatic_gate: "fail", baseline: "unknown", timing: null });
    expect(presentA1Status({ status: "completed", auto_gate: "pass", baseline_comparison: "incomparable" })).toMatchObject({ execution: "completed", automatic_gate: "pass", baseline: "incomparable" });
    expect(presentA1Status({ status: "failed", auto_gate: "not_evaluated" })).toMatchObject({ execution: "failed", automatic_gate: "not_evaluated" });
    expect(presentA1Status({ state: "running" })).toMatchObject({ execution: "running", automatic_gate: "unknown" });
    expect(presentA1Status({ status: "failed" })).toMatchObject({ execution: "failed", automatic_gate: "unknown" });
    expect(presentA1Status({ status: "failed", auto_gate: "pass" })).toMatchObject({ execution: "failed", automatic_gate: "pass" });
    expect(presentA1Status({})).toMatchObject({ execution: "unknown", timing: null });
  });
  it("rejects malformed timing and drops unknown sensitive fields from old artifacts", () => {
    expect(presentA1Status({ timing: { overall_wall_ms: -1 } }).timing).toBeNull();
    const status = presentA1Status({ timing: { overall_wall_ms: 20, secret: "PRIVATE", phases: { setup: { state: "completed", wall_ms: 20, body: "PRIVATE" } } } });
    expect(JSON.stringify(status)).not.toContain("PRIVATE");
    expect(status.timing?.phases.quality).toEqual({ state: "unknown", wall_ms: null });
  });
  it("does not add observation fields to checkpoint config identity", () => {
    const before = a1QualityCheckpointConfigSha256(config);
    effectiveA1Config(config, { topic: 1, judge: 2, coverage: 3 });
    expect(a1QualityCheckpointConfigSha256(config)).toBe(before);
  });
  it("never serializes thrown message/name/body even on setup failure", () => {
    const error = new Error("PRIVATE-SOURCE-TEXT https://private.example/secret sk-ant-api03-SENSITIVE"); error.name = "PRIVATE";
    expect(a1FailureCategory(error)).toBe("execution_error");
  });
});

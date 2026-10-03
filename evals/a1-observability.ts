/** Additive execution observations. These never participate in scoring or checkpoint identity. */
import { performance } from "node:perf_hooks";
import { llmTimeoutMs, llmMaxRetries, llmTransientRetries, llmTransientRetryBackoffMs, validatorRetries, validatorBackoffMs } from "../src/lib/runtime/env.js";
import type { EvalConfig } from "./a1-config.js";

export const A1_PHASES = ["setup", "quality", "consistency", "coverage_benchmark", "finalizing"] as const;
export type A1Phase = typeof A1_PHASES[number];
export interface A1Timing {
  overall_wall_ms: number;
  phases: Record<A1Phase, { state: "not_run" | "running" | "completed" | "failed"; wall_ms: number | null }>;
}

export class A1PhaseClock {
  private readonly started: number;
  private ended: number | null = null;
  private current: A1Phase | null = null;
  private readonly phases = new Map<A1Phase, { start: number; end: number | null; failed: boolean }>();
  constructor(private readonly now: () => number = () => performance.now()) { this.started = now(); }
  enter(phase: A1Phase): void {
    if (this.current === phase) return;
    const now = this.now();
    if (this.current) this.phases.get(this.current)!.end = now;
    this.phases.set(phase, { start: now, end: null, failed: false });
    this.current = phase;
  }
  markFailed(): void { if (this.current) this.phases.get(this.current)!.failed = true; }
  finish(outcome: "completed" | "failed" | "cancelled"): void {
    if (outcome !== "completed") this.markFailed();
    this.ended = this.now();
    if (this.current) this.phases.get(this.current)!.end = this.ended;
  }
  snapshot(): A1Timing {
    const now = this.ended ?? this.now();
    return {
      overall_wall_ms: now - this.started,
      phases: Object.fromEntries(A1_PHASES.map((phase) => {
        const value = this.phases.get(phase);
        return [phase, value ? { state: value.failed ? "failed" : value.end === null ? "running" : "completed", wall_ms: (value.end ?? now) - value.start } : { state: "not_run", wall_ms: null }];
      })) as A1Timing["phases"],
    };
  }
}

/** Existing getters own all parsing/defaults. Invalid/unavailable observations must not change execution. */
function observed(getter: () => number): number | null { try { return getter(); } catch { return null; } }
export function effectiveA1Config(config: EvalConfig, deadlines: { topic: number; judge: number; coverage: number }) {
  const anthropic = config.llm_provider === "anthropic";
  return {
    sampled_at: new Date().toISOString(),
    analyzer_model: config.analyzer_model, validator_model: config.validator_model, coverage_model: config.coverage_model,
    relay_recovery_policy_version: config.relay_recovery_policy_version,
    relay_recovery_max_probes: config.relay_recovery_max_probes,
    relay_recovery_max_backoff_wait_ms: config.relay_recovery_max_backoff_wait_ms,
    relay_recovery_exhausted_cooldown_ms: config.relay_recovery_exhausted_cooldown_ms,
    analyzer_thinking: false, validator_thinking: config.validator_thinking, coverage_thinking: config.coverage_thinking,
    coverage_thinking_source: config.coverage_thinking_source,
    llm_timeout_ms: observed(llmTimeoutMs), topic_timeout_ms: deadlines.topic, judge_timeout_ms: deadlines.judge, coverage_timeout_ms: deadlines.coverage,
    sdk_retries: anthropic ? observed(llmMaxRetries) : null,
    transient_retries: observed(llmTransientRetries),
    transient_backoff_ms: observed(llmTransientRetryBackoffMs),
    validator_retries: anthropic ? observed(validatorRetries) : null,
    validator_backoff_ms: anthropic ? observed(validatorBackoffMs) : null,
    transient_retry_scope: anthropic ? "transient_api_error" : "eof_before_terminal",
    pre_terminal_eof_retries: anthropic ? null : observed(llmTransientRetries),
    analyze_body_chars: config.analyze_body_chars, analyze_batch_chars: config.analyze_batch_chars, select_window_chars: config.select_window_chars,
    consistency_window_chars: config.consistency_window_chars, consistency_batch_max: config.consistency_batch_max,
    validator_batch: config.validator_batch, independent_call_concurrency: config.independent_call_concurrency,
    coverage_max_tokens: config.coverage_max_tokens, display_coverage_primary_max_tokens: config.display_coverage_primary_max_tokens,
    display_coverage_primary_claims_per_call: config.display_coverage_primary_claims_per_call,
  };
}
export type A1EffectiveConfig = ReturnType<typeof effectiveA1Config>;

/** Fixed categories only: provider/config exceptions may contain credentials or source bodies. */
export function a1FailureCategory(error: unknown): string {
  // Only application-owned constructor names are allowed, never arbitrary error.name/message.
  const name = error instanceof Error ? error.constructor.name : "";
  return ["A1TopicDeadlineExceededError", "A1JudgeDeadlineExceededError", "A1CoverageDeadlineExceededError", "A1QualityCaseFailedError", "RuntimeConfigError"].includes(name) ? name : "execution_error";
}

/** Only whitelist timing fields when reading external/legacy artifacts. */
function readTiming(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const timing = value as Partial<A1Timing>;
  if (typeof timing.overall_wall_ms !== "number" || !Number.isFinite(timing.overall_wall_ms) || timing.overall_wall_ms < 0) return null;
  const phases = Object.fromEntries(A1_PHASES.map((phase) => {
    const item = timing.phases?.[phase];
    const valid = item && ["not_run", "running", "completed", "failed"].includes(item.state)
      && (item.wall_ms === null || (typeof item.wall_ms === "number" && Number.isFinite(item.wall_ms) && item.wall_ms >= 0));
    return [phase, valid ? { state: item.state, wall_ms: item.wall_ms } : { state: "unknown", wall_ms: null }];
  }));
  return { overall_wall_ms: timing.overall_wall_ms, phases };
}

/** Display projection only; this is not a new quality decision or baseline reader. */
export function presentA1Status(manifest: Record<string, unknown> | null) {
  const status = manifest?.status ?? manifest?.state; // progress uses the existing `state` field
  const execution = manifest === null ? "not_run" : ["running", "completed", "failed"].includes(String(status)) ? status : "unknown";
  return {
    execution,
    automatic_gate: ["pass", "fail", "smoke", "not_evaluated"].includes(String(manifest?.auto_gate)) ? manifest?.auto_gate : "unknown",
    baseline: ["comparable", "incomparable", "not_evaluated"].includes(String(manifest?.baseline_comparison)) ? manifest?.baseline_comparison : "unknown",
    timing: readTiming(manifest?.timing),
  };
}

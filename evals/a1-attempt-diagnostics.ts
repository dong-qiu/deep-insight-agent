/** Explicitly bounded A1 measurements. Request cap is not a money/quota budget. */
import { performance } from "node:perf_hooks";
import type { UsageNumbers } from "../src/lib/db/model-usage.js";
import { createTaskCancellation } from "../src/lib/runtime/cancellation.js";
import type { ModelCallObserver, ObservedModelCall } from "../src/lib/runtime/model-call-observer.js";
import type { A1Phase } from "./a1-observability.js";

const OPERATIONS = new Set(["analysis_generation", "display_quote_primary", "display_quote_countercheck", "reader_language_repair", "citation_repair_candidates", "citation_consistency_single", "citation_consistency_batch", "followup_generation"]);
export interface A1DiagnosticLimits { max_attempts: number; window_ms: number }
export function a1DiagnosticLimits(env: Record<string, string | undefined> = process.env): A1DiagnosticLimits | undefined {
  const max = env.A1_DIAGNOSTIC_MAX_ATTEMPTS;
  const window = env.A1_DIAGNOSTIC_WINDOW_MS;
  if (max === undefined && window === undefined) return undefined;
  if (!max?.trim() || !window?.trim() || !Number.isSafeInteger(Number(max)) || Number(max) < 0 || Number(max) > 10000
    || !Number.isSafeInteger(Number(window)) || Number(window) < 1 || Number(window) > 2700000) throw new Error("invalid_a1_diagnostic_limits");
  return { max_attempts: Number(max), window_ms: Number(window) };
}
type CallSample = ObservedModelCall & { phase: A1Phase; started_ms: number; wall_ms: number | null; state: "running" | "succeeded" | "failed" };
type AttemptSample = ObservedModelCall & {
  attempt_id: string; attempt_number: number; phase: A1Phase; started_ms: number;
  headers_ms: number | null; wall_ms: number | null; state: "running" | "eof" | "http_error" | "error" | "cancelled";
  sdk_retry_number: number | null;
  usage_status: "unknown" | "partial" | "reported"; usage: UsageNumbers;
  estimate_usd: null; estimate_status: "unknown";
};
export type A1DiagnosticsSnapshot = ReturnType<A1AttemptDiagnostics["snapshot"]>;
export class A1AttemptDiagnostics implements ModelCallObserver {
  private readonly cancellation;
  readonly signal: AbortSignal;
  private failure: "attempt_limit" | "cancelled" | "deadline" | "incomplete" | null = null;
  private closed = false;
  private phase: A1Phase = "setup";
  private readonly start = performance.now();
  private readonly callSamples: CallSample[] = [];
  private readonly attempts: AttemptSample[] = [];
  private readonly controller = new AbortController();
  constructor(readonly limits: A1DiagnosticLimits) {
    this.cancellation = createTaskCancellation({ signal: this.controller.signal, deadlineAt: Date.now() + limits.window_ms });
    this.signal = this.cancellation.signal;
  }
  enter(phase: A1Phase): void { this.phase = phase; }
  incomplete(): void { this.failure ??= "incomplete"; this.controller.abort(); }
  cancel(): void { this.failure ??= "cancelled"; this.controller.abort(); }
  check(): void {
    if (this.failure) throw new Error(`a1_diagnostic_${this.failure}`);
    if (this.closed) throw new Error("a1_diagnostic_closed");
    this.checkPublication();
  }
  checkPublication(): void {
    if (this.failure) throw new Error(`a1_diagnostic_${this.failure}`);
    try { this.cancellation.check(); }
    catch { this.failure ??= this.signal.reason?.reasonCode === "task_deadline_exceeded" ? "deadline" : "cancelled"; throw new Error(`a1_diagnostic_${this.failure}`); }
  }
  private safe(call: ObservedModelCall): ObservedModelCall { return { ...call, operation: OPERATIONS.has(call.operation) ? call.operation : "unclassified" }; }
  callStarted(call: ObservedModelCall): void {
    this.check();
    this.callSamples.push({ ...this.safe(call), phase: this.phase, started_ms: performance.now() - this.start, wall_ms: null, state: "running" });
  }
  callEnded(call: ObservedModelCall, succeeded: boolean): void {
    if (this.closed) return;
    const sample = this.callSamples.find((value) => value.logical_call_id === call.logical_call_id)!;
    sample.wall_ms = performance.now() - this.start - sample.started_ms;
    sample.state = succeeded && !this.failure && !this.signal.aborted ? "succeeded" : "failed";
  }
  attemptStarted(call: ObservedModelCall, attemptId: string, number: number) {
    this.check();
    if (this.attempts.length >= this.limits.max_attempts) {
      this.failure ??= "attempt_limit";
      this.controller.abort();
      this.check();
    }
    const sample: AttemptSample = { ...this.safe(call), attempt_id: attemptId, attempt_number: number, phase: this.phase,
      started_ms: performance.now() - this.start, headers_ms: null, wall_ms: null, state: "running", sdk_retry_number: null,
      usage_status: "unknown", usage: { input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      estimate_usd: null, estimate_status: "unknown" };
    this.attempts.push(sample);
    return {
      dispatched: (sdkRetryNumber: number | null): void => { if (!this.closed) sample.sdk_retry_number = sdkRetryNumber; },
      headers: (): void => { if (!this.closed) sample.headers_ms = performance.now() - this.start - sample.started_ms; },
      ended: (state: AttemptSample["state"]): void => { if (!this.closed) { sample.state = state; sample.wall_ms = performance.now() - this.start - sample.started_ms; } },
      usage: (usage: UsageNumbers, final: boolean): void => {
        if (this.closed || sample.usage_status === "reported") return;
        for (const field of Object.keys(usage) as Array<keyof UsageNumbers>) if (usage[field] !== null) sample.usage[field] = usage[field];
        const known = Object.values(sample.usage).some((value) => value !== null);
        sample.usage_status = final && usage.input_tokens !== null && usage.output_tokens !== null ? "reported" : known ? "partial" : "unknown";
      },
    };
  }
  snapshot() {
    return { version: 1, limits: { ...this.limits }, execution_complete: !this.failure && !this.signal.aborted && this.closed,
      stop_reason: this.failure, logical_calls: this.callSamples.length, transport_attempts: this.attempts.length,
      calls: this.callSamples.map((value) => ({ ...value })), attempts: this.attempts.map((value) => ({ ...value, usage: { ...value.usage } })),
      latency_boundary: "dispatch_to_body_eof_error_or_local_cancel", tail_latency: "insufficient_samples",
      cost_warning: "request_cap_is_not_a_money_or_quota_cap" };
  }
  dispose(): void { this.cancellation.dispose(); }
  finish(complete: boolean): void {
    if (!complete && !this.failure) this.incomplete();
    this.closed = true;
    if (!complete) this.cancellation.dispose();
  }
}

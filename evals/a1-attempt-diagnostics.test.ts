import { afterEach, expect, it, vi } from "vitest";
import { A1AttemptDiagnostics, a1DiagnosticLimits } from "./a1-attempt-diagnostics.js";
import { beginObservedModelAttempt, observeModelCall, withModelCallObserver } from "../src/lib/runtime/model-call-observer.js";
const call = { role: "analyzer" as const, model: "synthetic", provider: "anthropic" as const, operation: "analysis_generation" };
const limits = { max_attempts: 2, window_ms: 10000 };
afterEach(() => vi.unstubAllGlobals());

it.each([{}, { A1_DIAGNOSTIC_MAX_ATTEMPTS: "2" }, { A1_DIAGNOSTIC_WINDOW_MS: "10" },
  { A1_DIAGNOSTIC_MAX_ATTEMPTS: "", A1_DIAGNOSTIC_WINDOW_MS: "10" },
  { A1_DIAGNOSTIC_MAX_ATTEMPTS: "-1", A1_DIAGNOSTIC_WINDOW_MS: "10" },
  { A1_DIAGNOSTIC_MAX_ATTEMPTS: "2", A1_DIAGNOSTIC_WINDOW_MS: "0" }])("validates explicit opt-in (%j)", (env) => {
  if (!Object.keys(env).length) expect(a1DiagnosticLimits(env)).toBeUndefined();
  else expect(() => a1DiagnosticLimits(env)).toThrow("invalid_a1_diagnostic_limits");
});
it("allows explicit zero and rejects unsafe numeric limits without echoing their values", () => {
  expect(a1DiagnosticLimits({ A1_DIAGNOSTIC_MAX_ATTEMPTS: "0", A1_DIAGNOSTIC_WINDOW_MS: "1" })).toEqual({ max_attempts: 0, window_ms: 1 });
  expect(() => a1DiagnosticLimits({ A1_DIAGNOSTIC_MAX_ATTEMPTS: "sensitive-value", A1_DIAGNOSTIC_WINDOW_MS: "1" })).toThrow(/^invalid_a1_diagnostic_limits$/);
});
it("caps simultaneous dispatch synchronously and preserves unknown paid work after stop", async () => {
  const d = new A1AttemptDiagnostics(limits);
  let release!: (response: Response) => void;
  const transport = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  vi.stubGlobal("fetch", transport);
  const send = () => observeModelCall(call, async () => {
    const attempt = beginObservedModelAttempt()!;
    return attempt.fetch("https://example.test");
  });
  await withModelCallObserver(d, async () => {
    const settled = Promise.allSettled([send(), send(), send()]);
    expect(transport).toHaveBeenCalledTimes(2);
    const outcome = await settled;
    expect(outcome.every((result) => result.status === "rejected")).toBe(true);
  });
  d.finish(false);
  const terminal = d.snapshot();
  expect(terminal).toMatchObject({ execution_complete: false, stop_reason: "attempt_limit", transport_attempts: 2 });
  expect(terminal.attempts.every((sample) => sample.usage_status === "unknown" && sample.estimate_usd === null)).toBe(true);
  release(new Response("late success"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  d.finish(true);
  expect(d.snapshot()).toEqual(terminal); // no resurrection or late mutation
});
it("rejects an expired deadline synchronously even before its timer is serviced", async () => {
  const d = new A1AttemptDiagnostics({ ...limits, window_ms: 1 });
  const until = Date.now() + 5; while (Date.now() < until) { /* deliberately block deadline timer */ }
  await expect(withModelCallObserver(d, () => observeModelCall(call, async () => true))).rejects.toThrow("a1_diagnostic_deadline");
  d.finish(false);
  expect(d.snapshot()).toMatchObject({ execution_complete: false, stop_reason: "deadline", transport_attempts: 0 });
});
it("keeps reported usage independent of failed transport and does not erase partial/missing fields", async () => {
  const d = new A1AttemptDiagnostics({ max_attempts: 3, window_ms: 10000 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  await withModelCallObserver(d, async () => {
    await observeModelCall({ ...call, operation: "PRIVATE-PROMPT" }, async () => {
      for (const state of ["unknown", "partial", "reported"]) {
        const a = beginObservedModelAttempt()!;
        await a.fetch("https://example.test");
        if (state !== "unknown") a.observe({ input_tokens: 0, output_tokens: state === "reported" ? 0 : null, cache_creation_input_tokens: null, cache_read_input_tokens: null }, state === "reported");
      }
    });
  });
  d.finish(false);
  expect(d.snapshot().attempts.map((sample) => sample.usage_status)).toEqual(["unknown", "partial", "reported"]);
  expect(d.snapshot().attempts[2]).toMatchObject({ state: "http_error", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null } });
  expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE-PROMPT");
});
it("records parallel phase wall separately from call durations and remains sticky after incomplete", async () => {
  const d = new A1AttemptDiagnostics(limits); d.enter("quality");
  await withModelCallObserver(d, async () => {
    await Promise.all([observeModelCall(call, async () => {}), observeModelCall(call, async () => {})]);
    d.incomplete();
    await expect(observeModelCall(call, async () => true)).rejects.toThrow("a1_diagnostic_incomplete");
  });
  d.finish(true);
  expect(d.snapshot()).toMatchObject({ execution_complete: false, stop_reason: "incomplete", logical_calls: 2 });
});

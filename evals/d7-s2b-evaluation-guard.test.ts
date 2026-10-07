import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { cancelTask, createBudget, digest, EvaluationBudget, privateJson } from "./d7-s2b-evaluation-budget.js";
import { installEvaluationBridge, type EvaluationBridge } from "./d7-s2b-evaluation-preload.js";
import { failEvaluationOutputs, sealFailedOutputs } from "./d7-s2b-evaluation-run.js";
import type { ObservedModelCall } from "../src/lib/runtime/model-call-observer.js";

const call = (id: string, operation = "citation_consistency_single"): ObservedModelCall => ({ logical_call_id: id, operation,
  model: "synthetic", role: operation === "analysis_generation" ? "analyzer" : "validator", provider: "volcengine-responses" });
function setup(limits = { attempts: 100, retries: 20, window: 2700000 }) {
  const root = mkdtempSync(join(tmpdir(), "d7-guard-")), state = createBudget(root, limits);
  return { root, state, budget: new EvaluationBudget(root, state.nonce, null) };
}
const bridges: EvaluationBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("one task admission and sticky state", () => {
  it("stops the 101st actual attempt before transport, including simultaneous admissions", async () => {
    const { budget } = setup(); let dispatches = 0;
    const results = await Promise.allSettled(Array.from({ length: 101 }, (_, index) => (async () => {
      budget.reserve(call(String(index)), `case-${index}`, `body-${index}`, 0); dispatches++; await Promise.resolve();
    })()));
    expect(dispatches).toBe(100); expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(budget.read()).toMatchObject({ failure: "attempt_limit", execution_complete: false });
    expect(() => budget.check()).toThrow();
  });
  it.each(["same-logical", "new-logical-same-body", "sdk-header", "split", "repair"])("stops the 21st retry: %s", (kind) => {
    const { budget } = setup();
    for (let index = 0; index < 22; index++) {
      const metadata = call(kind === "same-logical" ? "same" : String(index), kind === "split" ? "analysis_generation" : kind === "repair" && index > 0 ? "reader_language_repair" : undefined);
      const body = kind === "new-logical-same-body" ? "same" : String(index);
      const admit = () => budget.reserve(metadata, "case", body, kind === "sdk-header" && index > 0 ? 1 : 0);
      if (index === 21) expect(admit).toThrow(); else admit();
    }
    expect(budget.read().attempts).toHaveLength(21); expect(budget.read().failure).toBe("retry_limit");
  });
  it("unions retry reasons without triple counting and keeps first primary/countercheck separate", () => {
    const { budget } = setup();
    budget.reserve(call("same"), "case", "body", 0); budget.reserve(call("same"), "case", "body", 1);
    budget.reserve(call("primary", "display_quote_primary"), "case", "primary", 0);
    budget.reserve(call("counter", "display_quote_countercheck"), "case", "counter", 0);
    expect(budget.read().attempts.filter((entry) => entry.retry)).toHaveLength(1);
  });
  it("parent STOP cannot be overwritten by child admission, and another owner cannot join", () => {
    const { root, state } = setup(); state.owner = process.pid; privateJson(join(root, "budget.json"), state);
    const child = new EvaluationBudget(root, state.nonce, process.pid);
    child.reserve(call("one"), "case", "one", 0); cancelTask(root, "parent_cancelled");
    expect(() => child.reserve(call("two"), "case", "two", 0)).toThrow();
    expect(child.read().attempts).toHaveLength(1);
    expect(() => new EvaluationBudget(root, state.nonce, process.pid + 1).read()).toThrow();
  });
  it("deadline and malformed state refuse dispatch even before the timer fires", () => {
    const { budget, state, root } = setup();
    vi.spyOn(Date, "now").mockReturnValue(state.deadline);
    expect(() => budget.reserve(call("late"), "case", "body", 0)).toThrow();
    expect(budget.read()).toMatchObject({ failure: "deadline", execution_complete: false });
    privateJson(join(root, "budget.json"), { ...state, nonce: "wrong" }); expect(() => budget.check()).toThrow();
  });
});

function syntheticEnv(provider: string) {
  for (const [key, value] of Object.entries({ LLM_PROVIDER: provider, LLM_API_KEY: "synthetic-no-network", LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
    ANTHROPIC_API_KEY: "synthetic-no-network", ANTHROPIC_BASE_URL: "https://provider.example.test", ANALYZER_MODEL: "synthetic",
    VALIDATOR_MODEL: "synthetic", COVERAGE_MODEL: "synthetic-coverage", VALIDATOR_THINKING: "0", COVERAGE_THINKING: "0",
    LLM_MAX_RETRIES: "1", LLM_TRANSIENT_RETRIES: "1", LLM_TRANSIENT_RETRY_BACKOFF_MS: "1", PROMPT_CACHE: "0" })) vi.stubEnv(key, value);
}
function response(provider: string) {
  const events = provider === "anthropic" ? [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: "synthetic", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":"ok"}' } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
  ] : [{ type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"value":"ok"}' },
    { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }];
  return new Response(events.map((entry) => `${provider === "anthropic" ? `event: ${entry.type}\n` : ""}data: ${JSON.stringify(entry)}\n\n`).join("") + (provider === "anthropic" ? "" : "data: [DONE]\n\n"), { headers: { "Content-Type": "text/event-stream" } });
}

describe("actual candidate SDK + inner diagnostics bridge, fake transport only", () => {
  it.each(["anthropic", "volcengine-responses"])("observes %s native retry and outer validator retry", async (provider) => {
    syntheticEnv(provider);
    const { root, state, budget } = setup(); let attempts = 0;
    const bridge = await installEvaluationBridge({ candidate: resolve("."), root, nonce: state.nonce, claim: false,
      transport: async () => {
        attempts++;
        if (attempts === 1) return provider === "anthropic" ? new Response('{"type":"error","error":{"type":"overloaded_error","message":"synthetic"}}', { status: 529, headers: { "Content-Type": "application/json", "retry-after-ms": "1" } }) : new Response("data: [DONE]\n\n");
        return response(provider);
      } }); bridges.push(bridge);
    const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
    const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
    const { callStructured } = await import("../src/lib/runtime/llm.js");
    const inner = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: 10000 }); inner.enter("consistency");
    try {
      await withModelCallObserver(inner, async () => {
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await callStructured({ role: "validator", telemetryOperation: "citation_consistency_single", system: "Synthetic", user: "Fixed", schema: z.object({ value: z.string() }) });
          expect(result.data).toEqual({ value: "ok" });
        }
        inner.finish(true);
      });
      expect(attempts).toBe(3); expect(budget.read().attempts).toHaveLength(3);
      expect(budget.read().attempts.filter((entry) => entry.retry)).toHaveLength(2);
      expect(inner.snapshot()).toMatchObject({ execution_complete: true, transport_attempts: 3 });
      expect(readFileSync(join(root, "request-1.json"), "utf8")).not.toContain("synthetic-no-network");
    } finally { inner.dispose(); }
  });
  it("rejects unobserved fetch and late native completion with sticky incomplete", async () => {
    syntheticEnv("volcengine-responses");
    const { root, state, budget } = setup(); let native = 0;
    const bridge = await installEvaluationBridge({ candidate: resolve("."), root, nonce: state.nonce, claim: false,
      transport: async () => { native++; return response("volcengine-responses"); } }); bridges.push(bridge);
    await expect(fetch("https://never.example.test", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(native).toBe(0); expect(budget.read().execution_complete).toBe(false);
  });
  it("refuses a provider that resolves after the common deadline, even ignoring abort", async () => {
    syntheticEnv("volcengine-responses"); const { root, state, budget } = setup();
    const bridge = await installEvaluationBridge({ candidate: resolve("."), root, nonce: state.nonce, claim: false,
      transport: async () => { vi.spyOn(Date, "now").mockReturnValue(state.deadline); return response("volcengine-responses"); } }); bridges.push(bridge);
    const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
    const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
    const { callStructured } = await import("../src/lib/runtime/llm.js");
    const inner = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: 10000 });
    try {
      await expect(withModelCallObserver(inner, () => callStructured({ role: "validator", telemetryOperation: "citation_consistency_single", system: "Synthetic", user: "Fixed", schema: z.object({ value: z.string() }) }))).rejects.toThrow();
      expect(() => inner.finish(true)).toThrow(); expect(inner.snapshot().execution_complete).toBe(false);
      expect(budget.read()).toMatchObject({ failure: "deadline", execution_complete: false });
    } finally { inner.dispose(); }
  });
  it("budget/request I/O crossing the deadline blocks native dispatch", async () => {
    syntheticEnv("volcengine-responses"); const { root, state } = setup(); let native = 0;
    const bridge = await installEvaluationBridge({ candidate: resolve("."), root, nonce: state.nonce, claim: false,
      transport: async () => { native++; return response("volcengine-responses"); } }); bridges.push(bridge);
    const reserve = bridge.budget.reserve.bind(bridge.budget);
    vi.spyOn(bridge.budget, "reserve").mockImplementation((...args) => {
      const admitted = reserve(...args); vi.spyOn(Date, "now").mockReturnValue(state.deadline); return admitted;
    });
    const { A1AttemptDiagnostics } = await import("./a1-attempt-diagnostics.js");
    const { withModelCallObserver } = await import("../src/lib/runtime/model-call-observer.js");
    const { callStructured } = await import("../src/lib/runtime/llm.js");
    const inner = new A1AttemptDiagnostics({ max_attempts: 100, window_ms: 10000 });
    try {
      await expect(withModelCallObserver(inner, () => callStructured({ role: "validator", telemetryOperation: "citation_consistency_single", system: "Synthetic", user: "Fixed", schema: z.object({ value: z.string() }) }))).rejects.toThrow();
      expect(native).toBe(0); expect(inner.snapshot().execution_complete).toBe(false); expect(bridge.budget.read().failure).toBe("deadline");
    } finally { inner.dispose(); }
  });
});

it("seals child-completed evidence on parent failure; actual checkpoint loader refuses recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "d7-seal-")), run = join(root, "a1-20261007000000-abcd1234"); mkdirSync(run);
  const { createA1QualityCheckpoint, assertValidA1QualityCheckpoint } = await import("./a1-quality-checkpoint.js");
  const context = { eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64), recovery_identity_sha256: "c".repeat(64) };
  const checkpoint = createA1QualityCheckpoint(context); assertValidA1QualityCheckpoint(checkpoint, context, []);
  privateJson(join(run, "quality-checkpoint.json"), checkpoint);
  const original = digest(readFileSync(join(run, "quality-checkpoint.json")));
  privateJson(join(root, "latest-complete.json"), { manifest: join(run, "manifest.json") });
  privateJson(join(run, "progress.json"), { state: "completed", completed: { quality_cases: 1 }, attempt_diagnostics: { execution_complete: true } });
  privateJson(join(run, "a1-run.json"), { status: "completed", auto_gate: "smoke" });
  privateJson(join(run, "manifest.json"), { status: "completed", auto_gate: "smoke", attempt_diagnostics: { execution_complete: true }, artifacts: { "quality-checkpoint.json": original } });
  sealFailedOutputs(root, "parent_deadline");
  expect(existsSync(join(root, "latest-complete.json"))).toBe(false);
  const sealed = JSON.parse(readFileSync(join(run, "quality-checkpoint.json"), "utf8"));
  expect(sealed.recovery_identity_sha256).toBeNull(); expect(() => assertValidA1QualityCheckpoint(sealed, context, [])).toThrow();
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ status: "failed", auto_gate: "not_evaluated", attempt_diagnostics: { execution_complete: false } });
  expect(manifest.artifacts["quality-checkpoint.json"]).toBe(digest(readFileSync(join(run, "quality-checkpoint.json"))));
  expect(JSON.parse(readFileSync(join(run, "progress.json"), "utf8"))).not.toHaveProperty("completed");
  expect(JSON.parse(readFileSync(join(run, "d7-failure-seal.json"), "utf8")).original_hashes["quality-checkpoint.json"]).toBe(original);
});

it.each([false, true])("actual Node child preload binds the runner's module instance; late=%s", (late) => {
  const { root, state } = setup({ attempts: 100, retries: 20, window: 10000 });
  const script = `
    import {z} from 'zod';
    import {A1AttemptDiagnostics} from './evals/a1-attempt-diagnostics.ts';
    import {withModelCallObserver} from './src/lib/runtime/model-call-observer.ts';
    import {callStructured} from './src/lib/runtime/llm.ts';
    const inner=new A1AttemptDiagnostics({max_attempts:100,window_ms:10000});
    inner.enter('quality');
    try {
      await withModelCallObserver(inner,()=>callStructured({role:'analyzer',telemetryOperation:'analysis_generation',system:'Synthetic',user:'Fixed',schema:z.object({value:z.string()})}));
      inner.finish(true);
    } catch { inner.finish(false); process.exitCode=1; }
    finally {inner.dispose();globalThis.d7EvaluationBridge.dispose();}
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", "./evals/fixtures/d7-s2b-guard-transport.ts", "--import", "./evals/d7-s2b-evaluation-preload.ts", "--input-type=module", "-e", script], {
    cwd: resolve("."), encoding: "utf8", timeout: 15000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, D7_EVALUATION_CHILD: "1", D7_EVALUATION_CANDIDATE: resolve("."), D7_EVALUATION_ROOT: root,
      D7_EVALUATION_NONCE: state.nonce, D7_SYNTHETIC_LATE: late ? "1" : "0", LLM_PROVIDER: "volcengine-responses",
      LLM_API_KEY: "synthetic-no-network", LLM_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      ANALYZER_MODEL: "synthetic", VALIDATOR_MODEL: "synthetic-v", COVERAGE_MODEL: "synthetic-c", PROMPT_CACHE: "0", LLM_TRANSIENT_RETRIES: "0" },
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(late ? 1 : 0);
  const final = JSON.parse(readFileSync(join(root, "budget.json"), "utf8"));
  expect(final.owner).toBe(result.pid);
  if (late) expect(final).toMatchObject({ failure: "deadline", execution_complete: false });
  else expect(final.attempts).toHaveLength(1);
  expect(final.attempts.length).toBeLessThanOrEqual(1);
});

it("a corrupt budget after child completion cannot preserve pass receipts or recovery", async () => {
  const { root, budget } = setup(), a1 = join(root, "a1"), run = join(a1, "a1-20261007000000-abcd1234"); mkdirSync(a1); mkdirSync(run);
  const { createA1QualityCheckpoint, assertValidA1QualityCheckpoint } = await import("./a1-quality-checkpoint.js");
  const context = { eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64), recovery_identity_sha256: "c".repeat(64) };
  privateJson(join(run, "quality-checkpoint.json"), createA1QualityCheckpoint(context));
  privateJson(join(run, "manifest.json"), { status: "completed", auto_gate: "pass" });
  privateJson(join(a1, "latest-complete.json"), { manifest: join(run, "manifest.json") });
  privateJson(join(root, "prototype-safety-receipt.json"), { passed: true }); privateJson(join(root, "task-receipt.json"), { execution_complete: true });
  privateJson(join(root, "budget.json"), { corrupt: true });
  failEvaluationOutputs(root, budget);
  for (const name of ["prototype-safety-receipt.json", "task-receipt.json", "a1/latest-complete.json"]) expect(existsSync(join(root, name))).toBe(false);
  expect(existsSync(join(root, "STOP"))).toBe(true);
  const sealed = JSON.parse(readFileSync(join(run, "quality-checkpoint.json"), "utf8"));
  expect(() => assertValidA1QualityCheckpoint(sealed, context, [])).toThrow();
});

it("real parent SIGTERM during parent-only certification seals completed child evidence", async () => {
  const { root, state } = setup(), a1 = join(root, "a1"), run = join(a1, "a1-20261007000000-abcd1234"); mkdirSync(a1); mkdirSync(run);
  const { createA1QualityCheckpoint, assertValidA1QualityCheckpoint } = await import("./a1-quality-checkpoint.js");
  const context = { eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64), recovery_identity_sha256: "c".repeat(64) };
  privateJson(join(run, "quality-checkpoint.json"), createA1QualityCheckpoint(context));
  privateJson(join(run, "manifest.json"), { status: "completed", auto_gate: "pass" });
  privateJson(join(a1, "latest-complete.json"), { manifest: join(run, "manifest.json") });
  const script = `
    import {EvaluationLifetime} from './evals/d7-s2b-evaluation-run.ts';
    import {EvaluationBudget} from './evals/d7-s2b-evaluation-budget.ts';
    const budget=new EvaluationBudget(process.env.D7_TEST_ROOT,process.env.D7_TEST_NONCE,null);
    const lifetime=new EvaluationLifetime(process.env.D7_TEST_ROOT,budget);
    setTimeout(()=>process.kill(process.pid,'SIGTERM'),1);
    await new Promise(done=>setTimeout(done,20));
    try {budget.check();process.exitCode=2;} catch {process.exitCode=1;} finally {lifetime.dispose();}
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: resolve("."), encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, D7_TEST_ROOT: root, D7_TEST_NONCE: state.nonce },
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(existsSync(join(a1, "latest-complete.json"))).toBe(false);
  expect(() => assertValidA1QualityCheckpoint(JSON.parse(readFileSync(join(run, "quality-checkpoint.json"), "utf8")), context, [])).toThrow();
  expect(JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"))).toMatchObject({ status: "failed", auto_gate: "not_evaluated" });
});

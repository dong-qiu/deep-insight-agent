/** Evaluation-only bridge to the exact candidate's existing #431 diagnostics and SDK fetch. */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ObservedModelCall } from "../src/lib/runtime/model-call-observer.js";
import { cancelTask, EvaluationBudget, privateJson } from "./d7-s2b-evaluation-budget.js";

const OPERATIONS = new Set(["analysis_generation", "display_quote_primary", "display_quote_countercheck",
  "reader_language_repair", "citation_repair_candidates", "citation_consistency_single", "citation_consistency_batch"]);
export interface EvaluationBridge {
  budget: EvaluationBudget;
  segment(value: string): void;
  check(): void;
  dispose(): void;
}
declare global { var d7EvaluationBridge: EvaluationBridge | undefined; }

export async function installEvaluationBridge(options: {
  candidate: string; root: string; nonce: string; transport?: typeof fetch; claim?: boolean;
}): Promise<EvaluationBridge> {
  const budget = new EvaluationBudget(options.root, options.nonce, options.claim === false ? null : process.pid);
  if (options.claim !== false) {
    // An exclusive lease prevents concurrent children, including before either writes its owner PID.
    try { writeFileSync(join(options.root, "actor.json"), JSON.stringify({ nonce: options.nonce, pid: process.pid }), { flag: "wx", mode: 0o600 }); }
    catch (error) { cancelTask(options.root, "concurrent_actor"); throw error; }
    const state = new EvaluationBudget(options.root, options.nonce, null).check();
    state.owner = process.pid; privateJson(join(options.root, "budget.json"), state);
  }
  const candidateImport = (name: string) => import(pathToFileURL(resolve(options.candidate, name)).href);
  const diagnostics = await candidateImport("evals/a1-attempt-diagnostics.ts") as typeof import("./a1-attempt-diagnostics.js");
  const observer = await candidateImport("src/lib/runtime/model-call-observer.ts") as typeof import("../src/lib/runtime/model-call-observer.js");
  const prototype = diagnostics.A1AttemptDiagnostics.prototype;
  const original = { check: prototype.check, checkPublication: prototype.checkPublication, callStarted: prototype.callStarted,
    enter: prototype.enter, finish: prototype.finish };
  const calls = new Map<string, ObservedModelCall>();
  let segment = "setup";
  const controller = new AbortController();
  const check = (): void => {
    try { budget.check(); } catch (error) { controller.abort(error); throw error; }
  };
  prototype.checkPublication = function () {
    try { check(); } catch (error) { this.incomplete(); throw error; }
    original.checkPublication.call(this);
  };
  prototype.check = function () {
    try { check(); } catch (error) { this.incomplete(); throw error; }
    original.check.call(this);
  };
  prototype.enter = function (phase) { segment = `a1:${phase}`; original.enter.call(this, phase); };
  prototype.callStarted = function (call) {
    original.callStarted.call(this, call);
    if (!OPERATIONS.has(call.operation)) { budget.fail("unknown_operation"); this.incomplete(); throw new Error("evaluation_unknown_operation"); }
    calls.set(call.logical_call_id, { ...call });
  };
  prototype.finish = function (complete) {
    if (complete) {
      try { check(); } catch (error) { original.finish.call(this, false); throw error; }
    }
    original.finish.call(this, complete);
  };
  const nativeFetch = options.transport ?? globalThis.fetch;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    check();
    const call = calls.get(observer.observedLogicalCallId() ?? "");
    const body = init?.body;
    if (!call || init?.method !== "POST" || typeof body !== "string") {
      budget.fail("unobserved_or_unknown_transport"); throw new Error("evaluation_unknown_transport");
    }
    const parsed = JSON.parse(body) as { model?: string; tools?: unknown[] };
    if (parsed.model !== call.model || !Array.isArray(parsed.tools) || parsed.tools.length !== 1) {
      budget.fail("request_metadata_mismatch"); throw new Error("evaluation_request_metadata_mismatch");
    }
    const attempt = budget.reserve(call, segment, body, Number(new Headers(init.headers).get("x-stainless-retry-count") ?? 0));
    writeFileSync(join(options.root, `request-${attempt}.json`), body, { flag: "wx", mode: 0o600 });
    // The whole serialized body is private; never save credentials, headers, or endpoint URLs.
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    check(); // Synchronous budget/request I/O may itself cross the deadline or a parent STOP.
    const response = await nativeFetch(input, { ...init, signal });
    check();
    if (!response.body) return response;
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          check(); const next = await reader.read(); check();
          if (next.done) target.close(); else target.enqueue(next.value);
        } catch (error) { target.error(error); void reader.cancel(error).catch(() => undefined); }
      },
      cancel(reason) { return reader.cancel(reason); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const timer = setInterval(() => { try { check(); } catch { /* sticky marker already exists */ } }, 100);
  timer.unref();
  const bridge: EvaluationBridge = {
    budget, segment: (value) => { check(); segment = `identity:${value}`; }, check,
    dispose: () => {
      clearInterval(timer); Object.assign(prototype, original); globalThis.fetch = savedFetch; controller.abort();
      if (globalThis.d7EvaluationBridge === bridge) globalThis.d7EvaluationBridge = undefined;
    },
  };
  globalThis.d7EvaluationBridge = bridge;
  // The child imports these same absolute candidate URLs. A missing bridge fails before any HTTP.
  return bridge;
}

if (process.env.D7_EVALUATION_CHILD === "1") {
  const candidate = process.env.D7_EVALUATION_CANDIDATE, root = process.env.D7_EVALUATION_ROOT, nonce = process.env.D7_EVALUATION_NONCE;
  if (!candidate || !root || !nonce) throw new Error("evaluation_preload_configuration_missing");
  await installEvaluationBridge({ candidate, root, nonce });
}

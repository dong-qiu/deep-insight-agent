/** C3 scoped metadata only. No implicit DB, no prompt/response/endpoint persistence. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/index.js";
import { beginModelUsageAttempt, observeModelUsage, type UsageNumbers } from "../db/model-usage.js";
import { throwIfAborted } from "./cancellation.js";

type Role = "analyzer" | "validator" | "coverage" | "followup";
type Provider = "anthropic" | "volcengine-responses";
interface UsageJob {
  db: DB; runId: string; traceId: string | null; signal: AbortSignal; assertWrite?: () => void;
  failure?: Error; finished: boolean;
}
interface UsageCall { job: UsageJob; id: string; attempt: number; role: Role; model: string; provider: Provider }
const jobs = new AsyncLocalStorage<UsageJob>();
const calls = new AsyncLocalStorage<UsageCall>();
export function createUsageJobScope(input: Omit<UsageJob, "finished" | "failure">) {
  const job: UsageJob = { ...input, finished: false };
  return {
    run: <T>(work: () => Promise<T>): Promise<T> => jobs.run(job, work),
    check: (): void => { if (job.failure) throw job.failure; },
    finish: (): void => { job.finished = true; },
  };
}
export async function withUsageCall<T>(role: Role, model: string, provider: Provider, work: () => Promise<T>): Promise<T> {
  const job = jobs.getStore();
  if (!job) return work();
  if (job.failure) throw job.failure;
  throwIfAborted(job.signal);
  return calls.run({ job, id: randomUUID(), attempt: 0, role, model, provider }, async () => {
    try {
      const value = await work();
      if (job.failure) throw job.failure;
      return value;
    } catch (error) {
      // SDK can wrap local DB faults as APIConnectionError. Keep the fixed local diagnosis.
      if (job.failure && !job.signal.aborted) throw job.failure;
      throw error;
    }
  });
}
function protectedWrite(job: UsageJob, attemptId: string, work: () => void): void {
  try { work(); } catch (error) {
    const fenceLost = error instanceof Error && error.message === "generation_fence_lost";
    const failure = fenceLost ? error : new Error("usage_persistence_failed");
    job.failure ??= failure;
    const diagnostic = fenceLost ? "usage_fence_lost" : !job.db.open ? "usage_store_closed" : "usage_persistence_failed";
    // Even after cancelled Job cleanup this callback has a controlled, body-free diagnosis.
    console.warn(diagnostic, { attempt_id: attemptId, job_finished: job.finished });
    throw failure;
  }
}
export function beginUsageAttempt(): { observe: (usage: UsageNumbers, final: boolean) => void } | undefined {
  const call = calls.getStore();
  if (!call) return undefined;
  const { job } = call;
  // Mandatory gate for every actual fetch, including SDK-owned retries.
  if (job.failure) throw job.failure;
  throwIfAborted(job.signal);
  const attemptId = randomUUID();
  protectedWrite(job, attemptId, () => beginModelUsageAttempt(job.db, {
    attempt_id: attemptId, logical_call_id: call.id, attempt_number: ++call.attempt,
    run_id: job.runId, trace_id: job.traceId, role: call.role, model: call.model, provider: call.provider,
    started_at: new Date().toISOString(),
  }, job.assertWrite));
  let revision = 0;
  return {
    observe(usage, final) {
      // Cancellation rejects business results but does not erase actually observed usage.
      // The original guard is executed *inside* each repository write transaction.
      protectedWrite(job, attemptId, () => observeModelUsage(job.db, attemptId, { usage, final, observation_number: ++revision }, job.assertWrite));
    },
  };
}
const emptyUsage = (): UsageNumbers => ({ input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null });
function numeric(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Classify original envelopes before legacy normalization can turn missing fields into zero. */
export function readReportedUsage(raw: unknown, provider: Provider): UsageNumbers {
  const usage = object(raw);
  return {
    input_tokens: numeric(usage?.input_tokens), output_tokens: numeric(usage?.output_tokens),
    cache_creation_input_tokens: provider === "anthropic" ? numeric(usage?.cache_creation_input_tokens) : null,
    cache_read_input_tokens: provider === "anthropic" ? numeric(usage?.cache_read_input_tokens) : numeric(object(usage?.input_tokens_details)?.cached_tokens),
  };
}

/** Bounded SSE observer. Byte delivery/acceptance remains owned by the SDK, not this parser. */
export function createAnthropicUsageObserver(observe: (usage: UsageNumbers, final: boolean) => void) {
  const decoder = new TextDecoder();
  const maxFrameChars = 262_144;
  let pending = "";
  let skipping = false;
  let usage = emptyUsage();
  let sawFinalOutput = false;
  let incomplete = false;
  let trailingCR = false;
  const invalidFields = new Set<keyof UsageNumbers>();
  const consume = (frame: string): void => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    let parsed: Record<string, unknown> | undefined;
    try { parsed = object(JSON.parse(data)); } catch { return; } // SDK still owns malformed protocol errors.
    if (parsed?.type === "message_start") {
      usage = readReportedUsage(object(parsed.message)?.usage, "anthropic");
      sawFinalOutput = false; invalidFields.clear();
      observe(usage, false);
    } else if (parsed?.type === "message_delta") {
      const patch = object(parsed.usage);
      if (!patch) return;
      for (const field of Object.keys(usage) as Array<keyof UsageNumbers>) {
        if (Object.hasOwn(patch, field)) {
          const value = numeric(patch[field]);
          if (value === null) invalidFields.add(field); else { invalidFields.delete(field); usage[field] = value; }
          if (field === "output_tokens") sawFinalOutput = value !== null;
        }
      }
      observe({ ...usage }, false);
    } else if (parsed?.type === "message_stop") {
      observe({ ...usage }, sawFinalOutput && !incomplete && invalidFields.size === 0);
    }
  };
  return (chunk: Uint8Array | undefined): void => {
    let decoded = decoder.decode(chunk, { stream: chunk !== undefined });
    if (decoded.length) {
      if (trailingCR && decoded.startsWith("\n")) decoded = decoded.slice(1);
      trailingCR = decoded.endsWith("\r");
    }
    const text = pending + decoded.replace(/\r\n|\r/g, "\n");
    let start = 0;
    const boundaries = /\n\n/g;
    let boundary: RegExpExecArray | null;
    while ((boundary = boundaries.exec(text))) {
      const frameLength = boundary.index - start;
      if (!skipping && frameLength <= maxFrameChars) consume(text.slice(start, boundary.index));
      else if (!skipping) { incomplete = true; console.warn("usage_observation_incomplete"); }
      skipping = false; start = boundary.index + boundary[0].length;
    }
    if (text.length - start > maxFrameChars) {
      if (!skipping) { incomplete = true; console.warn("usage_observation_incomplete"); }
      skipping = true; pending = text.slice(-3);
    } else pending = text.slice(start);
    if (chunk === undefined) { if (!skipping && pending.trim()) consume(pending); pending = ""; }
  };
}

/** Installed as Anthropic's real fetch: SDK internal retries all cross this boundary. */
export const usageTrackedAnthropicFetch: typeof fetch = async (input, init) => {
  const attempt = beginUsageAttempt();
  const response = await globalThis.fetch(input, init);
  if (!attempt || !response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const ingest = createAnthropicUsageObserver(attempt.observe);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        ingest(done ? undefined : value); // Commit observed usage before delivering the original bytes.
        if (cancelled) return;
        if (done) controller.close(); else controller.enqueue(value!);
      } catch (error) {
        // If SDK cancelled during read, still consume/diagnose the late observation rejection.
        if (!cancelled) controller.error(error);
        void reader.cancel().catch(() => undefined);
      }
    },
    async cancel(reason) { cancelled = true; await reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
};

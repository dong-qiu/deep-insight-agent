/** Optional metadata observer for explicitly scoped, non-Job diagnostics. No DB or pricing. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { UsageNumbers } from "../db/model-usage.js";
import { awaitWithSignal } from "./cancellation.js";

export interface ObservedModelCall {
  logical_call_id: string;
  role: "analyzer" | "validator" | "coverage" | "followup";
  model: string;
  provider: "anthropic" | "volcengine-responses";
  operation: string;
}
export interface ModelCallObserver {
  signal: AbortSignal;
  check(): void;
  callStarted(call: ObservedModelCall): void;
  callEnded(call: ObservedModelCall, succeeded: boolean): void;
  attemptStarted(call: ObservedModelCall, attemptId: string, number: number): {
    dispatched(sdkRetryNumber: number | null): void;
    headers(): void;
    ended(state: "eof" | "http_error" | "error" | "cancelled"): void;
    usage(usage: UsageNumbers, final: boolean): void;
  };
}
const scopes = new AsyncLocalStorage<ModelCallObserver>();
const calls = new AsyncLocalStorage<{ call: ObservedModelCall; number: number }>();
export function withModelCallObserver<T>(observer: ModelCallObserver, work: () => Promise<T>): Promise<T> {
  return scopes.run(observer, work);
}
export function observedLogicalCallId(): string | undefined { return calls.getStore()?.call.logical_call_id; }
export function checkModelCallObserver(): void { scopes.getStore()?.check(); }
export async function observeModelCall<T>(metadata: Omit<ObservedModelCall, "logical_call_id">, work: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const observer = scopes.getStore();
  if (!observer) return work(signal);
  observer.check();
  const call = { ...metadata, logical_call_id: randomUUID() };
  observer.callStarted(call);
  let succeeded = false;
  try {
    const merged = signal ? AbortSignal.any([signal, observer.signal]) : observer.signal;
    const value = await calls.run({ call, number: 0 }, () => awaitWithSignal(work(merged), merged));
    observer.check(); // A provider ignoring abort must never revive an expired scope.
    succeeded = true;
    return value;
  } catch (error) {
    observer.check(); // Preserve local sticky failure through SDK error wrapping.
    throw error;
  } finally { observer.callEnded(call, succeeded); }
}

/** One fetch invocation is one observable attempt, including SDK-owned retries. */
export function beginObservedModelAttempt() {
  const observer = scopes.getStore();
  if (!observer) return undefined;
  observer.check();
  const current = calls.getStore();
  if (!current) throw new Error("model_observer_missing_call");
  const attemptId = randomUUID();
  const number = ++current.number;
  let event: ReturnType<ModelCallObserver["attemptStarted"]> | undefined;
  let ended = false;
  const end = (state: "eof" | "http_error" | "error" | "cancelled"): void => { if (!ended) { ended = true; event?.ended(state); } };
  const transport: typeof fetch = async (input, init) => {
    // Check at dispatch, after request serialization/C3 preparation, including blocked timers.
    observer.check();
    event = observer.attemptStarted(current.call, attemptId, number);
    const retryHeader = new Headers(init?.headers).get("x-stainless-retry-count");
    const retryNumber = retryHeader === null ? null : Number(retryHeader);
    event!.dispatched(retryNumber !== null && Number.isSafeInteger(retryNumber) && retryNumber >= 0 ? retryNumber : null);
    const signal = init?.signal;
    const onAbort = (): void => end("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (state: Parameters<typeof end>[0]): void => { end(state); signal?.removeEventListener("abort", onAbort); };
    try {
      const response = await globalThis.fetch(input, init);
      event!.headers();
      if (!response.ok || !response.body) { finish(response.ok ? "eof" : "http_error"); return response; }
      const reader = response.body.getReader();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) { finish("eof"); controller.close(); } else controller.enqueue(value!);
          } catch (error) { finish("error"); if (!cancelled) controller.error(error); void reader.cancel().catch(() => undefined); }
        },
        async cancel(reason) { cancelled = true; finish("cancelled"); await reader.cancel(reason); },
      }, { highWaterMark: 0 });
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
      return wrapped;
    } catch (error) { finish(signal?.aborted ? "cancelled" : "error"); throw error; }
  };
  return { attemptId, number, observe: (usage: UsageNumbers, final: boolean) => event?.usage(usage, final), fetch: transport };
}

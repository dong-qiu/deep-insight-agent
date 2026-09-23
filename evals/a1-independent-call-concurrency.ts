/**
 * A bounded parallelism control for A1 calls that have no shared model context: the labelled
 * single-claim judge and standalone safety fixtures. Analyzer chunks remain deliberately
 * sequential so their checkpoint and long-context behaviour are unchanged.
 */
export const DEFAULT_A1_INDEPENDENT_CALL_CONCURRENCY = 1;
export const MAX_A1_INDEPENDENT_CALL_CONCURRENCY = 2;

/** Optional execution-only hook. It receives coordinates only, never the (possibly sensitive)
 * mapper result, and its failure cannot change evaluation execution or scoring. */
export interface A1IndependentCallHooks {
  onSettled?: (index: number) => void | Promise<void>;
}

function warnProgressHookFailure(): void {
  console.warn("A1 independent-call progress hook failed; continuing evaluation");
}

export function a1IndependentCallConcurrency(raw = process.env.A1_INDEPENDENT_CALL_CONCURRENCY): number {
  if (raw == null || raw === "") return DEFAULT_A1_INDEPENDENT_CALL_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_A1_INDEPENDENT_CALL_CONCURRENCY) {
    throw new Error(`A1_INDEPENDENT_CALL_CONCURRENCY 必须是 1–${MAX_A1_INDEPENDENT_CALL_CONCURRENCY} 的整数`);
  }
  return value;
}

/** Map in source order while admitting at most `concurrency` independent calls at once. */
export async function mapA1IndependentCalls<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  hooks: A1IndependentCallHooks = {},
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_A1_INDEPENDENT_CALL_CONCURRENCY) {
    throw new Error(`A1 independent-call concurrency 必须是 1–${MAX_A1_INDEPENDENT_CALL_CONCURRENCY}`);
  }
  const output = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      const result = await mapper(values[index]!, index);
      output[index] = result;
      try {
        // Do not await a progress observer: it is deliberately outside call admission and
        // scoring. Still consume a future rejection so an accidental async hook cannot become
        // a process-level unhandled rejection after the evaluation has otherwise succeeded.
        void Promise.resolve(hooks.onSettled?.(index)).catch(warnProgressHookFailure);
      } catch {
        // A1 progress is best-effort operational telemetry. Do not turn a disk/UI observer
        // failure into a changed sample, changed score, or failed model execution.
        warnProgressHookFailure();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

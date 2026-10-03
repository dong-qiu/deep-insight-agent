/** Cooperative task cancellation. Commit fencing remains the caller's responsibility. */
export interface TaskCancellationOptions {
  signal?: AbortSignal;
  /** Absolute Unix milliseconds; omitted means no whole-task deadline. */
  deadlineAt?: number;
}
export type TaskCancellationReason = "cancelled" | "task_deadline_exceeded" | "generation_fence_lost";
export class TaskCancellationError extends Error {
  constructor(readonly reasonCode: TaskCancellationReason) {
    super(reasonCode);
    this.name = reasonCode === "cancelled" ? "cancelled" : reasonCode === "task_deadline_exceeded" ? "TimeoutError" : "AbortError";
  }
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new TaskCancellationError("cancelled");
}
function validateDeadlineAt(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) throw new RangeError("invalid_task_deadline");
}
export function cancellationCheckpoint(opts: TaskCancellationOptions): void {
  validateDeadlineAt(opts.deadlineAt);
  throwIfAborted(opts.signal);
  if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) throw new TaskCancellationError("task_deadline_exceeded");
}
export function createTaskCancellation(opts: TaskCancellationOptions = {}): {
  signal: AbortSignal; check: () => void; dispose: () => void;
} {
  validateDeadlineAt(opts.deadlineAt);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    opts.signal?.removeEventListener("abort", onAbort);
  };
  const cancel = (reason: TaskCancellationReason): void => {
    if (controller.signal.aborted) return;
    controller.abort(new TaskCancellationError(reason));
    cleanup();
  };
  const onAbort = (): void => cancel(opts.signal?.reason instanceof TaskCancellationError ? opts.signal.reason.reasonCode : "cancelled");
  const arm = (): void => {
    if (opts.deadlineAt === undefined || controller.signal.aborted) return;
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) cancel("task_deadline_exceeded");
    // Re-arm very distant deadlines rather than overflowing Node's timer range.
    else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  if (opts.signal?.aborted) onAbort();
  else { opts.signal?.addEventListener("abort", onAbort, { once: true }); arm(); }
  return {
    signal: controller.signal,
    check: () => { if (!controller.signal.aborted && opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) cancel("task_deadline_exceeded"); throwIfAborted(controller.signal); },
    dispose: cleanup,
  };
}
/** The signal must also be passed to the actual operation; this only stops waiting and consumes
 * late rejection. It cannot undo provider work, charges, or already committed results. */
export function awaitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new TaskCancellationError("cancelled")); };
    // Attach both handlers even if already aborted: work may already be running.
    void work.then((value) => { cleanup(); if (signal.aborted) onAbort(); else resolve(value); }, (error: unknown) => { cleanup(); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const onAbort = (): void => { cleanup(); reject(signal?.reason ?? new TaskCancellationError("cancelled")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Job Runner —— Run 实体编排：建 Run(running) → 跑 fn → 落 done/failed + 成本 + 错误。
 *  支撑管理看板「流水线追踪 / 失败下钻 / 重试」（architecture 运行实体 Run）。 */
import { createTaskCancellation, type TaskCancellationOptions } from "./cancellation.js";
import { createUsageJobScope } from "./model-usage.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DB } from "../db/index.js";
import { finishRun, getRun, insertRun } from "../db/repos.js";
import { notifyFailure } from "./alert.js";
import { safeError } from "./diagnostics.js";
import type { Cost, Run } from "../types.js";

export interface JobSpec extends TaskCancellationOptions {
  kind: Run["kind"];
  target: Run["target"];
  /** P0a：调用方必须显式传入已创建的 trace；历史调用可暂时省略。 */
  traceId?: string | null;
  /** durable dispatch 已在 claim 事务创建的唯一 root Run；仅首个 analyze 使用。 */
  existingRunId?: string;
  retryOf?: string | null;
  silent?: boolean; // 失败不发 notifyFailure（半开探测用，3b-2：探测失败不刷告警）
  /** durable dispatch 传入的 fencing guard；每个 Run 写入前都必须仍持有 claim。 */
  assertWrite?: () => void;
}
export interface JobCtx {
  signal: AbortSignal;
  /** Cancellation checkpoint only; never substitutes for assertWrite. */
  checkCancellation(): void;
  runId: string;
  /** fn 内累加本次运行成本（多次调用累加，写入 Run.cost） */
  recordCost(cost: Cost): void;
}
export interface JobOutcome<T> {
  run: Run;
  result: T;
}

export async function runJob<T>(
  db: DB,
  spec: JobSpec,
  fn: (ctx: JobCtx) => Promise<T>,
): Promise<JobOutcome<T>> {
  const cancellation = createTaskCancellation(spec);
  try {
    const runId = spec.existingRunId ?? `run_${randomUUID().slice(0, 8)}`;
    // 单调时钟测耗时，避免墙钟 NTP 跳变让 duration 出现负值/突跳
    const startedMono = performance.now();
    if (!spec.existingRunId) {
      spec.assertWrite?.();
      insertRun(db, {
        id: runId, kind: spec.kind, target: spec.target, status: "running",
        started_at: new Date().toISOString(), ended_at: null, duration_ms: null,
        cost: null, error: null, retry_of: spec.retryOf ?? null, trace_id: spec.traceId ?? null,
      });
    }

    const usageScope = createUsageJobScope({ db, runId, traceId: spec.traceId ?? null, signal: cancellation.signal, assertWrite: spec.assertWrite });
    let cost: Cost | null = null;
    const ctx: JobCtx = {
      runId, signal: cancellation.signal, checkCancellation: () => { cancellation.check(); usageScope.check(); },
      recordCost(c) {
        cost = cost
          ? { tokens: cost.tokens + c.tokens, amount: cost.amount + c.amount, ...(cost.estimated || c.estimated ? { estimated: true } : {}) }
          : { ...c };
      },
    };
    const elapsed = (): number => Math.round(performance.now() - startedMono);

    try {
      cancellation.check();
      const result = await usageScope.run(() => fn(ctx));
      usageScope.check();
      cancellation.check();
      spec.assertWrite?.();
      finishRun(db, runId, { status: "done", cost, duration_ms: elapsed() });
      return { run: getRun(db, runId)!, result };
    } catch (e) {
      // A provider may reject with an opaque payload after cancellation. Fix the task reason.
      const failure = cancellation.signal.aborted ? cancellation.signal.reason : e;
      const err = safeError(failure);
      spec.assertWrite?.();
      finishRun(db, runId, {
        status: "failed", cost, duration_ms: elapsed(),
        error: err,
      });
      // 失败告警（运维附条件②）：fire-and-forget，ALERT_WEBHOOK 未配置则 no-op，永不连累抛出。
      // silent（半开探测）→ 跳过：探测失败属预期、不刷告警（ADR-0008 决定② / 切片3b-2，评审🔴）。
      if (!spec.silent) {
        notifyFailure({ runId, kind: spec.kind, target: spec.target, errorType: err.type, message: err.message });
      }
      throw failure;
    } finally { usageScope.finish(); }
  } finally { cancellation.dispose(); }
}

/** 重试失败的 Run：以新 Run（retry_of 指向原 Run）重跑 fn。 */
export function retryJob<T>(
  db: DB,
  failedRunId: string,
  fn: (ctx: JobCtx) => Promise<T>,
): Promise<JobOutcome<T>> {
  const orig = getRun(db, failedRunId);
  if (!orig) throw new Error(`找不到 Run ${failedRunId}`);
  return runJob(db, { kind: orig.kind, target: orig.target, retryOf: failedRunId }, fn);
}

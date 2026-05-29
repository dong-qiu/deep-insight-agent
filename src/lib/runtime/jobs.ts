/** Job Runner —— Run 实体编排：建 Run(running) → 跑 fn → 落 done/failed + 成本 + 错误。
 *  支撑管理看板「流水线追踪 / 失败下钻 / 重试」（architecture 运行实体 Run）。 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DB } from "../db/index.js";
import { finishRun, getRun, insertRun } from "../db/repos.js";
import { notifyFailure } from "./alert.js";
import type { Cost, Run } from "../types.js";

export interface JobSpec {
  kind: Run["kind"];
  target: Run["target"];
  retryOf?: string | null;
}
export interface JobCtx {
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
  const runId = `run_${randomUUID().slice(0, 8)}`;
  // 单调时钟测耗时，避免墙钟 NTP 跳变让 duration 出现负值/突跳
  const startedMono = performance.now();
  insertRun(db, {
    id: runId, kind: spec.kind, target: spec.target, status: "running",
    started_at: new Date().toISOString(), ended_at: null, duration_ms: null,
    cost: null, error: null, retry_of: spec.retryOf ?? null,
  });

  let cost: Cost | null = null;
  const ctx: JobCtx = {
    runId,
    recordCost(c) {
      cost = cost ? { tokens: cost.tokens + c.tokens, amount: cost.amount + c.amount } : { ...c };
    },
  };
  const elapsed = (): number => Math.round(performance.now() - startedMono);

  try {
    const result = await fn(ctx);
    finishRun(db, runId, { status: "done", cost, duration_ms: elapsed() });
    return { run: getRun(db, runId)!, result };
  } catch (e) {
    const err = e as Error;
    finishRun(db, runId, {
      status: "failed", cost, duration_ms: elapsed(),
      error: { type: err.name, message: err.message, stack: err.stack },
    });
    // 失败告警（运维附条件②）：fire-and-forget，ALERT_WEBHOOK 未配置则 no-op，永不连累抛出
    notifyFailure({ runId, kind: spec.kind, target: spec.target, errorType: err.name, message: err.message });
    throw e;
  }
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

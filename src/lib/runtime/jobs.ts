/** Job Runner —— Run 实体编排：建 Run(running) → 跑 fn → 落 done/failed + 成本 + 错误。
 *  支撑管理看板「流水线追踪 / 失败下钻 / 重试」（architecture 运行实体 Run）。 */
import { randomUUID } from "node:crypto";
import type { DB } from "../db/index.js";
import { finishRun, getRun, insertRun } from "../db/repos.js";
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

  try {
    const result = await fn(ctx);
    finishRun(db, runId, { status: "done", cost });
    return { run: getRun(db, runId)!, result };
  } catch (e) {
    const err = e as Error;
    finishRun(db, runId, {
      status: "failed", cost,
      error: { type: err.name, message: err.message, stack: err.stack },
    });
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

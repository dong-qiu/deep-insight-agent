/** One sequential-child task budget. The child owns state; parent cancellation is a separate file. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservedModelCall } from "../src/lib/runtime/model-call-observer.js";

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function privateJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
export interface TaskBudget {
  version: 1; nonce: string; deadline: number; max_attempts: number; max_retries: number;
  owner: number | null; failure: string | null; execution_complete: boolean;
  attempts: Array<ObservedModelCall & { segment: string; body_sha256: string; bytes: number; retry: boolean; at: number }>;
}
export function createBudget(root: string, limits = { attempts: 100, retries: 20, window: 2700000 }): TaskBudget {
  const value: TaskBudget = { version: 1, nonce: randomUUID(), deadline: Date.now() + limits.window,
    max_attempts: limits.attempts, max_retries: limits.retries, owner: null, failure: null, execution_complete: false, attempts: [] };
  writeFileSync(join(root, "budget.json"), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return value;
}
export function cancelTask(root: string, reason: string): void {
  try { writeFileSync(join(root, "STOP"), reason, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
export class EvaluationBudget {
  constructor(readonly root: string, readonly nonce: string, readonly owner: number | null) {}
  read(): TaskBudget {
    const value = JSON.parse(readFileSync(join(this.root, "budget.json"), "utf8")) as TaskBudget;
    if (value.version !== 1 || value.nonce !== this.nonce || value.owner !== this.owner
      || !Array.isArray(value.attempts) || !Number.isSafeInteger(value.deadline)
      || !Number.isSafeInteger(value.max_attempts) || value.max_attempts < 0 || value.max_attempts > 100
      || !Number.isSafeInteger(value.max_retries) || value.max_retries < 0 || value.max_retries > 20) {
      cancelTask(this.root, "budget_corrupt_or_wrong_owner"); throw new Error("evaluation_budget_invalid");
    }
    return value;
  }
  check(): TaskBudget {
    const value = this.read();
    if (existsSync(join(this.root, "STOP")) || value.failure || value.execution_complete) throw new Error("evaluation_task_stopped");
    if (Date.now() >= value.deadline) { this.fail("deadline"); throw new Error("evaluation_deadline"); }
    return value;
  }
  fail(reason: string): void {
    cancelTask(this.root, reason);
    const value = this.read(); value.failure ??= reason; value.execution_complete = false;
    privateJson(join(this.root, "budget.json"), value);
  }
  /** Called synchronously immediately before native fetch. Retry/amplification reasons form a union. */
  reserve(call: ObservedModelCall, segment: string, body: string, sdkRetry: number): number {
    const value = this.check(), hash = digest(body);
    const previous = value.attempts.filter((entry) => entry.segment === segment);
    const retry = sdkRetry > 0 || previous.some((entry) => entry.logical_call_id === call.logical_call_id
      || (entry.model === call.model && entry.body_sha256 === hash))
      || (call.operation === "analysis_generation" && previous.some((entry) => entry.operation === "analysis_generation"))
      || /repair|backfill/.test(call.operation);
    if (value.attempts.length >= value.max_attempts || (retry && value.attempts.filter((entry) => entry.retry).length >= value.max_retries)) {
      this.fail(value.attempts.length >= value.max_attempts ? "attempt_limit" : "retry_limit");
      throw new Error("evaluation_admission_limit");
    }
    value.attempts.push({ ...call, segment, body_sha256: hash, bytes: Buffer.byteLength(body), retry, at: Date.now() });
    privateJson(join(this.root, "budget.json"), value);
    return value.attempts.length;
  }
}

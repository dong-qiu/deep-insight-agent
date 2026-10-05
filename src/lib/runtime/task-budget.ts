/** Task-local legacy estimates. No reservations, billing claims, attempt sums or implicit DB. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "../db/index.js";
import { getRun, listRunCostsForTrace } from "../db/repos.js";
import type { Cost } from "../types.js";

export interface TaskBudgetOptions { taskBudgetUsd?: number }
export class TaskBudgetError extends Error {
  constructor(readonly reasonCode: "task_budget_exceeded" | "task_budget_cost_invalid" | "invalid_task_budget") {
    super(reasonCode);
  }
}
interface Budget { limit: number; costs: Map<string, Cost | null>; failure?: TaskBudgetError }
const budgets = new AsyncLocalStorage<Budget>();

export function validateTaskBudget(limit: number | undefined): void {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) throw new TaskBudgetError("invalid_task_budget");
}
/** Worker opt-in only; standalone Jobs do not inherit deployment env implicitly. */
export function loadTaskBudgetUsd(env: Record<string, string | undefined> = process.env): number | undefined {
  if (env.COST_LIMIT_TASK === undefined) return undefined;
  if (!env.COST_LIMIT_TASK.trim()) throw new TaskBudgetError("invalid_task_budget");
  const limit = Number(env.COST_LIMIT_TASK);
  validateTaskBudget(limit);
  return limit;
}
function validateCost(cost: Cost | null): void {
  if (cost !== null && (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0)) throw new TaskBudgetError("task_budget_cost_invalid");
}
function refresh(budget: Budget): void {
  const spent = [...budget.costs.values()].reduce((sum, cost) => sum + (cost?.amount ?? 0), 0);
  if (!Number.isFinite(spent)) budget.failure ??= new TaskBudgetError("task_budget_cost_invalid");
  else if (spent >= budget.limit) budget.failure ??= new TaskBudgetError("task_budget_exceeded");
}
export function withTaskBudget<T>(db: DB, opts: TaskBudgetOptions & { traceId?: string | null }, work: () => Promise<T>): Promise<T> {
  validateTaskBudget(opts.taskBudgetUsd);
  if (budgets.getStore() || opts.taskBudgetUsd === undefined) return work();
  const budget: Budget = { limit: opts.taskBudgetUsd, costs: new Map() };
  if (opts.traceId) {
    let rows: ReturnType<typeof listRunCostsForTrace>;
    try { rows = listRunCostsForTrace(db, opts.traceId); } catch { throw new TaskBudgetError("task_budget_cost_invalid"); }
    for (const { id, cost } of rows) { validateCost(cost); budget.costs.set(id, cost); }
  }
  refresh(budget);
  return budgets.run(budget, work);
}
export function taskBudgetEnabled(): boolean { return budgets.getStore() !== undefined; }
export function taskBudgetFailure(): TaskBudgetError | undefined { return budgets.getStore()?.failure; }
export function checkTaskBudget(): void { const failure = taskBudgetFailure(); if (failure) throw failure; }
/** Validate recovery inputs before a Job can rewrite its persisted facts. */
export function readBudgetRunCost(db: DB, runId: string): Cost | null {
  try { const cost = getRun(db, runId)?.cost ?? null; validateCost(cost); return cost; }
  catch { throw new TaskBudgetError("task_budget_cost_invalid"); }
}
/** Enroll once; replacing a persisted entry is not a second expense. */
export function enrollBudgetRun(runId: string, cost: Cost | null): void {
  const budget = budgets.getStore();
  if (!budget || budget.costs.has(runId)) return;
  validateCost(cost); budget.costs.set(runId, cost); refresh(budget);
}
export function budgetRunCost(runId: string): Cost | null { return budgets.getStore()?.costs.get(runId) ?? null; }
/** Record before reporting failure, including already-dispatched sibling responses. */
export function recordBudgetCost(runId: string, cost: Cost): void {
  const budget = budgets.getStore();
  if (!budget) return;
  try {
    validateCost(cost);
    const previous = budget.costs.get(runId);
    const cumulative = previous ? { tokens: previous.tokens + cost.tokens, amount: previous.amount + cost.amount,
      ...(previous.estimated || cost.estimated ? { estimated: true } : {}) } : { ...cost };
    validateCost(cumulative);
    budget.costs.set(runId, cumulative); refresh(budget);
  } catch { budget.failure ??= new TaskBudgetError("task_budget_cost_invalid"); }
}

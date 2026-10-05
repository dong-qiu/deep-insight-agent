import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { claimNextGenerationDispatch, createScheduledTraceRequest } from "../db/provenance.js";
import { getRun, insertRun, insertTopic, listRuns, sumRunCostSince } from "../db/repos.js";
import * as repos from "../db/repos.js";
import { beginModelUsageAttempt, observeModelUsage } from "../db/model-usage.js";
import { runJob } from "./jobs.js";
import { checkTaskBudget, loadTaskBudgetUsd, withTaskBudget } from "./task-budget.js";

vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));
let db: DB;
beforeEach(() => { db = openDb(":memory:"); applyProvenanceMigrations(db); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
function trace() {
  insertTopic(db, { id: "t", name: "synthetic", keywords: [], language: "en", enabled: true, brief_schedule: "daily" });
  createScheduledTraceRequest(db, { topicId: "t", reportType: "brief", period: "synthetic", windowHours: 24, items: 1 });
  return claimNextGenerationDispatch(db)!;
}

it.each(["", " ", "bad-private-value", "NaN", "Infinity", "-1"])("invalid env %s has a fixed diagnosis", (value) => {
  expect(() => loadTaskBudgetUsd({ COST_LIMIT_TASK: value })).toThrow("invalid_task_budget");
});
it("optional env preserves unlimited; zero and decimals are explicit valid limits", () => {
  expect(loadTaskBudgetUsd({})).toBeUndefined();
  expect(loadTaskBudgetUsd({ COST_LIMIT_TASK: "0" })).toBe(0);
  expect(loadTaskBudgetUsd({ COST_LIMIT_TASK: "0.5" })).toBe(0.5);
});
it("unconfigured task has no budget read and preserves original Job costs", async () => {
  const query = vi.spyOn(repos, "listRunCostsForTrace");
  const { run } = await runJob(db, { kind: "analyze", target: {} }, async (ctx) => { ctx.recordCost({ tokens: 1, amount: 1 }); });
  expect(run.cost?.amount).toBe(1); expect(query).not.toHaveBeenCalled();
});
it("Run and attempt observations do not accumulate the same expense twice", async () => {
  const claim = trace();
  db.prepare("UPDATE run SET cost=? WHERE id=?").run(JSON.stringify({ tokens: 10, amount: 1 }), claim.rootRunId);
  beginModelUsageAttempt(db, { attempt_id: "a", logical_call_id: "l", attempt_number: 1, run_id: claim.rootRunId, trace_id: claim.traceId, role: "analyzer", provider: "anthropic", model: "claude-opus-4-7", started_at: new Date().toISOString() });
  observeModelUsage(db, "a", { observation_number: 1, final: true, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const { run } = await runJob(db, { kind: "analyze", target: {}, existingRunId: claim.rootRunId, traceId: claim.traceId, taskBudgetUsd: 3 }, async (ctx) => {
    ctx.recordCost({ tokens: 10, amount: 1 }); ctx.checkCancellation(); return "allowed";
  });
  expect(run.cost).toEqual({ tokens: 20, amount: 2 }); expect(sumRunCostSince(db, "2026")).toBe(2);
});
it("one task shares completed stage costs without adding their persisted copies again", async () => {
  await withTaskBudget(db, { taskBudgetUsd: 3 }, async () => {
    await runJob(db, { kind: "analyze", target: {} }, async (ctx) => ctx.recordCost({ tokens: 1, amount: 1 }));
    await runJob(db, { kind: "validate", target: {} }, async (ctx) => ctx.recordCost({ tokens: 1, amount: 1 }));
    checkTaskBudget();
    await expect(runJob(db, { kind: "analyze", target: {} }, async (ctx) => ctx.recordCost({ tokens: 1, amount: 1 }))).rejects.toThrow("task_budget_exceeded");
  });
  expect(listRuns(db).filter((run) => run.status === "done")).toHaveLength(2);
  expect(sumRunCostSince(db, "2026")).toBe(3);
});
it("restored trace inherits all persisted Run costs; another trace is excluded", async () => {
  const claim = trace();
  db.prepare("UPDATE run SET cost=? WHERE id=?").run(JSON.stringify({ tokens: 1, amount: 1 }), claim.rootRunId);
  insertRun(db, { id: "unrelated", kind: "analyze", target: {}, status: "done", started_at: new Date().toISOString(), ended_at: null, duration_ms: null, cost: { tokens: 1, amount: 100 }, error: null, retry_of: null });
  const work = vi.fn(async () => "should-not-run");
  await expect(runJob(db, { kind: "analyze", target: {}, traceId: claim.traceId, existingRunId: claim.rootRunId, taskBudgetUsd: 1 }, work)).rejects.toThrow("task_budget_exceeded");
  expect(work).not.toHaveBeenCalled(); expect(getRun(db, claim.rootRunId)?.cost?.amount).toBe(1);
  await withTaskBudget(db, { traceId: claim.traceId, taskBudgetUsd: 2 }, async () => checkTaskBudget());
  await withTaskBudget(db, { traceId: claim.traceId }, async () => checkTaskBudget());
});
it.each([NaN, Infinity, -1])("invalid live amount %s preserves valid accumulated facts", async (amount) => {
  await expect(runJob(db, { kind: "analyze", target: {}, taskBudgetUsd: 10 }, async (ctx) => {
    ctx.recordCost({ tokens: 1, amount: 1 }); ctx.recordCost({ tokens: 1, amount });
  })).rejects.toThrow("task_budget_cost_invalid");
  expect(listRuns(db)[0].cost?.amount).toBe(1);
});
it("invalid persisted cost rejects without repairing history", async () => {
  const claim = trace(); const invalid = '{"tokens":1,"amount":"synthetic-private"}';
  db.prepare("UPDATE run SET cost=? WHERE id=?").run(invalid, claim.rootRunId);
  await expect(runJob(db, { kind: "analyze", target: {}, traceId: claim.traceId, taskBudgetUsd: 10 }, async () => "never")).rejects.toThrow("task_budget_cost_invalid");
  expect(db.prepare("SELECT cost FROM run WHERE id=?").get(claim.rootRunId)).toEqual({ cost: invalid });
});
it.each(['{"tokens":1,"amount":-1}', '{synthetic-private'])("untraced recovered Run preserves invalid raw cost %s", async (invalid) => {
  insertRun(db, { id: "recovered", kind: "analyze", target: {}, status: "running", started_at: new Date().toISOString(), ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null });
  db.prepare("UPDATE run SET cost=? WHERE id=?").run(invalid, "recovered");
  const work = vi.fn(async () => "never");
  await expect(runJob(db, { kind: "analyze", target: {}, existingRunId: "recovered", taskBudgetUsd: 10 }, work)).rejects.toThrow("task_budget_cost_invalid");
  expect(work).not.toHaveBeenCalled();
  expect(db.prepare("SELECT cost, status FROM run WHERE id=?").get("recovered")).toEqual({ cost: invalid, status: "running" });
});
it("concurrent tasks keep separate allowances instead of pretending to enforce a global ceiling", async () => {
  let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
  const run = () => runJob(db, { kind: "analyze", target: {}, taskBudgetUsd: 2 }, async (ctx) => {
    await barrier; ctx.recordCost({ tokens: 1, amount: 1 }); return "ok";
  });
  const pending = Promise.all([run(), run()]); release();
  expect((await pending).map((job) => job.result)).toEqual(["ok", "ok"]);
  expect(sumRunCostSince(db, "2026")).toBe(2);
});

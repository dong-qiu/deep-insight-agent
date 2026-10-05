/** Real Job / callStructured / SDK; all transport and input are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v4";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { listRuns } from "../db/repos.js";
import { insertTopic } from "../db/repos.js";
import { assertGenerationDispatchClaim, claimNextGenerationDispatch, createScheduledTraceRequest } from "../db/provenance.js";
import { listModelUsageAttempts } from "../db/model-usage.js";
import { runJob, type JobCtx, type JobSpec } from "./jobs.js";
import { callStructured, MODELS } from "./llm.js";
import { judgeWithRetry } from "../agents/validator.js";
import { analyze, verifyQuoteSelfContained } from "../agents/analyzer.js";
import { notifyFailure } from "./alert.js";
import { resetRelayRecoveryStateForTest } from "./relay-recovery.js";
import type { ContentItem, Topic } from "../types.js";

vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));
let db: DB;
const savedModels = { ...MODELS };
beforeEach(() => {
  db = openDb(":memory:"); applyProvenanceMigrations(db);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("LLM_MAX_RETRIES", "1"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "1");
  vi.stubEnv("LLM_TRANSIENT_RETRY_BACKOFF_MS", "0");
  vi.stubEnv("VALIDATOR_RETRIES", "1"); vi.stubEnv("VALIDATOR_RETRY_BACKOFF_MS", "0");
  vi.stubEnv("VALIDATOR_THINKING", "0"); vi.stubEnv("COVERAGE_THINKING", "0");
  MODELS.analyzer = "claude-sonnet-4-6"; MODELS.validator = "claude-opus-4-7";
  MODELS.coverage = "synthetic-independent-coverage";
  vi.mocked(notifyFailure).mockClear();
  resetRelayRecoveryStateForTest();
});
afterEach(() => { db.close(); Object.assign(MODELS, savedModels); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const opts = { role: "analyzer" as const, schema: z.object({ ok: z.boolean() }), system: "synthetic", user: "synthetic", maxTokens: 64 };
function syntheticSse(input: unknown = { ok: true }, stop = "tool_use") {
  return [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: MODELS.analyzer, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ].map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("");
}
const response = (body = syntheticSse()) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const spec = (taskBudgetUsd?: number): JobSpec & { taskBudgetUsd?: number } => ({ kind: "analyze", target: {}, silent: true, taskBudgetUsd });
const call = (ctx: JobCtx) => callStructured({ ...opts, signal: ctx.signal, onCost: ctx.recordCost });
const oneCost = (7 * 3 + 3 * 15) / 1_000_000;

it.each([undefined, 1])("normal SDK calls with budget %s preserve result, Run cost and attempts", async (limit) => {
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  const { run, result } = await runJob(db, spec(limit), call);
  expect(result.data).toEqual({ ok: true }); expect(run.cost?.amount).toBe(oneCost);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(listModelUsageAttempts(db, run.id).attempts[0].usage_status).toBe("reported");
});

it("zero budget rejects before transport and before C3's initial unknown row", async () => {
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(0), call)).rejects.toThrow("task_budget_exceeded");
  expect(transport).not.toHaveBeenCalled();
  const run = listRuns(db)[0]; expect(run).toMatchObject({ status: "failed", error: { message: "task_budget_exceeded" } });
  expect(listModelUsageAttempts(db, run.id).attempts).toHaveLength(0);
});

it.each([NaN, Infinity, -1])("illegal budget %s rejects without transport", async (limit) => {
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(limit), call)).rejects.toThrow("invalid_task_budget");
  expect(transport).not.toHaveBeenCalled();
});

it.each([oneCost, oneCost / 2])("at/crossing limit %s preserves paid usage and prevents refusal resubmission", async (limit) => {
  const transport = vi.fn(async () => response(syntheticSse({ ok: true }, "refusal"))); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(limit), call)).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(listRuns(db)[0].cost?.amount).toBe(oneCost);
  expect(listModelUsageAttempts(db, listRuns(db)[0].id).attempts[0].usage_status).toBe("reported");
});

it("SDK-owned retry rechecks the gate after a sibling consumed the allowance", async () => {
  let ctx!: JobCtx;
  const transport = vi.fn(async () => {
    ctx.recordCost({ tokens: 1, amount: 1 });
    return new Response("{}", { status: 503, headers: { "retry-after-ms": "1" } });
  }); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(1), (current) => { ctx = current; return call(ctx); })).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(listRuns(db)[0].cost?.amount).toBe(1);
});

it.each(["validator", "coverage"])("real %s outer retry or unavailable fallback cannot bypass the sticky gate", async (role) => {
  const transport = vi.fn(async () => response(syntheticSse({ invalid: true }))); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(oneCost / 2), async (ctx) => {
    if (role === "validator") await judgeWithRetry("synthetic", "synthetic", ctx.recordCost, undefined, undefined, ctx.signal);
    else await verifyQuoteSelfContained({ content_item_id: "synthetic", quote: "synthetic", locator: { paragraph_index: 0, char_start: 0, char_end: 9 } }, ctx.recordCost, ctx.signal);
    return "cannot-commit";
  })).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1); expect(listRuns(db)[0].status).toBe("failed");
});

it("swallowed budget failure cannot start another logical call or produce a done Run", async () => {
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(oneCost), async (ctx) => {
    await call(ctx).catch(() => undefined); await call(ctx).catch(() => undefined); return "cannot-commit";
  })).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("shared relay recovery does not transmit one task's exhausted budget to a healthy follower", async () => {
  vi.stubEnv("LLM_MAX_RETRIES", "0"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "0"); vi.stubEnv("VALIDATOR_RETRIES", "0");
  const transport = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { "x-should-retry": "false" } }))
    .mockImplementation(async () => response(syntheticSse({ consistency: "support", consistency_reason: "ok", rationale: "synthetic" })));
  vi.stubGlobal("fetch", transport);
  let release!: () => void; let ready!: () => void;
  const recovering = new Promise<void>((resolve) => { ready = resolve; });
  const setTimeoutOriginal = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay !== undefined && delay >= 10_000 && delay <= 10_250) {
      return setTimeoutOriginal(() => { release = () => handler(...args); ready(); }, 0);
    }
    return setTimeoutOriginal(handler, delay, ...args);
  });
  let exhaustLeader!: () => void;
  const leader = runJob(db, spec(1), (ctx) => {
    exhaustLeader = AsyncLocalStorage.bind(() => ctx.recordCost({ tokens: 1, amount: 1 }));
    return judgeWithRetry("synthetic", "synthetic", ctx.recordCost, undefined, undefined, ctx.signal);
  });
  const rejectedLeader = expect(leader).rejects.toThrow("task_budget_exceeded");
  await recovering;
  const follower = runJob(db, spec(10), (ctx) => judgeWithRetry("synthetic", "synthetic", ctx.recordCost, undefined, undefined, ctx.signal));
  const completedFollower = expect(follower).resolves.toMatchObject({ result: { consistency: "support" }, run: { status: "done" } });
  await Promise.resolve(); exhaustLeader(); release();
  await Promise.all([rejectedLeader, completedFollower]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(["omitted", "observer", "duplicate"])("configured Job accounts once with an %s onCost callback", async (callback) => {
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(oneCost), (ctx) => callStructured({ ...opts,
    onCost: callback === "omitted" ? undefined : callback === "observer" ? () => undefined : (cost) => { ctx.recordCost(cost); ctx.recordCost(cost); },
  }))).rejects.toThrow("task_budget_exceeded");
  expect(listRuns(db)[0].cost?.amount).toBe(oneCost);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("unknown Responses usage does not masquerade as a known zero or block its own dispatch", async () => {
  vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic");
  vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  const body = [
    { type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"ok":true}' },
    { type: "response.completed", response: { status: "completed", usage: {}, output: [] } },
  ].map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("");
  const transport = vi.fn(async () => response(body)); vi.stubGlobal("fetch", transport);
  const { run } = await runJob(db, spec(1), async (ctx) => { await call(ctx); await call(ctx); });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(listModelUsageAttempts(db, run.id).attempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ usage_status: "unknown", estimate_status: "unknown", input_tokens: null, output_tokens: null, estimate_usd: null }),
  ]));
});

it("partial Anthropic usage continues under the legacy estimate without fabricating complete billing", async () => {
  const body = syntheticSse().replace('"usage":{"output_tokens":3}', '"usage":{}');
  const transport = vi.fn(async () => response(body)); vi.stubGlobal("fetch", transport);
  const { run } = await runJob(db, spec(1), async (ctx) => { await call(ctx); await call(ctx); });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(listModelUsageAttempts(db, run.id).attempts.map((row) => row.usage_status)).toEqual(["partial", "partial"]);
  expect(listModelUsageAttempts(db, run.id).attempts[0].estimate_usd).toBeNull();
  expect(run.cost).toBeNull();
});

it("unpriced models retain unknown attempt prices but consume the existing nonzero fallback", async () => {
  MODELS.analyzer = "synthetic-unpriced";
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(0.0002), async (ctx) => { await call(ctx); await call(ctx); })).rejects.toThrow("task_budget_exceeded");
  const run = listRuns(db)[0]; expect(run.cost).toMatchObject({ estimated: true });
  expect(run.cost!.amount).toBeGreaterThan(0.0002);
  expect(listModelUsageAttempts(db, run.id).attempts.map((row) => row.estimate_usd)).toEqual([null, null]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(["cancelled", "task_deadline_exceeded", "generation_fence_lost"])("%s outranks a simultaneous budget failure", async (reason) => {
  const external = new AbortController(); let owned = true;
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  const deadlineAt = Date.now() + 10_000;
  await expect(runJob(db, { ...spec(oneCost), signal: external.signal, deadlineAt,
    assertWrite: () => { if (!owned) throw new Error("generation_fence_lost"); },
  }, (ctx) => callStructured({ ...opts, signal: ctx.signal, onCost(cost) {
    ctx.recordCost(cost);
    if (reason === "cancelled") external.abort();
    else if (reason === "task_deadline_exceeded") vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
    else owned = false;
  } }))).rejects.toThrow(reason);
  expect(transport).toHaveBeenCalledTimes(1);
  if (reason === "generation_fence_lost") expect(listRuns(db)[0].status).toBe("running");
  else expect(listRuns(db)[0].error?.message).toBe(reason);
});

it("C3 persistence failure still stops transport and outranks a concurrently observed budget fault", async () => {
  let ctx!: JobCtx;
  db.exec("CREATE TRIGGER c2b_fault BEFORE UPDATE ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'synthetic-private'); END;");
  const transport = vi.fn(async () => { ctx.recordCost({ tokens: 1, amount: 1 }); return response(); }); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(1), (current) => { ctx = current; return call(ctx); })).rejects.toThrow("usage_persistence_failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", cost: { amount: 1 }, error: { message: "usage_persistence_failed" } });
  expect(JSON.stringify(listRuns(db))).not.toContain("synthetic-private");
});

it("budget-only fail-fast waits for already dispatched siblings to account before finishing the Run", async () => {
  let release!: () => void; let secondDispatched!: () => void;
  const ready = new Promise<void>((resolve) => { secondDispatched = resolve; });
  const transport = vi.fn()
    .mockImplementationOnce(async () => { await ready; return response(); })
    .mockImplementationOnce(async () => { secondDispatched(); await new Promise<void>((resolve) => { release = resolve; }); return response(); });
  vi.stubGlobal("fetch", transport);
  const pending = runJob(db, spec(oneCost), (ctx) => Promise.all([call(ctx), call(ctx)]));
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(listModelUsageAttempts(db, listRuns(db)[0].id).attempts.some((a) => a.usage_status === "reported")).toBe(true));
  expect(listRuns(db)[0].status).toBe("running"); release();
  await expect(pending).rejects.toThrow("task_budget_exceeded");
  expect(listRuns(db)[0].cost?.amount).toBe(2 * oneCost);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("Responses runtime EOF retry cannot issue a new request after another expense exhausted the scope", async () => {
  vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic");
  vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  let ctx!: JobCtx;
  const transport = vi.fn(async () => { ctx.recordCost({ tokens: 1, amount: 1 }); return response(""); }); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, spec(1), (current) => { ctx = current; return call(ctx); })).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("real Analyzer does not split and resubmit a paid invalid output after budget exhaustion", async () => {
  const transport = vi.fn(async () => response(syntheticSse({ invalid: true }))); vi.stubGlobal("fetch", transport);
  const topic: Topic = { id: "synthetic", name: "synthetic", keywords: [], language: "en", enabled: true, brief_schedule: "daily" };
  const item: ContentItem = { id: "item", source_id: "source", url: "https://example.test", title: "synthetic", body: "synthetic", body_kind: "article", author: null, published_at: null, fetched_at: new Date().toISOString(), language: "en", topic_ids: [topic.id], tags: [], raw_ref: "", content_hash: "synthetic", fetch_status: "ok" };
  await expect(runJob(db, spec(oneCost), (ctx) => analyze(topic, [item, { ...item, id: "item2" }], { start: "2026", end: "2027" }, ctx.recordCost, { signal: ctx.signal }))).rejects.toThrow("task_budget_exceeded");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("real lease takeover plus budget exhaustion leaves the old worker unable to write its Run", async () => {
  insertTopic(db, { id: "t", name: "synthetic", keywords: [], language: "en", enabled: true, brief_schedule: "daily" });
  createScheduledTraceRequest(db, { topicId: "t", reportType: "brief", period: "synthetic", windowHours: 24, items: 1 });
  const claim = claimNextGenerationDispatch(db)!;
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { ...spec(oneCost), traceId: claim.traceId, existingRunId: claim.rootRunId,
    assertWrite: () => assertGenerationDispatchClaim(db, claim),
  }, (ctx) => callStructured({ ...opts, signal: ctx.signal, onCost(cost) {
    ctx.recordCost(cost);
    db.prepare("UPDATE generation_dispatch SET lease_expires_at='2020' WHERE id=?").run(claim.dispatchId);
    db.prepare("UPDATE generation_lease SET expires_at='2020' WHERE trace_id=?").run(claim.traceId);
    expect(claimNextGenerationDispatch(db)?.claimEpoch).toBe(claim.claimEpoch + 1);
  } }))).rejects.toThrow("generation_fence_lost");
  expect(listRuns(db)[0].status).toBe("running");
  expect(listModelUsageAttempts(db, claim.rootRunId).attempts[0].usage_status).toBe("reported");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("cancellation interrupts budget settlement even when a dispatched sibling ignores its signal", async () => {
  const external = new AbortController(); let release!: () => void; let ready!: () => void;
  const dispatched = new Promise<void>((resolve) => { ready = resolve; });
  const transport = vi.fn()
    .mockImplementationOnce(async () => { await dispatched; return response(); })
    .mockImplementationOnce(async () => { ready(); await new Promise<void>((resolve) => { release = resolve; }); return response(); });
  vi.stubGlobal("fetch", transport);
  const pending = runJob(db, { ...spec(oneCost), signal: external.signal }, (ctx) => Promise.all([call(ctx), call(ctx)]));
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(listModelUsageAttempts(db, listRuns(db)[0].id).attempts.some((a) => a.usage_status === "reported")).toBe(true));
  external.abort(); await expect(pending).rejects.toThrow("cancelled");
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", cost: { amount: oneCost }, error: { message: "cancelled" } });
  release(); await new Promise((resolve) => setImmediate(resolve));
  expect(listRuns(db)[0].error?.message).toBe("cancelled");
});

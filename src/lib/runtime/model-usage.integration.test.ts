/** Real callStructured/Job/SDK paths; synthetic fetch only, no paid model or ambient DB. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { listModelUsageAttempts } from "../db/model-usage.js";
import { createScheduledTraceRequest, claimNextGenerationDispatch, assertGenerationDispatchClaim } from "../db/provenance.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import { planRawArchive, writePlannedRawArchive } from "../db/raw-archive.js";
import { getAnalysisBatch } from "../db/analysis.js";
import { contentHash } from "../sources/normalize.js";
import { getRun, listRuns, sumRunCostSince } from "../db/repos.js";
import { callStructured, MODELS } from "./llm.js";
import { runJob } from "./jobs.js";
import { beginUsageAttempt, withUsageCall } from "./model-usage.js";
import { TaskCancellationError } from "./cancellation.js";
import { judgeWithRetry } from "../agents/validator.js";
import { verifyQuoteSelfContained } from "../agents/analyzer.js";
import { runAnalysis } from "../agents/pipeline.js";
import type { ContentItem, Topic } from "../types.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry-sqlite.js";

vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));
let db: DB;
const savedModels = { ...MODELS };
beforeEach(() => {
  db = openDb(":memory:"); applyProvenanceMigrations(db);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-not-a-key"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("LLM_MAX_RETRIES", "1"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "1"); vi.stubEnv("LLM_TRANSIENT_RETRY_BACKOFF_MS", "0");
  MODELS.analyzer = "claude-sonnet-4-6";
});
afterEach(() => { if (db.open) db.close(); Object.assign(MODELS, savedModels); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const opts = { role: "analyzer" as const, schema: z.object({ ok: z.boolean() }), system: "synthetic", user: "synthetic", maxTokens: 64 };
function event(value: unknown) { return `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`; }
function anthropic(input: unknown = { ok: true }, stop = "tool_use") {
  return [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: MODELS.analyzer, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-tool", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ].map(event).join("");
}
const response = (body = anthropic()) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const rows = () => listModelUsageAttempts(db, listRuns(db)[0].id).attempts;

it("SDK retries create two distinct true fetch attempts with one logical call; cost remains once", async () => {
  const transport = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after-ms": "1" } })).mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", transport);
  const { run, result } = await runJob(db, { kind: "analyze", target: {}, silent: true }, (ctx) => callStructured({ ...opts, signal: ctx.signal, onCost: ctx.recordCost }));
  expect(result.data).toEqual({ ok: true }); expect(transport).toHaveBeenCalledTimes(2);
  const attempts = listModelUsageAttempts(db, run.id).attempts;
  expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2]);
  expect(new Set(attempts.map((a) => a.logical_call_id)).size).toBe(1);
  expect(attempts[0]).toMatchObject({ usage_status: "unknown", input_tokens: null });
  expect(attempts[1]).toMatchObject({ usage_status: "reported", input_tokens: 7, output_tokens: 3 });
  expect(sumRunCostSince(db, "2026")).toBe(run.cost!.amount);
  expect(run.cost!.tokens).toBe(10);
});

it("refusal retries have separate attempts; schema rejection cannot erase committed usage", async () => {
  const transport = vi.fn().mockResolvedValueOnce(response(anthropic({ ok: true }, "refusal"))).mockResolvedValueOnce(response(anthropic({ invalid: true })));
  vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { kind: "analyze", target: {}, silent: true }, (ctx) => callStructured({ ...opts, signal: ctx.signal, onCost: ctx.recordCost }))).rejects.toThrow("schema");
  expect(transport).toHaveBeenCalledTimes(2);
  expect(rows().map((a) => a.usage_status)).toEqual(["reported", "reported"]);
  expect(listRuns(db)[0].cost!.tokens).toBe(20);
});

it("usage is committed before EOF/Run finish; cancellation preserves usage but rejects business result", async () => {
  const external = new AbortController(); let controller: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(anthropic())); } }), { headers: { "content-type": "text/event-stream" } })));
  const pending = runJob(db, { kind: "analyze", target: {}, silent: true, signal: external.signal }, (ctx) => callStructured({ ...opts, signal: ctx.signal }));
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(rows()[0]?.usage_status).toBe("reported"));
  expect(listRuns(db)[0].status).toBe("running"); external.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(rows()[0].output_tokens).toBe(3);
  // Releasing a cancelled raw stream must never resurrect the Run.
  try { controller!.close(); } catch { /* the real SDK may already have cancelled it */ }
  expect(listRuns(db)[0].status).toBe("failed");
});

it("Responses raw missing usage remains unknown; known model on Coding Plan still has no quoted price", async () => {
  vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic-not-a-key"); vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  const body = event({ type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"ok":true}' })
    + event({ type: "response.completed", response: { status: "completed", usage: {}, output: [] } });
  vi.stubGlobal("fetch", vi.fn(async () => response(body)));
  await runJob(db, { kind: "analyze", target: {}, silent: true }, () => callStructured(opts));
  expect(rows()[0]).toMatchObject({ provider: "volcengine-responses", usage_status: "unknown", input_tokens: null, output_tokens: null, estimate_usd: null });
});

it("Responses usage terminal is committed even if later invalid protocol rejects the result", async () => {
  vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic-not-a-key"); vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  const body = event({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } } }) + "data: broken-json\n\n";
  const transport = vi.fn(async () => response(body)); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { kind: "analyze", target: {}, silent: true }, () => callStructured(opts))).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(rows()[0]).toMatchObject({ usage_status: "reported", input_tokens: 7, output_tokens: 3, estimate_usd: null });
});

it("persistence fault after provider dispatch poisons Job: swallowed error cannot trigger next request or done Run", async () => {
  db.exec("CREATE TRIGGER c3_injected_failure BEFORE UPDATE ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'synthetic-private-sql-error'); END;");
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { kind: "analyze", target: {}, silent: true }, async () => {
    await callStructured(opts).catch(() => undefined);
    await callStructured(opts).catch(() => undefined);
    return "should-not-commit";
  })).rejects.toThrow("usage_persistence_failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(rows()).toHaveLength(1); expect(rows()[0].usage_status).toBe("unknown");
  expect(listRuns(db)[0]).toMatchObject({ status: "failed", error: { message: "usage_persistence_failed" } });
  expect(JSON.stringify(listRuns(db))).not.toContain("synthetic-private");
});

it("unmigrated schema fails before any SDK retry can send or create a fake attempt", async () => {
  db.exec("DROP TABLE model_usage_attempt"); const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { kind: "analyze", target: {}, silent: true }, () => callStructured(opts))).rejects.toThrow("usage_persistence_failed");
  expect(transport).not.toHaveBeenCalled();
});

it("late observed usage after Job cancellation is fenced separately from accepting business results", async () => {
  const external = new AbortController(); let late: ReturnType<typeof beginUsageAttempt>; let release!: () => void;
  const pending = runJob(db, { kind: "analyze", target: {}, silent: true, signal: external.signal }, async () => withUsageCall("analyzer", MODELS.analyzer, "anthropic", async () => {
    late = beginUsageAttempt()!; await new Promise<void>((resolve) => { release = resolve; }); return "late-business";
  }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); external.abort(); release();
  await expect(pending).rejects.toThrow("cancelled");
  late!.observe({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, true);
  expect(rows()[0].usage_status).toBe("reported"); expect(listRuns(db)[0].status).toBe("failed");
});

it("lease loss rejects late usage and does not write a failed Run", async () => {
  let owned = true; let late: ReturnType<typeof beginUsageAttempt>; let release!: () => void;
  const pending = runJob(db, { kind: "analyze", target: {}, silent: true, assertWrite: () => { if (!owned) throw new TaskCancellationError("generation_fence_lost"); } }, async () => withUsageCall("analyzer", MODELS.analyzer, "anthropic", async () => {
    late = beginUsageAttempt()!; await new Promise<void>((resolve) => { release = resolve; }); return "late";
  }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); owned = false; release();
  await expect(pending).rejects.toThrow("generation_fence_lost");
  expect(() => late!.observe({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, true)).toThrow("generation_fence_lost");
  expect(rows()[0].usage_status).toBe("unknown"); expect(getRun(db, listRuns(db)[0].id)!.status).toBe("running");
});

it("parallel Jobs maintain separate logical call and Run ownership", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  await Promise.all(["analyze", "validate"].map((kind) => runJob(db, { kind: kind as "analyze" | "validate", target: {}, silent: true }, () => callStructured(opts))));
  const runs = listRuns(db);
  expect(runs).toHaveLength(2);
  const attempts = runs.flatMap((run) => listModelUsageAttempts(db, run.id).attempts);
  expect(new Set(attempts.map((a) => a.logical_call_id)).size).toBe(2);
  expect(new Set(attempts.map((a) => a.run_id)).size).toBe(2);
});

it("production validator helper retains judgment, cost and role through real SDK transport", async () => {
  vi.stubEnv("VALIDATOR_THINKING", "0");
  const judgment = { consistency: "support", consistency_reason: "ok", rationale: "synthetic" };
  vi.stubGlobal("fetch", vi.fn(async () => response(anthropic(judgment))));
  const { result, run } = await runJob(db, { kind: "validate", target: {}, silent: true }, (ctx) =>
    judgeWithRetry("synthetic claim", "synthetic source", ctx.recordCost, undefined, undefined, ctx.signal));
  expect(result).toEqual(judgment); expect(run.cost!.tokens).toBe(10);
  expect(rows()[0]).toMatchObject({ role: "validator", model: MODELS.validator, usage_status: "reported" });
});

it.each([false, true])("production runAnalysis with P1=%s persists batch, budget and original projection without double counting", async (p1) => {
  const dir = mkdtempSync(join(tmpdir(), "ia-c3-pipeline-"));
  vi.stubEnv("DATA_DIR", dir); vi.stubEnv("ANALYSIS_CACHE", "0");
  MODELS.coverage = "synthetic-independent-coverage";
  const topic: Topic = { id: "synthetic-topic", name: "synthetic", keywords: ["Agent"], facets: [], language: "en", enabled: true, brief_schedule: "daily" };
  insertTopic(db, topic);
  insertSource(db, { id: "synthetic-source", name: "synthetic", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true });
  const body = "Agent release with synthetic benchmark evidence.";
  const item: ContentItem = { id: "synthetic-item", source_id: "synthetic-source", url: "https://example.test/one", title: "Agent", body, body_kind: "article", author: null, published_at: new Date().toISOString(), fetched_at: new Date().toISOString(), language: "en", topic_ids: [topic.id], tags: [], raw_ref: "", content_hash: contentHash(body), fetch_status: "ok" };
  insertContentItem(db, item);
  const raw = JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: body, source_body_kind: "article", source_item_raw: "synthetic", structured_body_sha256: contentHash(body) });
  const archive = planRawArchive(db, { contentId: item.id, raw }); writePlannedRawArchive(db, archive, raw); item.raw_ref = archive.rawRef;
  const transport = vi.fn(async () => response(anthropic({ no_significant_event: true, insights: [] }))); vi.stubGlobal("fetch", transport);
  try {
    const batch = await runAnalysis(db, topic, [item], { start: item.published_at!, end: item.fetched_at }, p1 ? { telemetry: SQLITE_P1_TELEMETRY_SINK } : {});
    expect(getAnalysisBatch(db, batch.id)).toMatchObject({ no_significant_event: true, insights: [] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ role: "analyzer", usage_status: "reported" });
    expect(listRuns(db)[0].cost!.tokens).toBe(10);
    expect(sumRunCostSince(db, "2026")).toBe(listRuns(db)[0].cost!.amount);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cost_ledger").get()).toEqual({ n: p1 ? 1 : 0 });
    if (p1) expect(db.prepare("SELECT input_tokens,output_tokens FROM cost_ledger").get()).toEqual({ input_tokens: 10, output_tokens: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["validator", "coverage"])("production %s outer retry cannot redispatch after persistence fault", async (role) => {
  vi.stubEnv("VALIDATOR_THINKING", "0"); vi.stubEnv("COVERAGE_THINKING", "0");
  vi.stubEnv("VALIDATOR_RETRIES", "1"); vi.stubEnv("VALIDATOR_RETRY_BACKOFF_MS", "0");
  MODELS.coverage = "synthetic-independent-coverage";
  db.exec("CREATE TRIGGER c3_agent_failure BEFORE UPDATE ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'synthetic-private'); END;");
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(runJob(db, { kind: "analyze", target: {}, silent: true }, async (ctx) => {
    if (role === "validator") await judgeWithRetry("synthetic claim", "synthetic source", ctx.recordCost, undefined, undefined, ctx.signal);
    else await verifyQuoteSelfContained({ content_item_id: "synthetic", quote: "synthetic", locator: { paragraph_index: 0, char_start: 0, char_end: 9 } }, ctx.recordCost, ctx.signal);
  }))
    .rejects.toThrow("usage_persistence_failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(rows()[0]).toMatchObject({ role, usage_status: "unknown" });
  expect(listRuns(db)[0].status).toBe("failed");
});

it("real dispatch takeover fences old attempt, Run and late response without independent usage authority", async () => {
  insertTopic(db, { id: "t1", name: "synthetic", keywords: [], facets: [], language: "en", enabled: true, brief_schedule: "daily" });
  createScheduledTraceRequest(db, { topicId: "t1", reportType: "brief", period: "synthetic", windowHours: 24, items: 1 });
  const claim = claimNextGenerationDispatch(db)!;
  let late: ReturnType<typeof beginUsageAttempt>; let release!: () => void;
  const pending = runJob(db, { kind: "analyze", target: {}, existingRunId: claim.rootRunId, traceId: claim.traceId, silent: true,
    assertWrite: () => assertGenerationDispatchClaim(db, claim) }, () => withUsageCall("analyzer", MODELS.analyzer, "anthropic", async () => {
      late = beginUsageAttempt()!; await new Promise<void>((resolve) => { release = resolve; }); return "stale-business";
    }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  db.prepare("UPDATE generation_dispatch SET lease_expires_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", claim.dispatchId);
  db.prepare("UPDATE generation_lease SET expires_at=? WHERE trace_id=?").run("2020-01-01T00:00:00.000Z", claim.traceId);
  const takeover = claimNextGenerationDispatch(db)!; expect(takeover.claimEpoch).toBe(claim.claimEpoch + 1);
  release(); await expect(pending).rejects.toThrow("generation_fence_lost");
  expect(() => late!.observe({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, true)).toThrow("generation_fence_lost");
  expect(listModelUsageAttempts(db, claim.rootRunId).attempts[0].usage_status).toBe("unknown");
  expect(getRun(db, claim.rootRunId)!.status).toBe("running");
});

it.each(["closed", "write-failed"])("late observer after cancelled Job has controlled %s diagnosis without reopening or rewriting Run", async (fault) => {
  const external = new AbortController(); let late: ReturnType<typeof beginUsageAttempt>; let release!: () => void;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = runJob(db, { kind: "analyze", target: {}, signal: external.signal, silent: true }, () => withUsageCall("analyzer", MODELS.analyzer, "anthropic", async () => {
    late = beginUsageAttempt()!; await new Promise<void>((resolve) => { release = resolve; }); return "ignored";
  }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); external.abort(); release(); await expect(pending).rejects.toThrow("cancelled");
  if (fault === "closed") db.close(); else db.exec("CREATE TRIGGER c3_late_failure BEFORE UPDATE ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'synthetic-private'); END;");
  expect(() => late!.observe({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, true)).toThrow("usage_persistence_failed");
  expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-private");
  expect(warning).toHaveBeenCalledWith(fault === "closed" ? "usage_store_closed" : "usage_persistence_failed", expect.objectContaining({ job_finished: true }));
  if (fault !== "closed") { expect(rows()[0].usage_status).toBe("unknown"); expect(listRuns(db)[0].error!.message).toBe("cancelled"); }
});

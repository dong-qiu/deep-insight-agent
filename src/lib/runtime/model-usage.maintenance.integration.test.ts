/** Explicit isolated composition through actual Job/SDK/parsers. No production Job injection. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { z } from "zod/v4";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../../ops/maintenance/ledger.mjs";
import { initializeWriters, openWriters } from "../../../ops/maintenance/writers.mjs";
import { openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { insertTopic, getRun, sumRunCostSince } from "../db/repos.js";
import { createDeepDiveTraceRequest, claimNextGenerationDispatch, assertGenerationDispatchClaim } from "../db/provenance.js";
import { listModelUsageAttempts } from "../db/model-usage.js";
import { openUsageDispatchDriver } from "./usage-dispatch-driver.js";
import { createUsageJobScope } from "./model-usage.js";
import { callStructured } from "./llm.js";
import { runJob, type JobCtx } from "./jobs.js";

vi.mock("./alert.js", () => ({ notifyFailure: vi.fn() }));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-not-a-key"); vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("LLM_MAX_RETRIES", "1"); vi.stubEnv("LLM_TRANSIENT_RETRIES", "1"); vi.stubEnv("LLM_TRANSIENT_RETRY_BACKOFF_MS", "0");
});
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.R3_USAGE_EVIDENCE_DIR ?? tmpdir(), "runtime-"))); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync("ed25519");
  initialize(root, { target: { region: "isolated", instanceId: "fixture-app", volumeId: "fixture-data", dataPath: root, serviceSet: ["app"] }, approverId: "fixture-reviewer", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }); initializeWriters(root);
  const path = join(root, "fixture-business.sqlite"), seed = openDb(path); chmodSync(path, 0o600); applyProvenanceMigrations(seed);
  insertTopic(seed, { id: "topic_a", name: "A", keywords: [], language: "en", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [] });
  createDeepDiveTraceRequest(seed, { topicId: "topic_a", idempotencyKeyHash: "a".repeat(64), planning: true });
  seed.pragma("wal_checkpoint(TRUNCATE)"); seed.pragma("journal_mode=DELETE"); seed.close();
  const driver = openUsageDispatchDriver(root), db = driver.db, writers = openWriters(root), worker = writers.register("usage-runtime", "generation-dispatch");
  let registryClosed = false;
  const closeRegistry = () => { writers.close(); registryClosed = true; };
  const admission = writers.usageAdmissionFor(worker, db, driver), cap = admission.admit(), claim = claimNextGenerationDispatch(db)!; admission.bindClaim(cap, claim);
  const rows = () => listModelUsageAttempts(db, claim.rootRunId).attempts;
  const controller = new AbortController();
  function job<T>(work: (ctx: JobCtx, scope: ReturnType<typeof createUsageJobScope>) => Promise<T>) {
    return runJob(db, { kind: "analyze", target: {}, existingRunId: claim.rootRunId, traceId: claim.traceId, silent: true, signal: controller.signal, assertWrite: () => assertGenerationDispatchClaim(db, claim) }, async ctx => {
      const usageWriter = admission.bindRun(cap, { runId: ctx.runId, traceId: claim.traceId }, ctx.signal);
      const scope = createUsageJobScope({ db, runId: ctx.runId, traceId: claim.traceId, signal: ctx.signal, usageWriter, recordCost: ctx.recordCost, assertWrite: () => assertGenerationDispatchClaim(db, claim) });
      try { return await scope.run(async () => { const value = await work(ctx, scope); scope.check(); return value; }); }
      finally { scope.finish(); }
    });
  }
  cleanup.push(() => { if (db.open) { writeFileSync(join(root, "facts.json"), JSON.stringify({ attempts: rows(), run: getRun(db, claim.rootRunId) }), { mode: 0o600 }); driver.close(); } if (!registryClosed) closeRegistry(); });
  return { root, path, driver, db, writers, admission, cap, claim, controller, rows, job, closeRegistry };
}
const opts = { role: "analyzer" as const, schema: z.object({ ok: z.boolean() }), system: "synthetic", user: "synthetic", maxTokens: 64 };
function event(value: unknown) { return `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`; }
function anthropic(input: unknown = { ok: true }, stop = "tool_use", tokens = { input_tokens: 7, output_tokens: 3 }) {
  return [
    { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: "synthetic", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: tokens.input_tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-tool", name: "respond_with_structured_output", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: tokens.output_tokens } }, { type: "message_stop" },
  ].map(event).join("");
}
const response = (body = anthropic()) => new Response(body, { headers: { "content-type": "text/event-stream" } });
it("actual SDK-owned retry crosses the fixed begin per transport; unknown fee is not fabricated and Run cost is once", async () => {
  const f = fixture(), transport = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after-ms": "1" } })).mockResolvedValueOnce(response()); vi.stubGlobal("fetch", transport);
  const { run, result } = await f.job(ctx => callStructured({ ...opts, signal: ctx.signal, onCost: ctx.recordCost }));
  expect(result.data).toEqual({ ok: true }); expect(transport).toHaveBeenCalledTimes(2);
  expect(f.rows().map(a => a.attempt_number)).toEqual([1, 2]); expect(new Set(f.rows().map(a => a.logical_call_id)).size).toBe(1);
  expect(f.rows()[0]).toMatchObject({ usage_status: "unknown", estimate_usd: null }); expect(f.rows()[1]).toMatchObject({ usage_status: "reported", input_tokens: 7, output_tokens: 3 });
  expect(run.cost!.tokens).toBe(10); expect(sumRunCostSince(f.db, "2026")).toBe(run.cost!.amount);
});
it("runtime refusal/schema rejection retain both committed attempts through real SDK/parser", async () => {
  const f = fixture(), transport = vi.fn().mockResolvedValueOnce(response(anthropic({ ok: true }, "refusal"))).mockResolvedValueOnce(response(anthropic({ invalid: true }))); vi.stubGlobal("fetch", transport);
  await expect(f.job(ctx => callStructured({ ...opts, signal: ctx.signal, onCost: ctx.recordCost }))).rejects.toThrow("schema");
  expect(transport).toHaveBeenCalledTimes(2); expect(f.rows().map(a => a.usage_status)).toEqual(["reported", "reported"]); expect(getRun(f.db, f.claim.rootRunId)!.cost!.tokens).toBe(20);
});
it("Responses real parser records terminal usage before protocol failure; Coding Plan price stays unknown", async () => {
  const f = fixture(); vi.stubEnv("LLM_PROVIDER", "volcengine-responses"); vi.stubEnv("LLM_API_KEY", "synthetic-not-a-key"); vi.stubEnv("LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding/v3");
  const body = event({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } } }) + "data: broken-json\n\n";
  const transport = vi.fn(async () => response(body)); vi.stubGlobal("fetch", transport);
  await expect(f.job(ctx => callStructured({ ...opts, signal: ctx.signal }))).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1);
  expect(f.rows()[0]).toMatchObject({ provider: "volcengine-responses", usage_status: "reported", input_tokens: 7, output_tokens: 3, estimate_usd: null });
});
it("actual provider zero remains reported zero under the fixed consumer", async () => {
  const f = fixture(); vi.stubGlobal("fetch", vi.fn(async () => response(anthropic({ ok: true }, "tool_use", { input_tokens: 0, output_tokens: 0 }))));
  await f.job(ctx => callStructured({ ...opts, signal: ctx.signal })); expect(f.rows()[0]).toMatchObject({ usage_status: "reported", input_tokens: 0, output_tokens: 0, estimate_usd: 0 });
});
it.each(["begin", "observe"])("%s failure stays sticky even if business catches it; no next SDK request", async fault => {
  const f = fixture(); f.db.exec(`CREATE TRIGGER reject_usage BEFORE ${fault === "begin" ? "INSERT" : "UPDATE"} ON model_usage_attempt BEGIN SELECT RAISE(ABORT,'private-synthetic-error'); END`);
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(f.job(async ctx => { await callStructured({ ...opts, signal: ctx.signal }).catch(() => undefined); await callStructured({ ...opts, signal: ctx.signal }).catch(() => undefined); return "no"; })).rejects.toThrow("usage_persistence_failed");
  expect(transport).toHaveBeenCalledTimes(fault === "begin" ? 0 : 1); expect(f.rows()).toHaveLength(fault === "begin" ? 0 : 1);
  expect(JSON.stringify(getRun(f.db, f.claim.rootRunId))).not.toContain("private-synthetic-error");
});
it.each(["business", "registry"])("%s COMMIT ACK unknown prevents sending or retrying without erasing the committed attempt", async fault => {
  const f = fixture(), exec = f.db.exec.bind(f.db); f.db.exec = sql => { const result = exec(sql); if (sql === "COMMIT") { if (fault === "registry") f.closeRegistry(); else throw new Error("synthetic-ack-loss"); } return result; };
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(f.job(async ctx => { await callStructured({ ...opts, signal: ctx.signal }).catch(() => undefined); await callStructured({ ...opts, signal: ctx.signal }); })).rejects.toThrow("usage_commit_unknown");
  f.db.exec = exec; expect(transport).not.toHaveBeenCalled(); expect(f.rows()[0]).toMatchObject({ usage_status: "unknown", estimate_usd: null }); expect(f.rows()).toHaveLength(1);
});
it("unknown after terminal usage COMMIT retains actual reported fee and blocks swallowed-error retry", async () => {
  const f = fixture(), exec = f.db.exec.bind(f.db); let commits = 0;
  f.db.exec = sql => { const result = exec(sql); if (sql === "COMMIT" && ++commits === 4) throw new Error("synthetic-terminal-ack-loss"); return result; };
  const transport = vi.fn(async () => response()); vi.stubGlobal("fetch", transport);
  await expect(f.job(async ctx => { await callStructured({ ...opts, signal: ctx.signal }).catch(() => undefined); await callStructured({ ...opts, signal: ctx.signal }); })).rejects.toThrow("usage_commit_unknown");
  f.db.exec = exec; expect(transport).toHaveBeenCalledTimes(1); expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ usage_status: "reported", input_tokens: 7, output_tokens: 3 }); expect(f.rows()[0].estimate_usd).toBeGreaterThan(0);
});
it("lease loss before actual fetch leaves the Run running and attempt absent", async () => {
  const f = fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(f.job(ctx => { f.db.exec("UPDATE generation_lease SET owner_token='lost'"); return callStructured({ ...opts, signal: ctx.signal }); })).rejects.toThrow("generation_fence_lost");
  expect(transport).not.toHaveBeenCalled(); expect(f.rows()).toHaveLength(0); expect(getRun(f.db, f.claim.rootRunId)!.status).toBe("running");
});
it("maintenance close and business busy reject actual begin before any transport", async () => {
  const closed = fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport); closed.writers.closeAdmission();
  await expect(closed.job(ctx => callStructured({ ...opts, signal: ctx.signal }))).rejects.toThrow("writer_admission_closed");
  const closedAfterBinding = fixture();
  await expect(closedAfterBinding.job(ctx => { closedAfterBinding.writers.closeAdmission(); return callStructured({ ...opts, signal: ctx.signal }); })).rejects.toThrow("usage_persistence_failed");
  const busy = fixture();
  await expect(busy.job(async ctx => { const blocker = new Database(busy.path, { timeout: 0 }); blocker.exec("BEGIN IMMEDIATE"); try { return await callStructured({ ...opts, signal: ctx.signal }); } finally { blocker.exec("ROLLBACK"); blocker.close(); } })).rejects.toThrow("usage_persistence_failed");
  expect(transport).not.toHaveBeenCalled(); expect(busy.rows()).toHaveLength(0);
});
it("closed original DB fails before SDK dispatch with a fixed diagnosis and no reopen", async () => {
  const f = fixture(), signal = f.controller.signal, usageWriter = f.admission.bindRun(f.cap, { runId: f.claim.rootRunId, traceId: f.claim.traceId }, signal);
  const scope = createUsageJobScope({ db: f.db, runId: f.claim.rootRunId, traceId: f.claim.traceId, signal, usageWriter }), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  f.driver.close(); const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await expect(scope.run(() => callStructured({ ...opts, signal }))).rejects.toThrow("usage_persistence_failed");
  expect(warning).toHaveBeenCalledWith("usage_store_closed", expect.any(Object)); expect(f.db.open).toBe(false); expect(transport).not.toHaveBeenCalled();
});
it("configured scope validates DB/run/trace/original signal and rejects accessors without fallback", () => {
  const f = fixture(), signal = f.controller.signal, usageWriter = f.admission.bindRun(f.cap, { runId: f.claim.rootRunId, traceId: f.claim.traceId }, signal);
  const input = { db: f.db, runId: f.claim.rootRunId, traceId: f.claim.traceId, signal, usageWriter };
  expect(() => createUsageJobScope({ ...input, signal: new AbortController().signal })).toThrow("writer_usage_business_mismatch");
  expect(() => createUsageJobScope({ ...input, runId: "other" })).toThrow("writer_usage_business_mismatch");
  expect(() => createUsageJobScope({ ...input, traceId: "other" })).toThrow("writer_usage_business_mismatch");
  let reads = 0; const fake = { ...usageWriter }; Object.defineProperty(fake, "db", { get() { reads++; return f.db; } }); Object.freeze(fake);
  expect(() => createUsageJobScope({ ...input, usageWriter: fake })).toThrow("writer_usage_business_mismatch"); expect(reads).toBe(0); expect(f.rows()).toHaveLength(0);
});
it("finished opted-in scope cannot start another runtime transport", async () => {
  const f = fixture(), usageWriter = f.admission.bindRun(f.cap, { runId: f.claim.rootRunId, traceId: f.claim.traceId }, f.controller.signal);
  const scope = createUsageJobScope({ db: f.db, runId: f.claim.rootRunId, traceId: f.claim.traceId, signal: f.controller.signal, usageWriter }); scope.finish(); const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(scope.run(() => callStructured(opts))).rejects.toThrow("usage_persistence_failed"); expect(transport).not.toHaveBeenCalled();
});
it.each(["open", "close", "lease", "db-closed"])("real SDK pending raw read after cancellation/local finish: %s remains authoritative", async fault => {
  const f = fixture(), warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let release!: (value: ReadableStreamReadResult<Uint8Array>) => void;
  const raw = response();
  // Synthetic transport deliberately ignores abort while a real SDK/parser read is pending.
  const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { release = resolve; }));
  const cancel = vi.fn(async () => undefined);
  Object.defineProperty(raw.body!, "getReader", { value: () => ({ read, cancel, releaseLock() {} }) });
  const transport = vi.fn(async () => raw); vi.stubGlobal("fetch", transport);
  const pending = f.job(ctx => callStructured({ ...opts, signal: ctx.signal })); void pending.catch(() => undefined);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); expect(f.rows()[0].usage_status).toBe("unknown");
  f.controller.abort(); await expect(pending).rejects.toThrow("cancelled"); f.admission.finish(f.cap, "threw");
  const finished = getRun(f.db, f.claim.rootRunId);
  if (fault === "close") f.writers.closeAdmission();
  if (fault === "lease") f.db.exec("UPDATE generation_lease SET owner_token='lost'");
  if (fault === "db-closed") { writeFileSync(join(f.root, "before-close-facts.json"), JSON.stringify({ attempts: f.rows(), run: finished }), { mode: 0o600 }); f.driver.close(); }
  release({ done: false, value: new TextEncoder().encode(anthropic()) });
  if (fault === "open") {
    await vi.waitFor(() => expect(f.rows()[0].usage_status).toBe("reported"));
    expect(f.rows()[0]).toMatchObject({ input_tokens: 7, output_tokens: 3 }); expect(f.rows()[0].estimate_usd).toBeGreaterThan(0);
  } else {
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(fault === "lease" ? "usage_fence_lost" : fault === "db-closed" ? "usage_store_closed" : "usage_persistence_failed", expect.objectContaining({ job_finished: true })));
    if (f.db.open) expect(f.rows()[0]).toMatchObject({ usage_status: "unknown", estimate_usd: null });
  }
  if (f.db.open) expect(getRun(f.db, f.claim.rootRunId)).toEqual(finished);
  expect(transport).toHaveBeenCalledTimes(1); expect(finished!.status).toBe("failed");
});
it("already observed partial usage survives cancellation then close denying the late terminal chunk", async () => {
  const f = fixture(), raw = response(), bytes = anthropic(), split = bytes.indexOf("\n\n") + 2;
  let release!: (value: ReadableStreamReadResult<Uint8Array>) => void, reads = 0;
  Object.defineProperty(raw.body!, "getReader", { value: () => ({
    read: () => ++reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode(bytes.slice(0, split)) }) : new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { release = resolve; }),
    cancel: async () => undefined, releaseLock() {},
  }) });
  vi.stubGlobal("fetch", vi.fn(async () => raw)); const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pending = f.job(ctx => callStructured({ ...opts, signal: ctx.signal })); void pending.catch(() => undefined);
  await vi.waitFor(() => { expect(reads).toBe(2); expect(f.rows()[0].usage_status).toBe("partial"); });
  const partial = f.rows()[0]; f.controller.abort(); await expect(pending).rejects.toThrow("cancelled"); const finished = getRun(f.db, f.claim.rootRunId);
  f.admission.finish(f.cap, "threw"); f.writers.closeAdmission(); release({ done: false, value: new TextEncoder().encode(bytes.slice(split)) });
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("usage_persistence_failed", expect.objectContaining({ job_finished: true })));
  expect(f.rows()[0]).toEqual(partial); expect(partial).toMatchObject({ input_tokens: 7, output_tokens: 0, usage_status: "partial", estimate_usd: null }); expect(getRun(f.db, f.claim.rootRunId)).toEqual(finished);
});

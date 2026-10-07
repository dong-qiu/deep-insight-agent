import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../../ops/maintenance/ledger.mjs";
import { initializeWriters, openWriters } from "../../../ops/maintenance/writers.mjs";
import { openDb, type DB } from "../db/index.js";
import { beginModelUsageAttempt, observeModelUsage } from "../db/model-usage.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { createDeepDiveTraceRequest } from "../db/provenance.js";
import * as provenance from "../db/provenance.js";
import { finishRun, insertRun, insertTopic } from "../db/repos.js";
import { openTerminalDispatchDriver } from "../runtime/terminal-dispatch-driver.js";
import { appendGenerationEvent } from "../db/provenance-facts.js";
import { TaskBudgetError } from "../runtime/task-budget.js";
import { TaskCancellationError } from "../runtime/cancellation.js";
import type { FixedTerminalDispatchDriver, TerminalWriterAdmission } from "../runtime/writer-admission.js";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";

describe("explicit isolated strict terminal at real dispatch core", () => {
  let root: string, db: DB, driver: FixedTerminalDispatchDriver, writers: ReturnType<typeof openWriters>, admission: TerminalWriterAdmission;
  beforeEach(() => {
    vi.stubEnv("COST_LIMIT_TASK", undefined);
    root = realpathSync(mkdtempSync(join(tmpdir(), "insight-a3-terminal-core-"))); chmodSync(root, 0o700);
    const { publicKey } = generateKeyPairSync("ed25519");
    initialize(root, { target: { region: "isolated", instanceId: "fixture-app", volumeId: "fixture-data", dataPath: root, serviceSet: ["app"] }, approverId: "fixture-reviewer", publicKey: publicKey.export({ type: "spki", format: "pem" }) });
    initializeWriters(root);
    const path = join(root, "fixture-business.sqlite"), seed = openDb(path); chmodSync(path, 0o600); applyProvenanceMigrations(seed);
    insertTopic(seed, { id: "topic_a", name: "Topic A", keywords: [], language: "en", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [] });
    createDeepDiveTraceRequest(seed, { topicId: "topic_a", idempotencyKeyHash: "a".repeat(64), planning: true });
    seed.pragma("wal_checkpoint(TRUNCATE)"); seed.close(); driver = openTerminalDispatchDriver(root); db = driver.db;
    writers = openWriters(root); admission = writers.terminalAdmissionFor(writers.register("actual-core", "generation-dispatch"), db, driver);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (db.open) driver.close(); writers.close(); rmSync(root, { recursive: true }); });
  const facts = () => ["generation_dispatch", "generation_lease", "run", "generation_event"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

  it("admit precedes claim and immutable actual claim is bound before execute", async () => {
    const bind = vi.fn(admission.bindClaim), wrapped = { ...admission, bindClaim: bind };
    await expect(runGenerationDispatchOnce(db, async (_db, _topic, opts) => {
      expect(bind).toHaveBeenCalledOnce(); expect(bind.mock.calls[0][1]).toMatchObject({ traceId: opts.traceId, rootRunId: opts.rootRunId });
      expect(writers.inspect().tasks[0].outcome).toBeNull(); throw new Error("controlled failure");
    }, { terminalWriterAdmission: wrapped })).resolves.toMatchObject({ claimed: true, status: "failed", terminalCommit: { kind: "committed", businessCommit: "committed" } });
    expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "failed" });
    expect(writers.inspect().tasks[0]).toMatchObject({ outcome: "failed", remote_subwork: "unknown" });
  });

  it("real strict done preserves controlled pipeline terminal facts and releases the lease", async () => {
    const result = await runGenerationDispatchOnce(db, async (runDb, _topic, opts) => {
      runDb.prepare("UPDATE run SET status='done' WHERE id=?").run(opts.rootRunId!);
      appendGenerationEvent(runDb, { trace_id: opts.traceId!, stage: "select", event_type: "completed" });
      appendGenerationEvent(runDb, { trace_id: opts.traceId!, run_id: opts.rootRunId!, stage: "analyze", event_type: "started", version_context: { analyzer_model: "test-analyzer", analyzer_prompt_hash: "a".repeat(64), analyzer_output_version: "v1", analyzer_cache_mode: "off" }, context_completeness: "complete" });
      appendGenerationEvent(runDb, { trace_id: opts.traceId!, run_id: opts.rootRunId!, stage: "analyze", event_type: "completed" });
      for (const [id, kind, stage] of [["run_validate", "validate", "validate"], ["run_report", "report-gen", "generate_report"]] as const) {
        insertRun(runDb, { id, kind, target: {}, status: "running", started_at: new Date().toISOString(), ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: opts.traceId! });
        appendGenerationEvent(runDb, { trace_id: opts.traceId!, run_id: id, stage, event_type: "completed" }); finishRun(runDb, id, { status: "done", duration_ms: 1 });
      }
    }, { terminalWriterAdmission: admission });
    expect(result).toMatchObject({ status: "done", terminalCommit: { kind: "committed", businessCommit: "committed" } });
    expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "done" }); expect(db.prepare("SELECT state FROM generation_lease").get()).toEqual({ state: "released" });
  });

  it.each(["usage_persistence_failed", "task_budget_exceeded"])("original first cancellation outranks later %s and strict diagnostics stay separate", async later => {
    const controller = new AbortController(), attempt = vi.fn(admission.commitOutcome);
    const result = await runGenerationDispatchOnce(db, async () => {
      controller.abort(new TaskCancellationError("cancelled"));
      throw later === "task_budget_exceeded" ? new TaskBudgetError("task_budget_exceeded") : new Error(later);
    }, { signal: controller.signal, terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    expect(attempt).toHaveBeenCalledOnce(); expect(attempt.mock.calls[0][2].error?.reason_code).toBe("cancelled");
    expect(result.terminalCommit?.kind).toBe("committed");
    expect(JSON.parse((db.prepare("SELECT last_error FROM generation_dispatch").get() as { last_error: string }).last_error).reason_code).toBe("cancelled");
  });

  it.each(["done", "failed"])("close before late %s refuses terminal; unregistered business writer proves partial coverage", async mode => {
    let release!: () => void;
    let context!: { traceId?: string; rootRunId?: string; assertWrite?: () => void };
    const pending = runGenerationDispatchOnce(db, async (_db, _topic, opts) => { context = opts; await new Promise<void>(resolve => { release = resolve; }); if (mode === "failed") throw new Error("late failure"); }, { terminalWriterAdmission: admission });
    const before = facts(); writers.closeAdmission(); release(); const result = await pending;
    expect(result).toMatchObject({ status: "failed", terminalCommit: { kind: "not_committed", code: "writer_terminal_closed" } }); expect(facts()).toEqual(before);
    // Actual C3 repository remains outside maintenance coverage; original lease guard still permits its late observation.
    beginModelUsageAttempt(db, { attempt_id: "uncovered_usage", logical_call_id: "uncovered_logical", attempt_number: 1,
      run_id: context.rootRunId!, trace_id: context.traceId!, role: "analyzer", provider: "anthropic", model: "synthetic-unpriced", started_at: new Date().toISOString() }, context.assertWrite);
    observeModelUsage(db, "uncovered_usage", { observation_number: 1, final: false,
      usage: { input_tokens: 1, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null } }, context.assertWrite);
    expect(db.prepare("SELECT usage_status,estimate_usd FROM model_usage_attempt").get()).toEqual({ usage_status: "partial", estimate_usd: null });
    expect(facts()).toEqual(before);
    expect(writers.inspect()).toMatchObject({ writer_quiescence: false, production_permitted: false });
  });

  it.each(["deny", "throw"])("done %s cannot fall through to a second failed commit", async mode => {
    const attempt = vi.fn(() => { if (mode === "throw") throw new Error("fixture adapter cut"); return { kind: "not_committed" as const, businessCommit: "not_committed" as const, code: "writer_terminal_closed" as const }; });
    const wrapped = { ...admission, commitOutcome: attempt }; let before: ReturnType<typeof facts>;
    const result = await runGenerationDispatchOnce(db, async () => { before = facts(); }, { terminalWriterAdmission: wrapped });
    expect(attempt).toHaveBeenCalledOnce(); expect(attempt.mock.calls[0]).toHaveLength(3); expect(result.status).toBe("failed");
    expect(facts()).toEqual(before!); expect(result.terminalCommit?.kind).toBe(mode === "throw" ? "unknown" : "not_committed");
  });

  it.each(["deny", "throw"])("execute failure then failed %s attempts only once, without ordinary fallback", async mode => {
    const attempt = vi.fn(admission.commitOutcome).mockImplementation(() => { if (mode === "throw") throw new Error("fixture adapter cut"); return { kind: "not_committed", businessCommit: "not_committed", code: "writer_terminal_closed" }; });
    const result = await runGenerationDispatchOnce(db, async () => { throw new Error("controlled execute failure"); }, { terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    expect(attempt).toHaveBeenCalledOnce(); expect(result.status).toBe("failed"); expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "claimed" });
  });

  it("business done COMMIT then post-read error retains committed facts and never writes failed again", async () => {
    // Controlled executor leaves an allowed but nonpublishable trace, causing actual post-commit status validation failure.
    const attempt = vi.fn(admission.commitOutcome);
    const result = await runGenerationDispatchOnce(db, async () => {}, { terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    expect(attempt).toHaveBeenCalledOnce(); expect(result).toMatchObject({ status: "failed", terminalCommit: { kind: "committed", businessCommit: "committed" } });
    expect(db.prepare("SELECT state FROM generation_lease").get()).toEqual({ state: "released" });
    expect(db.prepare("SELECT status FROM run").get()).toEqual({ status: "running" });
    expect(db.prepare("SELECT count(*) AS n FROM generation_event WHERE event_type='failed'").get()).toEqual({ n: 0 });
  });

  it("post-COMMIT status read throws without a second failed terminal attempt", async () => {
    const attempt = vi.fn(admission.commitOutcome); vi.spyOn(provenance, "getGenerationTraceStatus").mockImplementation(() => { throw new Error("fixture post-read cut"); });
    const result = await runGenerationDispatchOnce(db, async () => {}, { terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    expect(attempt).toHaveBeenCalledOnce(); expect(result.terminalCommit).toEqual({ kind: "committed", businessCommit: "committed" });
    expect(db.prepare("SELECT count(*) AS n FROM generation_event WHERE event_type='failed'").get()).toEqual({ n: 0 });
  });

  it("actual business COMMIT plus registry loss and local finish failure preserve terminal facts", async () => {
    const exec = db.exec.bind(db), attempt = vi.fn(admission.commitOutcome);
    db.exec = sql => { const value = exec(sql); if (sql === "COMMIT") writers.close(); return value; };
    const result = await runGenerationDispatchOnce(db, async () => { throw new Error("controlled failure"); }, { terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    db.exec = exec; expect(attempt).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", terminalCommit: { kind: "unknown", businessCommit: "committed", code: "writer_terminal_registry_commit_unknown" } });
    const freshBusiness = openDb(join(root, "fixture-business.sqlite"), { bootstrap: false }), freshWriters = openWriters(root);
    try {
      expect(freshBusiness.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "failed" });
      expect(freshWriters.inspect().tasks[0]).toMatchObject({ outcome: null, remote_subwork: "unknown" });
      expect(freshWriters.inspect().writer_quiescence).toBe(false);
    } finally { freshBusiness.close(); freshWriters.close(); }
  });

  it("no terminal attempt means local finish error still rejects without manufacturing a diagnostic", async () => {
    const controller = new AbortController(); controller.abort(new TaskCancellationError("cancelled"));
    await expect(runGenerationDispatchOnce(db, async () => {}, { signal: controller.signal,
      terminalWriterAdmission: { ...admission, finish: () => { throw new Error("fixture local finish cut"); } },
    })).rejects.toThrow("fixture local finish cut");
    expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "queued" });
  });

  it("foreign core DB and missing/mismatched profile refuse before any registration/claim/execute", async () => {
    const foreign = openDb(":memory:"); const execute = vi.fn();
    try {
      await expect(runGenerationDispatchOnce(foreign, execute, { terminalWriterAdmission: admission })).rejects.toThrow("writer_terminal_business_mismatch");
      for (const bad of [{ ...admission, version: "wrong" }, { ...admission, [Symbol.for("insight-agent.a3-terminal-admission-v1")]: undefined }]) {
        await expect(runGenerationDispatchOnce(db, execute, { terminalWriterAdmission: bad as TerminalWriterAdmission })).rejects.toThrow("writer_terminal_business_mismatch");
      }
      expect(execute).not.toHaveBeenCalled(); expect(writers.inspect().tasks).toEqual([]); expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "queued" });
    } finally { foreign.close(); }
  });

  it("no_claim and bind refusal only record local finish, with no terminal authority or execution", async () => {
    const controller = new AbortController(); controller.abort(new TaskCancellationError("cancelled")); const execute = vi.fn();
    expect(await runGenerationDispatchOnce(db, execute, { terminalWriterAdmission: admission, signal: controller.signal })).toEqual({ claimed: false });
    const attempt = vi.fn(admission.commitOutcome), bind = vi.fn(() => { throw new Error("fixture bind denial"); });
    await expect(runGenerationDispatchOnce(db, execute, { terminalWriterAdmission: { ...admission, bindClaim: bind, commitOutcome: attempt } })).resolves.toMatchObject({ status: "failed" });
    expect(execute).not.toHaveBeenCalled(); expect(attempt).not.toHaveBeenCalled(); expect(writers.inspect().tasks.map(t => t.outcome)).toEqual(["no_claim", "failed"]);
  });

  it("first cancellation remains unchanged and lease loss wins before strict gate", async () => {
    const controller = new AbortController(), attempt = vi.fn(admission.commitOutcome);
    let release!: () => void;
    const work = runGenerationDispatchOnce(db, async (_db, _topic, opts) => {
      await new Promise<void>(resolve => { release = resolve; }); expect(opts.signal?.reason.reasonCode).toBe("cancelled");
    }, { signal: controller.signal, terminalWriterAdmission: { ...admission, commitOutcome: attempt } });
    controller.abort(new TaskCancellationError("cancelled")); controller.abort(new TaskCancellationError("task_deadline_exceeded"));
    writers.closeAdmission(); db.prepare("UPDATE generation_lease SET owner_token='other-owner'").run(); release();
    expect((await work).status).toBe("failed"); expect(attempt).not.toHaveBeenCalled(); expect(controller.signal.reason.reasonCode).toBe("cancelled");
    expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({ state: "claimed" });
  });
});

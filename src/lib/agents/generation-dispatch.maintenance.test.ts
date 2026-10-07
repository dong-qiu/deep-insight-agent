import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../../../ops/maintenance/ledger.mjs";
import { initializeWriters, openWriters } from "../../../ops/maintenance/writers.mjs";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { claimNextGenerationDispatch, createDeepDiveTraceRequest, hashIdempotencyKey } from "../db/provenance.js";
import { finishRun, insertRun, insertTopic } from "../db/repos.js";
import { appendGenerationEvent } from "../db/provenance-facts.js";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";
import { TaskCancellationError } from "../runtime/cancellation.js";

// No SDK/provider calls. Real core admission, business claim/lease and failure writes are executed.
describe("isolated maintenance registration at the real dispatch core", () => {
  let db: DB;
  let root: string;
  let writers: ReturnType<typeof openWriters>;
  beforeEach(() => {
    vi.stubEnv("COST_LIMIT_TASK", undefined);
    db = openDb(":memory:"); applyProvenanceMigrations(db);
    insertTopic(db, { id: "topic_a", name: "Topic A", keywords: [], language: "en", brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [] });
    root = realpathSync(mkdtempSync(join(tmpdir(), "insight-a3-core-"))); chmodSync(root, 0o700);
    const { publicKey } = generateKeyPairSync("ed25519");
    initialize(root, { target: { region: "isolated", instanceId: "fixture-app", volumeId: "fixture-data", dataPath: root, serviceSet: ["app"] }, approverId: "fixture-reviewer", publicKey: publicKey.export({ type: "spki", format: "pem" }) });
    initializeWriters(root); writers = openWriters(root);
  });
  afterEach(() => { db.close(); writers.close(); rmSync(root, { recursive: true }); vi.unstubAllEnvs(); });
  function admission() { return writers.admissionFor(writers.register("generation-one", "generation-dispatch")); }
  function accept() {
    const result = createDeepDiveTraceRequest(db, { topicId: "topic_a", idempotencyKeyHash: hashIdempotencyKey("abcdefgh", "synthetic-secret"), planning: true });
    if (result.kind !== "accepted") throw new Error("expected accepted request"); return result;
  }
  function state() { return db.prepare("SELECT state FROM generation_dispatch").get(); }

  it("registers before any claim/root Run writes and records real failure without declaring remote stop", async () => {
    accept(); const writerAdmission = admission();
    const originalAdmit = writerAdmission.admit;
    const admit = vi.spyOn(writerAdmission, "admit").mockImplementation(() => {
      expect(db.prepare("SELECT count(*) AS n FROM run").get()).toEqual({ n: 0 }); expect(state()).toEqual({ state: "queued" });
      return originalAdmit();
    });
    await expect(runGenerationDispatchOnce(db, async () => {
      expect(writers.inspect().tasks).toHaveLength(1); expect(writers.inspect().tasks[0].outcome).toBeNull();
      throw new Error("synthetic failure");
    }, { writerAdmission })).resolves.toMatchObject({ claimed: true, status: "failed" });
    expect(admit).toHaveBeenCalledOnce(); expect(state()).toEqual({ state: "failed" });
    expect(writers.inspect().tasks[0]).toMatchObject({ outcome: "failed", remote_subwork: "unknown" });
    expect(writers.inspect().writer_quiescence).toBe(false);
  });

  it("records done after real dispatch finalization with controlled executor terminal facts", async () => {
    accept(); const writerAdmission = admission();
    const result = await runGenerationDispatchOnce(db, async (runDb, _topic, opts) => {
      opts.assertWrite?.();
      // Terminal facts are synthetic here; no report writer or AI-quality claim is made.
      runDb.prepare("UPDATE run SET status='done' WHERE id=?").run(opts.rootRunId!);
      appendGenerationEvent(runDb, { trace_id: opts.traceId!, stage: "select", event_type: "completed" });
      appendGenerationEvent(runDb, {
        trace_id: opts.traceId!, run_id: opts.rootRunId!, stage: "analyze", event_type: "started",
        version_context: { analyzer_model: "test-analyzer", analyzer_prompt_hash: "a".repeat(64), analyzer_output_version: "v1", analyzer_cache_mode: "off" }, context_completeness: "complete",
      });
      appendGenerationEvent(runDb, { trace_id: opts.traceId!, run_id: opts.rootRunId!, stage: "analyze", event_type: "completed" });
      for (const [id, kind, stage] of [["run_validate", "validate", "validate"], ["run_report", "report-gen", "generate_report"]] as const) {
        insertRun(runDb, { id, kind, target: {}, status: "running", started_at: new Date().toISOString(), ended_at: null, duration_ms: null, cost: null, error: null, retry_of: null, trace_id: opts.traceId! });
        appendGenerationEvent(runDb, { trace_id: opts.traceId!, run_id: id, stage, event_type: "completed" });
        finishRun(runDb, id, { status: "done", duration_ms: 1 });
      }
    }, { writerAdmission });
    expect(result.status).toBe("done"); expect(state()).toEqual({ state: "done" });
    expect(db.prepare("SELECT state FROM generation_lease").get()).toEqual({ state: "released" });
    expect(writers.inspect().tasks[0]).toMatchObject({ outcome: "done", remote_subwork: "unknown" });
  });

  it("closed admission leaves queued work untouched and performs no claim or execute", async () => {
    accept(); const writerAdmission = admission(); writers.closeAdmission(); const execute = vi.fn();
    await expect(runGenerationDispatchOnce(db, execute, { writerAdmission })).rejects.toThrow("writer_admission_closed");
    expect(execute).not.toHaveBeenCalled(); expect(state()).toEqual({ state: "queued" });
    expect(db.prepare("SELECT count(*) AS n FROM run").get()).toEqual({ n: 0 }); expect(writers.inspect().tasks).toEqual([]);
  });

  it("without opt-in the unchanged core does not issue coverage receipts", async () => {
    expect(await runGenerationDispatchOnce(db)).toEqual({ claimed: false }); expect(writers.inspect().tasks).toEqual([]);
  });

  it("empty queue and pre-cancelled execution produce definite local no_claim without deleting registration", async () => {
    const writerAdmission = admission(); expect(await runGenerationDispatchOnce(db, undefined, { writerAdmission })).toEqual({ claimed: false });
    accept(); const controller = new AbortController(); controller.abort(new TaskCancellationError("cancelled"));
    expect(await runGenerationDispatchOnce(db, undefined, { writerAdmission, signal: controller.signal })).toEqual({ claimed: false });
    expect(state()).toEqual({ state: "queued" }); expect(writers.inspect().tasks.map(t => t.outcome)).toEqual(["no_claim", "no_claim"]);
  });

  it("claim errors and invalid config are recorded as threw with no invisible in-flight record", async () => {
    const writerAdmission = admission(); db.close();
    await expect(runGenerationDispatchOnce(db, undefined, { writerAdmission })).rejects.toThrow();
    expect(writers.inspect().tasks[0].outcome).toBe("threw");
    // Restore the test's connection solely for fixture teardown.
    db = openDb(":memory:");
    await expect(runGenerationDispatchOnce(db, undefined, { writerAdmission, taskBudgetUsd: Number.NaN })).rejects.toThrow("invalid_task_budget");
    expect(writers.inspect().tasks[1].outcome).toBe("threw");
  });

  it("closing during claimed work does not alter lease or stop cooperation and retains the first cancellation reason", async () => {
    const accepted = accept(); const writerAdmission = admission(); const controller = new AbortController();
    let release!: () => void; let signal: AbortSignal | undefined;
    const pending = runGenerationDispatchOnce(db, async (_db, _topic, opts) => {
      signal = opts.signal; await new Promise<void>(resolve => { release = resolve; });
      opts.assertWrite?.();
    }, { writerAdmission, signal: controller.signal });
    expect(state()).toEqual({ state: "claimed" }); writers.closeAdmission();
    expect(state()).toEqual({ state: "claimed" }); expect(writers.inspect().tasks[0].outcome).toBeNull();
    controller.abort(new TaskCancellationError("cancelled")); expect(signal?.aborted).toBe(true); release();
    await expect(pending).resolves.toMatchObject({ claimed: true, traceId: accepted.traceId, status: "failed" });
    const row = db.prepare("SELECT last_error FROM generation_dispatch").get() as { last_error: string };
    expect(JSON.parse(row.last_error).reason_code).toBe("cancelled"); expect(writers.inspect().tasks[0].outcome).toBe("failed");
  });

  it("expired claim takeover keeps the old core fenced and its remote work unknown", async () => {
    accept(); const writerAdmission = admission(); let release!: () => void;
    const pending = runGenerationDispatchOnce(db, async (_db, _topic, opts) => {
      await new Promise<void>(resolve => { release = resolve; }); opts.assertWrite?.();
    }, { writerAdmission });
    db.prepare("UPDATE generation_dispatch SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(claimNextGenerationDispatch(db)).not.toBeNull(); release();
    await expect(pending).resolves.toMatchObject({ claimed: true, status: "failed" });
    expect(state()).toEqual({ state: "claimed" });
    expect(writers.inspect().tasks[0]).toMatchObject({ outcome: "failed", remote_subwork: "unknown" });
  });
});

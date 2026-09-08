import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityDeniedTransport, type GitHubEvidencePort, type RuntimeSnapshotPort } from "./ports.js";
import { createControllerRecord } from "./replay.js";
import { reconcileController } from "./reconciler.js";
import { ControllerStore, type DurableControllerRecord } from "./store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const now = "2026-09-08T00:10:00.000Z";
const freshness = { head_sha: "head-1", base_sha: "base-1", merge_state_status: "clean" };

function setup(record: DurableControllerRecord): ControllerStore {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-reconciler-")); directories.push(directory);
  const db = new ControllerStore({ root_dir: directory }); db.create(record); return db;
}
function setupWithPath(record: DurableControllerRecord): { db: ControllerStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-reconciler-")); directories.push(directory);
  const path = join(directory, "controller.sqlite");
  const db = new ControllerStore({ root_dir: directory }); db.create(record); return { db, path };
}
function github(snapshot = freshness): GitHubEvidencePort {
  return { async readGitHubEvidenceSnapshot() { return { observed_at: now, snapshot: { id: `snapshot-${snapshot.head_sha}`, immutable_ref: "https://example.invalid/pr/1", payload_hash: "snapshot-hash", freshness: snapshot, observed_at: now } }; } };
}
function githubWithEvidence(snapshot = freshness, observedAt = now): GitHubEvidencePort {
  return { async readGitHubEvidenceSnapshot() { return {
    observed_at: now,
    snapshot: { id: `snapshot-${snapshot.head_sha}`, immutable_ref: "https://example.invalid/pr/1", payload_hash: "snapshot-hash", freshness: snapshot, observed_at: observedAt },
    ci: { id: `ci-${snapshot.head_sha}`, immutable_ref: "https://example.invalid/ci/1", payload_hash: "ci-hash", freshness: snapshot, conclusion: "passed", observed_at: observedAt },
    review: { id: `review-${snapshot.head_sha}`, immutable_ref: "https://example.invalid/review/1", payload_hash: "review-hash", freshness: snapshot, conclusion: "approved", observed_at: observedAt },
  }; } };
}
function runtime(input: Awaited<ReturnType<RuntimeSnapshotPort["readRuntimeSnapshot"]>>): RuntimeSnapshotPort { return { async readRuntimeSnapshot() { return input; } }; }
function base(): DurableControllerRecord { return { ...createControllerRecord({ delivery_id: "delivery-1", state: "executing", generation: 0, active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_runtime_identity: "identity-1", active_lease_fencing_token: "fence-1", active_lease_expires_at: "2026-09-08T00:20:00.000Z", current_freshness: freshness }), updated_at: "2026-09-08T00:00:00.000Z" }; }

describe("read-only controller reconciliation", () => {
  it("recovers an offline executing runtime without charging an attempt", async () => {
    const db = setup(base());
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: "2026-09-08T00:08:00.000Z", tasks: [{ task_id: "task-1", state: "running", lease_id: "lease-1" }] }), github: github() }, now);
    expect(result.record).toMatchObject({ state: "waiting_for_runtime", attempt_count: 0 });
    expect(result.record?.active_lease_id).toBeUndefined();
    db.close();
  });

  it("records a fresh, fully fenced read-only lease snapshot as reconnect evidence", async () => {
    const waiting = { ...base(), state: "waiting_for_runtime" as const, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_fencing_token: undefined, active_lease_expires_at: undefined };
    const db = setup(waiting);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [{ task_id: "task-1", state: "leased", lease_id: "lease-2", runtime_id: "runtime-2", runtime_identity: "identity-2", lease_fencing_token: "fence-2", lease_expires_at: "2026-09-08T00:20:00.000Z" }] }), github: github() }, now);
    expect(result.record).toMatchObject({ state: "leased", active_lease_id: "lease-2", active_runtime_id: "runtime-2", attempt_count: 0 });
    db.close();
  });

  it("requires fenced start and terminal receipts for waiting → leased → executing → terminal", async () => {
    const waiting = { ...base(), state: "waiting_for_runtime" as const, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_fencing_token: undefined, active_lease_expires_at: undefined };
    const db = setup(waiting);
    const lease = { task_id: "task-1", state: "leased" as const, lease_id: "lease-2", runtime_id: "runtime-2", runtime_identity: "identity-2", lease_fencing_token: "fence-2", lease_expires_at: "2026-09-08T00:20:00.000Z" };
    expect((await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [lease] }), github: github() }, now)).record).toMatchObject({ state: "leased", attempt_count: 0 });
    const receipt = { receipt_id: "receipt-start-1", delivery_id: "delivery-1", generation: 0, task_id: lease.task_id, lease_id: lease.lease_id, runtime_id: lease.runtime_id, runtime_identity: lease.runtime_identity, lease_fencing_token: lease.lease_fencing_token, lease_expires_at: lease.lease_expires_at, observed_at: now, expected_state: "running" as const };
    expect((await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [{ ...lease, state: "running", start_receipt: receipt }] }), github: github() }, now)).record).toMatchObject({ state: "executing", attempt_count: 0 });
    expect((await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [{ ...lease, state: "completed", result: "completed", terminal_receipt: { ...receipt, receipt_id: "receipt-terminal-1", expected_state: "completed", result: "completed" } }] }), github: github() }, now)).record).toMatchObject({ state: "evidence_collecting", attempt_count: 1 });
    db.close();
  });

  it("audits incomplete, stale, mismatched, and expired receipts without charging an attempt", async () => {
    const scenarios = [
      { name: "expired", heartbeat_at: now, task: { task_id: "task-1", state: "completed" as const, lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:00:00.000Z", result: "completed" as const, terminal_receipt: { lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:00:00.000Z", observed_at: now, result: "completed" as const } } },
      { name: "missing-heartbeat", heartbeat_at: undefined, task: { task_id: "task-1", state: "completed" as const, lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", result: "completed" as const } },
      { name: "result-mismatch", heartbeat_at: now, task: { task_id: "task-1", state: "completed" as const, lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", result: "failed" as const, terminal_receipt: { lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", observed_at: now, result: "failed" as const } } },
      { name: "old-lease", heartbeat_at: now, task: { task_id: "old", state: "completed" as const, lease_id: "old-lease", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", result: "completed" as const, terminal_receipt: { lease_id: "old-lease", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", observed_at: now, result: "completed" as const } } },
    ];
    for (const scenario of scenarios) {
      const initial = scenario.name === "expired" ? { ...base(), active_lease_expires_at: "2026-09-08T00:00:00.000Z" } : base();
      const db = setup(initial);
      const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: scenario.heartbeat_at, tasks: [scenario.task] }), github: github() }, now);
      expect(result.record?.attempt_count).toBe(0);
      expect(result.record?.state).not.toBe("evidence_collecting");
      db.close();
    }
  });

  it.each([
    { name: "old-delivery", task_id: "task-1", delivery_id: "delivery-old", heartbeat_at: now, observed_at: now },
    { name: "same-lease-different-task", task_id: "task-2", delivery_id: "delivery-1", heartbeat_at: now, observed_at: now },
    { name: "future-receipt", task_id: "task-1", delivery_id: "delivery-1", heartbeat_at: now, observed_at: "2026-09-08T00:11:00.000Z" },
    { name: "reversed-receipt", task_id: "task-1", delivery_id: "delivery-1", heartbeat_at: now, observed_at: "2026-09-08T00:09:00.000Z" },
  ])("audits %s receipt fencing without advancing or charging an attempt", async (scenario) => {
    const db = setup(base());
    const task = { task_id: scenario.task_id, state: "completed" as const, lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", result: "completed" as const, terminal_receipt: { receipt_id: `receipt-${scenario.name}`, delivery_id: scenario.delivery_id, generation: 0, task_id: scenario.task_id, lease_id: "lease-1", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", lease_expires_at: "2026-09-08T00:20:00.000Z", expected_state: "completed" as const, result: "completed" as const, observed_at: scenario.observed_at } };
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: scenario.heartbeat_at, tasks: [task] }), github: github() }, now);
    expect(result.record).toMatchObject({ state: "executing", attempt_count: 0 });
    db.close();
  });

  it("fences an old terminal result and permits expiry recovery", async () => {
    const expired = { ...base(), active_lease_expires_at: "2026-09-08T00:00:00.000Z", consecutive_lease_losses: 2 };
    const db = setup(expired);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [{ task_id: "old", state: "completed", lease_id: "old-lease", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", result: "completed" }] }), github: github() }, now);
    // A late result is audited and expiry recovery, not the result, advances the record.
    expect(result.record).toMatchObject({ state: "awaiting_human_decision", attempt_count: 0, consecutive_lease_losses: 3 });
    db.close();
  });

  it("invalidates head/base/CLEAN changes before retaining any ready evidence", async () => {
    const ready = { ...base(), state: "ready_for_human_review" as const, evidence: [{ id: "old-ci", kind: "ci" as const, source: "fixture", immutable_ref: "ci", payload_hash: "x", freshness, status: "active" as const, conclusion: "passed" as const, observed_at: now }] };
    const db = setup(ready);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github({ ...freshness, head_sha: "head-2" }) }, now);
    expect(result.record).toMatchObject({ state: "freshness_invalidated", generation: 1 });
    expect(result.record?.active_lease_id).toBeUndefined();
    expect(result.record?.evidence.every((item) => item.status === "superseded")).toBe(true);
    db.close();
  });

  it("invalidates evidence collection when CI or review proof cannot be reread", async () => {
    const collecting = { ...base(), state: "evidence_collecting" as const };
    const db = setup(collecting);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github() }, now);
    expect(result.record).toMatchObject({ state: "freshness_invalidated", generation: 1 });
    db.close();
  });

  it.each(["snapshot", "ci", "review"])("fails closed when ready %s evidence has expired", async (kind) => {
    const evidenceTime = kind === "snapshot" ? "2026-09-07T23:59:00.000Z" : "2026-09-06T00:00:00.000Z";
    const ready = { ...base(), state: "ready_for_human_review" as const };
    const db = setup(ready);
    const first = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: githubWithEvidence(freshness, evidenceTime) }, now);
    expect(first.record).toMatchObject({ state: "freshness_invalidated", generation: 1 });
    db.close();
  });

  it.each([
    { head_sha: "head-2", base_sha: "base-1", merge_state_status: "clean" },
    { head_sha: "head-1", base_sha: "base-2", merge_state_status: "clean" },
    { head_sha: "head-1", base_sha: "base-1", merge_state_status: "dirty" },
    { head_sha: "head-1", base_sha: "base-1", merge_state_status: "unknown" },
  ])("invalidates changed freshness then only readmits a new clean generation with matching evidence", async (changed) => {
    const ready = { ...base(), state: "ready_for_human_review" as const, evidence: [
      { id: "snapshot-old", kind: "snapshot" as const, source: "fixture", immutable_ref: "snapshot", payload_hash: "snapshot", freshness, status: "active" as const, observed_at: now },
      { id: "ci-old", kind: "ci" as const, source: "fixture", immutable_ref: "ci", payload_hash: "ci", freshness, status: "active" as const, conclusion: "passed" as const, observed_at: now },
      { id: "review-old", kind: "review" as const, source: "fixture", immutable_ref: "review", payload_hash: "review", freshness, status: "active" as const, conclusion: "approved" as const, observed_at: now },
    ] };
    const db = setup(ready);
    const ports = { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github(changed) };
    const invalidated = await reconcileController(db, "delivery-1", ports, now);
    expect(invalidated.record).toMatchObject({ state: "freshness_invalidated", generation: 1 });
    const fresh = { head_sha: "head-3", base_sha: "base-3", merge_state_status: "clean" };
    expect((await reconcileController(db, "delivery-1", { runtime: ports.runtime, github: githubWithEvidence(fresh) }, now)).record).toMatchObject({ state: "evidence_collecting", generation: 1 });
    expect((await reconcileController(db, "delivery-1", { runtime: ports.runtime, github: githubWithEvidence(fresh) }, now)).record).toMatchObject({ state: "ready_for_human_review", generation: 1, ready_bundle: expect.objectContaining({ generation: 1, freshness: fresh }) });
    db.close();
  });

  it("dedupes the invalidation outbox receipt across repeated stale freshness reads", async () => {
    const { db, path } = setupWithPath({ ...base(), state: "ready_for_human_review" as const });
    const changed = { ...freshness, head_sha: "head-2" };
    const ports = { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github(changed) };
    await reconcileController(db, "delivery-1", ports, now);
    await reconcileController(db, "delivery-1", ports, now);
    const reader = new Database(path, { readonly: true });
    expect(reader.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE dedupe_key LIKE ?").get("%:invalidation:%")).toEqual({ count: 1 });
    reader.close();
    db.close();
  });

  it("freezes on adapter errors or multiple active tasks, and exposes no mutation capability", async () => {
    const db = setup(base());
    const deniedGithub: GitHubEvidencePort = { async readGitHubEvidenceSnapshot() { throw new Error("offline"); } };
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: deniedGithub }, now);
    expect(result.record?.state).toBe("awaiting_human_decision");
    expect(capabilityDeniedTransport.denied).toEqual(expect.arrayContaining(["merge", "deploy", "credentials", "iam", "task_mutation"]));
    expect(Object.keys(capabilityDeniedTransport)).not.toEqual(expect.arrayContaining(["merge", "deploy", "createTask", "sendNotification"]));
    db.close();
  });
});

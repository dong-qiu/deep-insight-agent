import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const db = new ControllerStore(join(directory, "controller.sqlite")); db.create(record); return db;
}
function github(snapshot = freshness): GitHubEvidencePort {
  return { async readGitHubEvidenceSnapshot() { return { observed_at: now, snapshot: { id: `snapshot-${snapshot.head_sha}`, immutable_ref: "https://example.invalid/pr/1", payload_hash: "snapshot-hash", freshness: snapshot, observed_at: now } }; } };
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

  it("fences an old terminal result and freezes a third lost lease", async () => {
    const expired = { ...base(), active_lease_expires_at: "2026-09-08T00:00:00.000Z", consecutive_lease_losses: 2 };
    const db = setup(expired);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [{ task_id: "old", state: "completed", lease_id: "old-lease", runtime_id: "runtime-1", runtime_identity: "identity-1", lease_fencing_token: "fence-1", result: "completed" }] }), github: github() }, now);
    // A late result is audited; it cannot advance the record. The next recheck still sees expiry and freezes.
    expect(result.record?.state).toBe("executing");
    const frozen = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github() }, now);
    expect(frozen.record).toMatchObject({ state: "awaiting_human_decision", attempt_count: 0, consecutive_lease_losses: 3 });
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

  it("freezes evidence collection when a read-only snapshot lacks CI or review proof", async () => {
    const collecting = { ...base(), state: "evidence_collecting" as const };
    const db = setup(collecting);
    const result = await reconcileController(db, "delivery-1", { runtime: runtime({ observed_at: now, heartbeat_at: now, tasks: [] }), github: github() }, now);
    expect(result.record?.state).toBe("awaiting_human_decision");
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

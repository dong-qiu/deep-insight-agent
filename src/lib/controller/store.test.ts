import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerRecord, type NotificationPlan, type TransitionEvent } from "./replay.js";
import { canAcceptEvidence, ControllerStore, type DurableControllerRecord, type StoreMutation } from "./store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function store(): ControllerStore {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-store-"));
  directories.push(directory);
  return new ControllerStore(join(directory, "controller.sqlite"));
}
function storeWithPath(): { db: ControllerStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-store-"));
  directories.push(directory);
  const path = join(directory, "controller.sqlite");
  return { db: new ControllerStore(path), path };
}
function record(deliveryId = "delivery-1"): DurableControllerRecord {
  return { ...createControllerRecord({ delivery_id: deliveryId, state: "admitted", generation: 0 }), updated_at: "2026-09-08T00:00:00.000Z" };
}
function mutation(before: DurableControllerRecord, key = "delivery-1:0:queue:one"): StoreMutation {
  const next = { ...before, state: "waiting_for_runtime" as const, active_task_ids: ["task-1"], updated_at: "2026-09-08T00:01:00.000Z" };
  const transition: TransitionEvent = { event_id: "transition-1", causal_event_id: "queue-1", delivery_id: before.delivery_id, generation_before: 0, generation_after: 0, from_state: "admitted", to_state: "waiting_for_runtime", writer: "test", occurred_at: next.updated_at, idempotency_key: key, precondition: "test", evidence_refs: ["plan"], recovery_action: "none" };
  return { expected: { generation: 0, state: "admitted" }, next, transition };
}
function plan(): NotificationPlan {
  return { dedupe_key: "delivery-1:0:offline:one", signal: "offline", occurred_at: "2026-09-08T00:01:00.000Z", causal_event_id: "offline-1", delivery_id: "delivery-1", generation: 0, retry: { idempotency_key: "notify-1", backoff_minutes: [5, 15], max_attempts: 3, external_delivery: false }, audit_fields: {} };
}

describe("ControllerStore", () => {
  it("uses an explicitly injected isolated file and rejects any implicit memory/default path", () => {
    expect(() => new ControllerStore(":memory:")).toThrow("explicit_isolated_file_path");
    const db = store();
    expect(db.create(record()).kind).toBe("applied");
    db.close();
  });

  it("returns the original effect for a duplicate CAS append and rejects a semantic conflict", () => {
    const db = store();
    const original = record();
    db.create(original);
    const first = mutation(original);
    expect(db.compareAndAppend(first).kind).toBe("applied");
    expect(db.compareAndAppend(first).kind).toBe("replayed");
    expect(db.compareAndAppend({ ...first, next: { ...first.next, active_task_ids: ["second-active-task"] } }).kind).toBe("semantic_conflict");
    expect(db.load("delivery-1")?.active_task_ids).toEqual(["task-1"]);
    db.close();
  });

  it("atomically rejects incomplete or inconsistent transition envelopes", () => {
    const db = store();
    const original = record();
    db.create(original);
    const cases: StoreMutation[] = [
      { ...mutation(original), transition: { ...mutation(original).transition!, delivery_id: "other-delivery" } },
      { ...mutation(original), transition: { ...mutation(original).transition!, generation_after: 1 } },
      { ...mutation(original), transition: { ...mutation(original).transition!, from_state: "intake" } },
      { ...mutation(original), transition: { ...mutation(original).transition!, to_state: "admitted" } },
      { ...mutation(original), transition: { ...mutation(original).transition!, precondition: "" } },
      { ...mutation(original), transition: { ...mutation(original).transition!, from_state: "admitted", to_state: "admitted" } },
      { ...mutation(original), transition: { ...mutation(original).transition!, to_state: "cancelled" } },
    ];
    for (const invalid of cases) expect(() => db.compareAndAppend(invalid)).toThrow("invalid_controller_mutation");
    expect(db.load(original.delivery_id)).toMatchObject({ state: "admitted", generation: 0 });
    db.close();
  });

  it("persists a snapshot-only observation as evidence without a homomorphic transition", () => {
    const { db, path } = storeWithPath();
    const original = record();
    db.create(original);
    const snapshot = { id: "snapshot-1", kind: "snapshot" as const, source: "test", immutable_ref: "snapshot", payload_hash: "hash", status: "active" as const, observed_at: "2026-09-08T00:01:00.000Z", freshness: { head_sha: "head-1", base_sha: "base-1", merge_state_status: "clean" } };
    const next = { ...original, current_freshness: snapshot.freshness, evidence: [snapshot], updated_at: snapshot.observed_at };
    expect(db.compareAndAppend({ expected: { generation: 0, state: "admitted" }, next, evidence: [snapshot], idempotency_key: "delivery-1:0:evidence:snapshot-1" }).kind).toBe("applied");
    const reader = new Database(path, { readonly: true });
    expect(reader.prepare("SELECT COUNT(*) AS count FROM controller_transition").get()).toEqual({ count: 0 });
    expect(reader.prepare("SELECT COUNT(*) AS count FROM controller_evidence").get()).toEqual({ count: 1 });
    reader.close();
    db.close();
  });

  it("makes a crash between invalidation fence and completion fail closed after restart", () => {
    const db = store();
    const original = { ...record(), state: "ready_for_human_review" as const, current_freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } };
    db.create(original);
    expect(db.beginInvalidation(original.delivery_id, { generation: 0, state: "ready_for_human_review" }, { idempotency_key: "invalidate-1", observed_freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" }, reason: "head_changed", fenced_at: "2026-09-08T00:01:00.000Z" }).kind).toBe("applied");
    expect(canAcceptEvidence(db.load(original.delivery_id)!)).toBe(false);
    expect(db.recoverPendingInvalidation(original.delivery_id, "2026-09-08T00:02:00.000Z")?.state).toBe("awaiting_human_decision");
    expect(canAcceptEvidence(db.load(original.delivery_id)!)).toBe(false);
    db.close();
  });

  it("persists one notification receipt and lets only one claimant acquire it", () => {
    const db = store();
    const original = record();
    db.create(original);
    const change = mutation(original);
    change.outbox = [plan(), plan()];
    expect(db.compareAndAppend(change).kind).toBe("applied");
    expect(db.claimNotification(plan().dedupe_key, "claimer-a", "2026-09-08T00:02:00.000Z").kind).toBe("claimed");
    expect(db.claimNotification(plan().dedupe_key, "claimer-b", "2026-09-08T00:02:01.000Z").kind).toBe("already_claimed");
    db.close();
  });
});

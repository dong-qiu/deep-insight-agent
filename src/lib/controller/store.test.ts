import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerRecord, readyBundleFor, readyBundleHash, type Evidence, type NotificationPlan, type ReadyBundle, type TransitionEvent } from "./replay.js";
import { canAcceptEvidence, ControllerStore, type DurableControllerRecord, type StoreMutation } from "./store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function store(): ControllerStore {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-store-"));
  directories.push(directory);
  return new ControllerStore({ root_dir: directory });
}
function storeWithPath(): { db: ControllerStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "insight-controller-store-"));
  directories.push(directory);
  const path = join(directory, "controller.sqlite");
  return { db: new ControllerStore({ root_dir: directory }), path };
}
function record(deliveryId = "delivery-1"): DurableControllerRecord {
  return { ...createControllerRecord({ delivery_id: deliveryId, state: "admitted", generation: 0 }), updated_at: "2026-09-08T00:00:00.000Z" };
}
function mutation(before: DurableControllerRecord, key = "delivery-1:0:queue:one"): StoreMutation {
  const next = { ...before, state: "waiting_for_runtime" as const, active_task_ids: ["task-1"], updated_at: "2026-09-08T00:01:00.000Z" };
  const transition: TransitionEvent = { event_id: "transition-1", causal_event_id: "queue-1", delivery_id: before.delivery_id, generation_before: 0, generation_after: 0, from_state: "admitted", to_state: "waiting_for_runtime", writer: "test", occurred_at: next.updated_at, idempotency_key: key, precondition: "test", evidence_refs: ["plan"], recovery_action: "none" };
  const evidence = { id: "plan", kind: "result" as const, source: "test", immutable_ref: "plan", payload_hash: "plan-hash", status: "active" as const, observed_at: next.updated_at };
  return { expected: { generation: 0, state: "admitted" }, next, transition, evidence: [evidence] };
}
function plan(): NotificationPlan {
  return { dedupe_key: "delivery-1:0:offline:one", signal: "offline", occurred_at: "2026-09-08T00:01:00.000Z", causal_event_id: "offline-1", delivery_id: "delivery-1", generation: 0, retry: { idempotency_key: "notify-1", backoff_minutes: [5, 15], max_attempts: 3, external_delivery: false }, audit_fields: {} };
}
function readyRecord(deliveryId = "delivery-ready"): DurableControllerRecord {
  const freshness = { head_sha: "head-1", base_sha: "base-1", merge_state_status: "clean" };
  const updated_at = "2026-09-08T00:10:00.000Z";
  const evidence: Evidence[] = [
    { id: "snapshot-1", kind: "snapshot", source: "github", immutable_ref: "snapshot-1", payload_hash: "snapshot", freshness, status: "active", observed_at: updated_at },
    { id: "ci-1", kind: "ci", source: "github", immutable_ref: "ci-1", payload_hash: "ci", freshness, status: "active", conclusion: "passed", observed_at: updated_at },
    { id: "review-1", kind: "review", source: "github", immutable_ref: "review-1", payload_hash: "review", freshness, status: "active", conclusion: "approved", observed_at: updated_at },
  ];
  const record = { ...createControllerRecord({ delivery_id: deliveryId, state: "ready_for_human_review", generation: 0, current_freshness: freshness, evidence }), updated_at };
  return { ...record, ready_bundle: readyBundleFor(record, updated_at)! };
}
function rehash(bundle: ReadyBundle): ReadyBundle { return { ...bundle, hash: readyBundleHash(bundle) }; }

describe("ControllerStore", () => {
  it("uses an explicitly injected isolated root and rejects live/shared/escape paths", () => {
    expect(() => new ControllerStore({ root_dir: "" })).toThrow("explicit_isolated_root");
    expect(() => new ControllerStore({ root_dir: join(tmpdir(), "shared", "controller") })).toThrow("live_or_shared_root");
    expect(() => new ControllerStore({ root_dir: tmpdir(), file_name: "../app.sqlite" })).toThrow("escape_file_name");
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

  it("fences two SQLite connections with conditional CAS, idempotency, and an atomic outbox claim", () => {
    const { db: first, path } = storeWithPath();
    const second = new ControllerStore({ root_dir: dirname(path) });
    const original = record();
    first.create(original);
    const applied = mutation(original, "delivery-1:0:queue:one");
    applied.outbox = [plan(), plan()];
    expect(first.compareAndAppend(applied).kind).toBe("applied");
    expect(second.compareAndAppend({ ...mutation(original, "delivery-1:0:queue:other"), outbox: [plan()] }).kind).toBe("cas_conflict");
    expect(second.compareAndAppend(applied).kind).toBe("replayed");
    expect(first.claimNotification(plan().dedupe_key, "first", "2026-09-08T00:02:00.000Z").kind).toBe("claimed");
    expect(second.claimNotification(plan().dedupe_key, "second", "2026-09-08T00:02:00.000Z").kind).toBe("already_claimed");
    second.close();
    first.close();
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

  it("requires transition evidence references to resolve within the same delivery and generation ledger", () => {
    const db = store();
    const original = record();
    db.create(original);
    expect(() => db.compareAndAppend({ ...mutation(original), evidence: [] })).toThrow("evidence_ref_unresolvable");
    const foreign = { ...mutation(original), evidence: [{ id: "plan", kind: "result" as const, source: "test", immutable_ref: "other", payload_hash: "other", status: "active" as const, observed_at: "2026-09-08T00:01:00.000Z" }] };
    expect(db.compareAndAppend(foreign).kind).toBe("applied");
    db.close();
  });

  it("makes a crash between invalidation fence and completion fail closed after restart", () => {
    const db = store();
    const original = readyRecord("delivery-1");
    db.create(original);
    expect(db.beginInvalidation(original.delivery_id, { generation: 0, state: "ready_for_human_review" }, { idempotency_key: "invalidate-1", observed_freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" }, reason: "head_changed", fenced_at: "2026-09-08T00:01:00.000Z" }).kind).toBe("applied");
    expect(canAcceptEvidence(db.load(original.delivery_id)!)).toBe(false);
    expect(db.recoverPendingInvalidation(original.delivery_id, "2026-09-08T00:02:00.000Z")?.state).toBe("awaiting_human_decision");
    expect(canAcceptEvidence(db.load(original.delivery_id)!)).toBe(false);
    db.close();
  });

  it("rejects direct ready creation without a complete ReadyBundle", () => {
    const db = store();
    const { ready_bundle: _bundle, ...withoutBundle } = readyRecord();
    expect(() => db.create(withoutBundle)).toThrow("controller_ready_bundle_required");
    db.close();
  });

  it("fails closed when a raw ready record has an invalid ReadyBundle shape", () => {
    const { ready_bundle: _bundle, ...withoutBundle } = readyRecord();
    expect(canAcceptEvidence(withoutBundle)).toBe(false);
  });

  it("rejects direct create/CAS ready receipts that are not resolvable in the same immutable ledger", () => {
    const db = store();
    expect(db.create(readyRecord()).kind).toBe("applied");
    expect(() => db.create(readyRecord("delivery-other"))).toThrow("controller_evidence_identity_conflict");

    const ready = readyRecord("delivery-cas");
    const before = { ...ready, state: "evidence_collecting" as const, ready_bundle: undefined };
    expect(db.create(before).kind).toBe("applied");
    const transition: TransitionEvent = {
      event_id: "ready-transition", causal_event_id: "ready-event", delivery_id: ready.delivery_id,
      generation_before: 0, generation_after: 0, from_state: "evidence_collecting", to_state: "ready_for_human_review",
      writer: "test", occurred_at: ready.updated_at, idempotency_key: "delivery-cas:0:ready", precondition: "test",
      evidence_refs: ready.evidence.map((evidence) => evidence.id), recovery_action: "none",
    };
    expect(() => db.compareAndAppend({ expected: { generation: 0, state: "evidence_collecting" }, next: ready, transition })).toThrow("controller_ready_bundle_evidence_ledger_unresolvable");
    expect(db.load(ready.delivery_id)?.state).toBe("evidence_collecting");
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

  it.each([
    { name: "malformed hash", modify: (value: DurableControllerRecord) => ({ ...value, ready_bundle: { ...value.ready_bundle!, hash: "broken" } }) },
    { name: "expired snapshot", modify: (value: DurableControllerRecord) => {
      const observed_at = "2026-09-07T23:59:59.999Z";
      const evidence = value.evidence.map((item) => item.kind === "snapshot" ? { ...item, observed_at } : item);
      const bundle = rehash({ ...value.ready_bundle!, snapshot_evidence: { ...value.ready_bundle!.snapshot_evidence, observed_at } });
      return { ...value, evidence, ready_bundle: bundle };
    } },
    { name: "future CI receipt", modify: (value: DurableControllerRecord) => {
      const observed_at = "2026-09-08T00:10:00.001Z";
      const evidence = value.evidence.map((item) => item.kind === "ci" ? { ...item, observed_at } : item);
      const bundle = rehash({ ...value.ready_bundle!, ci_evidence: { ...value.ready_bundle!.ci_evidence, observed_at } });
      return { ...value, evidence, ready_bundle: bundle };
    } },
    { name: "invalid review timestamp", modify: (value: DurableControllerRecord) => {
      const observed_at = "not-a-date";
      const evidence = value.evidence.map((item) => item.kind === "review" ? { ...item, observed_at } : item);
      const bundle = rehash({ ...value.ready_bundle!, review_evidence: { ...value.ready_bundle!.review_evidence, observed_at } });
      return { ...value, evidence, ready_bundle: bundle };
    } },
    { name: "non-clean freshness", modify: (value: DurableControllerRecord) => {
      const freshness = { ...value.current_freshness!, merge_state_status: "dirty" };
      const evidence = value.evidence.map((item) => ({ ...item, freshness }));
      const bundle = rehash({ ...value.ready_bundle!, freshness, snapshot_evidence: { ...value.ready_bundle!.snapshot_evidence, freshness }, ci_evidence: { ...value.ready_bundle!.ci_evidence, freshness }, review_evidence: { ...value.ready_bundle!.review_evidence, freshness } });
      return { ...value, current_freshness: freshness, evidence, ready_bundle: bundle };
    } },
    { name: "mismatched freshness", modify: (value: DurableControllerRecord) => {
      const freshness = { ...value.ready_bundle!.freshness, head_sha: "other-head" };
      return { ...value, ready_bundle: rehash({ ...value.ready_bundle!, freshness }) };
    } },
  ])("rejects direct $name ReadyBundle data", ({ modify }) => {
    const db = store();
    expect(() => db.create(modify(readyRecord()))).toThrow(/controller_ready_bundle_(invalid|evidence_missing)/);
    db.close();
  });
});

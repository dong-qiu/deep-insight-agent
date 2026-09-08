/**
 * A deliberately separate, Node-only SQLite store for the delivery Controller.
 *
 * Callers must provide a concrete local path. This module never reads DB_PATH
 * and therefore cannot accidentally attach to the application's live database.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ControllerRecord, Evidence, NotificationPlan, TransitionEvent } from "./replay.js";

export type DurableControllerRecord = ControllerRecord & {
  updated_at: string;
  pending_invalidation?: PendingInvalidation;
};

export interface PendingInvalidation {
  idempotency_key: string;
  observed_freshness: Evidence["freshness"];
  reason: string;
  fenced_at: string;
}

export interface ExpectedRecord {
  generation: number;
  state?: DurableControllerRecord["state"];
}

export interface StoreMutation {
  expected: ExpectedRecord;
  next: DurableControllerRecord;
  transition: TransitionEvent;
  evidence?: Evidence[];
  outbox?: NotificationPlan[];
  audit?: readonly { kind: string; reason: string; occurred_at: string }[];
}

export type AppendResult =
  | { kind: "applied"; record: DurableControllerRecord }
  | { kind: "replayed"; record: DurableControllerRecord }
  | { kind: "cas_conflict"; record?: DurableControllerRecord }
  | { kind: "semantic_conflict"; record?: DurableControllerRecord };

export interface NotificationClaim {
  kind: "claimed" | "already_claimed" | "missing";
  plan?: NotificationPlan;
}

/** The acceptance predicate is intentionally available to every reader. */
export function canAcceptEvidence(record: DurableControllerRecord): boolean {
  return !record.pending_invalidation && record.state !== "freshness_invalidated" && record.state !== "awaiting_human_decision";
}

export class ControllerStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (!path || path === ":memory:") throw new Error("controller_store_requires_explicit_isolated_file_path");
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new Database(absolutePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  load(deliveryId: string): DurableControllerRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM controller_record WHERE delivery_id=?").get(deliveryId) as { record_json: string } | undefined;
    return row && clone(JSON.parse(row.record_json) as DurableControllerRecord);
  }

  create(record: DurableControllerRecord): AppendResult {
    const existing = this.load(record.delivery_id);
    if (existing) return { kind: "cas_conflict", record: existing };
    this.db.prepare("INSERT INTO controller_record(delivery_id,generation,state,pending_invalidation,record_json,updated_at) VALUES (@delivery_id,@generation,@state,0,@record_json,@updated_at)")
      .run({ ...record, record_json: JSON.stringify(record) });
    return { kind: "applied", record: clone(record) };
  }

  compareAndAppend(mutation: StoreMutation): AppendResult {
    const semantic = stableJson({ expected: mutation.expected, next: mutation.next, transition: mutation.transition, evidence: mutation.evidence ?? [], outbox: mutation.outbox ?? [], audit: mutation.audit ?? [] });
    const tx = this.db.transaction(() => {
      const prior = this.load(mutation.next.delivery_id);
      const idem = this.db.prepare("SELECT semantic_json,effect_json FROM controller_idempotency WHERE idempotency_key=?").get(mutation.transition.idempotency_key) as { semantic_json: string; effect_json: string } | undefined;
      if (idem) {
        if (idem.semantic_json !== semantic) return { kind: "semantic_conflict", record: prior } as AppendResult;
        return { kind: "replayed", record: clone(JSON.parse(idem.effect_json) as DurableControllerRecord) } as AppendResult;
      }
      if (!prior || prior.generation !== mutation.expected.generation || (mutation.expected.state && prior.state !== mutation.expected.state)) return { kind: "cas_conflict", record: prior } as AppendResult;
      if (mutation.next.delivery_id !== prior.delivery_id || mutation.next.pending_invalidation) throw new Error("invalid_controller_mutation");
      this.db.prepare("UPDATE controller_record SET generation=?,state=?,pending_invalidation=0,record_json=?,updated_at=? WHERE delivery_id=?")
        .run(mutation.next.generation, mutation.next.state, JSON.stringify(mutation.next), mutation.next.updated_at, mutation.next.delivery_id);
      this.db.prepare("INSERT INTO controller_transition(event_id,delivery_id,generation_before,generation_after,event_json) VALUES (?,?,?,?,?)")
        .run(mutation.transition.event_id, mutation.next.delivery_id, mutation.transition.generation_before, mutation.transition.generation_after, JSON.stringify(mutation.transition));
      for (const evidence of mutation.evidence ?? []) this.db.prepare("INSERT OR IGNORE INTO controller_evidence(evidence_id,delivery_id,generation,evidence_json) VALUES (?,?,?,?)").run(evidence.id, mutation.next.delivery_id, mutation.next.generation, JSON.stringify(evidence));
      for (const plan of mutation.outbox ?? []) this.db.prepare("INSERT OR IGNORE INTO controller_outbox(dedupe_key,delivery_id,generation,plan_json) VALUES (?,?,?,?)").run(plan.dedupe_key, plan.delivery_id, plan.generation, JSON.stringify(plan));
      for (const item of mutation.audit ?? []) this.appendAuditUnsafe(mutation.next.delivery_id, item.kind, item.reason, item.occurred_at);
      this.db.prepare("INSERT INTO controller_idempotency(idempotency_key,semantic_json,effect_json) VALUES (?,?,?)").run(mutation.transition.idempotency_key, semantic, JSON.stringify(mutation.next));
      return { kind: "applied", record: clone(mutation.next) } as AppendResult;
    });
    return tx();
  }

  /** A durable fence is used when a process dies before invalidation can finish. */
  beginInvalidation(deliveryId: string, expected: ExpectedRecord, pending: PendingInvalidation): AppendResult {
    const tx = this.db.transaction(() => {
      const prior = this.load(deliveryId);
      if (!prior || prior.generation !== expected.generation || (expected.state && prior.state !== expected.state)) return { kind: "cas_conflict", record: prior } as AppendResult;
      if (prior.pending_invalidation) {
        return prior.pending_invalidation.idempotency_key === pending.idempotency_key
          ? { kind: "replayed", record: prior } as AppendResult
          : { kind: "semantic_conflict", record: prior } as AppendResult;
      }
      const next = { ...prior, pending_invalidation: pending, updated_at: pending.fenced_at };
      this.db.prepare("UPDATE controller_record SET pending_invalidation=1,record_json=?,updated_at=? WHERE delivery_id=?").run(JSON.stringify(next), next.updated_at, deliveryId);
      this.appendAuditUnsafe(deliveryId, "pending_invalidation", pending.reason, pending.fenced_at);
      return { kind: "applied", record: next } as AppendResult;
    });
    return tx();
  }

  /** Recovery does not guess a new freshness: it freezes the fenced delivery. */
  recoverPendingInvalidation(deliveryId: string, occurredAt: string): DurableControllerRecord | undefined {
    const tx = this.db.transaction(() => {
      const record = this.load(deliveryId);
      if (!record?.pending_invalidation) return record;
      const next: DurableControllerRecord = { ...record, state: "awaiting_human_decision", active_task_ids: [], active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: occurredAt };
      this.db.prepare("UPDATE controller_record SET state=?,record_json=?,updated_at=? WHERE delivery_id=?").run(next.state, JSON.stringify(next), occurredAt, deliveryId);
      this.appendAuditUnsafe(deliveryId, "pending_invalidation_recovered", "fail_closed_after_restart", occurredAt);
      return next;
    });
    return tx();
  }

  appendAudit(deliveryId: string, kind: string, reason: string, occurredAt: string): void {
    this.appendAuditUnsafe(deliveryId, kind, reason, occurredAt);
  }

  claimNotification(dedupeKey: string, claimToken: string, claimedAt: string): NotificationClaim {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT plan_json,claim_token FROM controller_outbox WHERE dedupe_key=?").get(dedupeKey) as { plan_json: string; claim_token: string | null } | undefined;
      if (!row) return { kind: "missing" } as NotificationClaim;
      if (row.claim_token) return { kind: "already_claimed", plan: JSON.parse(row.plan_json) as NotificationPlan } as NotificationClaim;
      this.db.prepare("UPDATE controller_outbox SET claim_token=?,claimed_at=? WHERE dedupe_key=? AND claim_token IS NULL").run(claimToken, claimedAt, dedupeKey);
      return { kind: "claimed", plan: JSON.parse(row.plan_json) as NotificationPlan } as NotificationClaim;
    });
    return tx();
  }

  private appendAuditUnsafe(deliveryId: string, kind: string, reason: string, occurredAt: string): void {
    this.db.prepare("INSERT INTO controller_audit(delivery_id,kind,reason,occurred_at) VALUES (?,?,?,?)").run(deliveryId, kind, reason, occurredAt);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS controller_record (delivery_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL, pending_invalidation INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controller_transition (event_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, generation_before INTEGER NOT NULL, generation_after INTEGER NOT NULL, event_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controller_evidence (evidence_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, generation INTEGER NOT NULL, evidence_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controller_outbox (dedupe_key TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, generation INTEGER NOT NULL, plan_json TEXT NOT NULL, claim_token TEXT, claimed_at TEXT);
CREATE TABLE IF NOT EXISTS controller_idempotency (idempotency_key TEXT PRIMARY KEY, semantic_json TEXT NOT NULL, effect_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controller_audit (id INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS controller_transition_no_update BEFORE UPDATE ON controller_transition BEGIN SELECT RAISE(ABORT, 'controller_transition_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS controller_transition_no_delete BEFORE DELETE ON controller_transition BEGIN SELECT RAISE(ABORT, 'controller_transition_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS controller_evidence_no_update BEFORE UPDATE ON controller_evidence BEGIN SELECT RAISE(ABORT, 'controller_evidence_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS controller_evidence_no_delete BEFORE DELETE ON controller_evidence BEGIN SELECT RAISE(ABORT, 'controller_evidence_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS controller_audit_no_update BEFORE UPDATE ON controller_audit BEGIN SELECT RAISE(ABORT, 'controller_audit_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS controller_audit_no_delete BEFORE DELETE ON controller_audit BEGIN SELECT RAISE(ABORT, 'controller_audit_is_append_only'); END;
`;

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function stableJson(value: unknown): string { return JSON.stringify(value); }

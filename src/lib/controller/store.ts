/**
 * A deliberately separate, Node-only SQLite store for the delivery Controller.
 *
 * Callers must provide a concrete local path. This module never reads DB_PATH
 * and therefore cannot accidentally attach to the application's live database.
 */
import Database from "better-sqlite3";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { readyBundleHash, type ControllerRecord, type ControllerState, type Evidence, type NotificationPlan, type TransitionEvent } from "./replay.js";

const SNAPSHOT_MS = 10 * 60_000;
const EVIDENCE_MS = 24 * 60 * 60_000;

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
  /** Omitted only for append-only evidence/audit collection with no state change. */
  transition?: TransitionEvent;
  /** Required for a non-transition observation so replay semantics remain durable. */
  idempotency_key?: string;
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

/** The store never accepts an application DB path: callers supply a dedicated root. */
export interface ControllerStoreLocation {
  root_dir: string;
  file_name?: string;
}

/** The acceptance predicate is intentionally available to every reader. */
export function canAcceptEvidence(record: DurableControllerRecord): boolean {
  return !record.pending_invalidation && record.state !== "freshness_invalidated" && record.state !== "awaiting_human_decision";
}

export class ControllerStore {
  private readonly db: Database.Database;

  constructor(location: ControllerStoreLocation) {
    if (!location?.root_dir) throw new Error("controller_store_requires_explicit_isolated_root");
    const root = resolve(location.root_dir);
    const fileName = location.file_name ?? "controller.sqlite";
    if (fileName !== basename(fileName) || fileName === ":memory:") throw new Error("controller_store_rejects_escape_file_name");
    // These names deliberately make mounting a live/shared app directory a hard error.
    if (root.split(sep).some((part) => ["live", "shared", ".data", "production", "prod"].includes(part.toLowerCase()))) {
      throw new Error("controller_store_rejects_live_or_shared_root");
    }
    mkdirSync(root, { recursive: true });
    const isolatedRoot = realpathSync(root);
    const absolutePath = resolve(isolatedRoot, fileName);
    if (!absolutePath.startsWith(`${isolatedRoot}${sep}`)) throw new Error("controller_store_rejects_escape_path");
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
    validateReadyBundleAdmission(record);
    const existing = this.load(record.delivery_id);
    if (existing) return { kind: "cas_conflict", record: existing };
    this.db.prepare("INSERT INTO controller_record(delivery_id,generation,state,pending_invalidation,record_json,updated_at) VALUES (@delivery_id,@generation,@state,0,@record_json,@updated_at)")
      .run({ ...record, record_json: JSON.stringify(record) });
    return { kind: "applied", record: clone(record) };
  }

  compareAndAppend(mutation: StoreMutation): AppendResult {
    validateMutation(mutation);
    validateReadyBundleAdmission(mutation.next);
    const idempotencyKey = mutation.transition?.idempotency_key ?? mutation.idempotency_key!;
    const semantic = stableJson({ expected: mutation.expected, next: mutation.next, transition: mutation.transition, idempotency_key: idempotencyKey, evidence: mutation.evidence ?? [], outbox: mutation.outbox ?? [], audit: mutation.audit ?? [] });
    const tx = this.db.transaction(() => {
      const prior = this.load(mutation.next.delivery_id);
      const idem = this.db.prepare("SELECT semantic_json,effect_json FROM controller_idempotency WHERE idempotency_key=?").get(idempotencyKey) as { semantic_json: string; effect_json: string } | undefined;
      if (idem) {
        if (idem.semantic_json !== semantic) return { kind: "semantic_conflict", record: prior } as AppendResult;
        return { kind: "replayed", record: clone(JSON.parse(idem.effect_json) as DurableControllerRecord) } as AppendResult;
      }
      if (!prior || prior.generation !== mutation.expected.generation || (mutation.expected.state && prior.state !== mutation.expected.state)) return { kind: "cas_conflict", record: prior } as AppendResult;
      if (mutation.next.delivery_id !== prior.delivery_id || mutation.next.pending_invalidation) throw new Error("invalid_controller_mutation");
      const update = this.db.prepare("UPDATE controller_record SET generation=?,state=?,pending_invalidation=0,record_json=?,updated_at=? WHERE delivery_id=? AND generation=? AND state=?")
        .run(mutation.next.generation, mutation.next.state, JSON.stringify(mutation.next), mutation.next.updated_at, mutation.next.delivery_id, mutation.expected.generation, mutation.expected.state);
      if (update.changes !== 1) return { kind: "cas_conflict", record: this.load(mutation.next.delivery_id) } as AppendResult;
      if (mutation.transition) {
        this.db.prepare("INSERT INTO controller_transition(event_id,delivery_id,generation_before,generation_after,event_json) VALUES (?,?,?,?,?)")
          .run(mutation.transition.event_id, mutation.next.delivery_id, mutation.transition.generation_before, mutation.transition.generation_after, JSON.stringify(mutation.transition));
      }
      for (const evidence of mutation.evidence ?? []) this.insertEvidenceUnsafe(mutation.next.delivery_id, mutation.next.generation, evidence);
      this.validateEvidenceRefsUnsafe(mutation.next, mutation.transition, mutation.evidence ?? []);
      for (const plan of mutation.outbox ?? []) this.db.prepare("INSERT OR IGNORE INTO controller_outbox(dedupe_key,delivery_id,generation,plan_json) VALUES (?,?,?,?)").run(plan.dedupe_key, plan.delivery_id, plan.generation, JSON.stringify(plan));
      for (const item of mutation.audit ?? []) this.appendAuditUnsafe(mutation.next.delivery_id, item.kind, item.reason, item.occurred_at);
      this.db.prepare("INSERT INTO controller_idempotency(idempotency_key,semantic_json,effect_json) VALUES (?,?,?)").run(idempotencyKey, semantic, JSON.stringify(mutation.next));
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
      const update = this.db.prepare("UPDATE controller_record SET pending_invalidation=1,record_json=?,updated_at=? WHERE delivery_id=? AND generation=? AND state=? AND pending_invalidation=0").run(JSON.stringify(next), next.updated_at, deliveryId, expected.generation, expected.state);
      if (update.changes !== 1) return { kind: "cas_conflict", record: this.load(deliveryId) } as AppendResult;
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
      const update = this.db.prepare("UPDATE controller_outbox SET claim_token=?,claimed_at=? WHERE dedupe_key=? AND claim_token IS NULL").run(claimToken, claimedAt, dedupeKey);
      const reread = this.db.prepare("SELECT plan_json,claim_token FROM controller_outbox WHERE dedupe_key=?").get(dedupeKey) as { plan_json: string; claim_token: string | null } | undefined;
      if (!reread) return { kind: "missing" } as NotificationClaim;
      return update.changes === 1 && reread.claim_token === claimToken
        ? { kind: "claimed", plan: JSON.parse(reread.plan_json) as NotificationPlan } as NotificationClaim
        : { kind: "already_claimed", plan: JSON.parse(reread.plan_json) as NotificationPlan } as NotificationClaim;
    });
    return tx();
  }

  private appendAuditUnsafe(deliveryId: string, kind: string, reason: string, occurredAt: string): void {
    this.db.prepare("INSERT INTO controller_audit(delivery_id,kind,reason,occurred_at) VALUES (?,?,?,?)").run(deliveryId, kind, reason, occurredAt);
  }

  private insertEvidenceUnsafe(deliveryId: string, generation: number, evidence: Evidence): void {
    const existing = this.db.prepare("SELECT delivery_id,generation,evidence_json FROM controller_evidence WHERE evidence_id=?").get(evidence.id) as { delivery_id: string; generation: number; evidence_json: string } | undefined;
    if (existing) {
      if (existing.delivery_id !== deliveryId || existing.generation !== generation || existing.evidence_json !== JSON.stringify(evidence)) throw new Error("controller_evidence_identity_conflict");
      return;
    }
    this.db.prepare("INSERT INTO controller_evidence(evidence_id,delivery_id,generation,evidence_json) VALUES (?,?,?,?)").run(evidence.id, deliveryId, generation, JSON.stringify(evidence));
  }

  private validateEvidenceRefsUnsafe(next: DurableControllerRecord, transition: TransitionEvent | undefined, supplied: Evidence[]): void {
    if (!transition) return;
    for (const ref of transition.evidence_refs) {
      const suppliedMatch = supplied.some((evidence) => evidence.id === ref);
      const ledgerMatch = this.db.prepare("SELECT 1 FROM controller_evidence WHERE evidence_id=? AND delivery_id=? AND generation=?").get(ref, next.delivery_id, next.generation);
      if (!suppliedMatch && !ledgerMatch) throw new Error("controller_transition_evidence_ref_unresolvable");
    }
    if (next.ready_bundle) {
      const bundle = next.ready_bundle;
      if (bundle.hash !== readyBundleHash(bundle) || bundle.delivery_id !== next.delivery_id || bundle.generation !== next.generation || !next.current_freshness || JSON.stringify(bundle.freshness) !== JSON.stringify(next.current_freshness)) throw new Error("controller_ready_bundle_invalid");
      for (const [ref, receipt, kind, conclusion] of [[bundle.snapshot_evidence_ref, bundle.snapshot_evidence, "snapshot", undefined], [bundle.ci_evidence_ref, bundle.ci_evidence, "ci", "passed"], [bundle.review_evidence_ref, bundle.review_evidence, "review", "approved"]] as const) {
        const evidence = next.evidence.find((candidate) => candidate.id === ref && candidate.status === "active");
        if (!evidence || evidence.kind !== kind || evidence.source !== receipt.source || evidence.immutable_ref !== receipt.immutable_ref || evidence.payload_hash !== receipt.payload_hash || evidence.observed_at !== receipt.observed_at || evidence.conclusion !== conclusion || JSON.stringify(evidence.freshness) !== JSON.stringify(bundle.freshness)) throw new Error("controller_ready_bundle_evidence_missing");
      }
    }
  }
}

function validateReadyBundleAdmission(record: DurableControllerRecord): void {
  const bundle = record.ready_bundle;
  if (!bundle) return;
  const now = timestamp(record.updated_at);
  if (!Number.isFinite(now) || record.state !== "ready_for_human_review" || !record.current_freshness || record.current_freshness.merge_state_status !== "clean" || bundle.hash !== readyBundleHash(bundle) || bundle.delivery_id !== record.delivery_id || bundle.generation !== record.generation || !sameFreshness(bundle.freshness, record.current_freshness) || !isNonFutureTimestamp(bundle.admitted_at, now)) throw new Error("controller_ready_bundle_invalid");
  for (const [ref, receipt, kind, conclusion, ttl] of [[bundle.snapshot_evidence_ref, bundle.snapshot_evidence, "snapshot", undefined, SNAPSHOT_MS], [bundle.ci_evidence_ref, bundle.ci_evidence, "ci", "passed", EVIDENCE_MS], [bundle.review_evidence_ref, bundle.review_evidence, "review", "approved", EVIDENCE_MS]] as const) {
    const evidence = record.evidence.find((candidate) => candidate.id === ref && candidate.status === "active");
    if (!evidence || evidence.expired || receipt.id !== ref || evidence.kind !== kind || evidence.source !== receipt.source || evidence.immutable_ref !== receipt.immutable_ref || evidence.payload_hash !== receipt.payload_hash || evidence.observed_at !== receipt.observed_at || evidence.conclusion !== conclusion || !sameFreshness(evidence.freshness, bundle.freshness) || !sameFreshness(receipt.freshness, bundle.freshness) || !isTimestampWithinTtl(evidence.observed_at, now, ttl) || !isTimestampWithinTtl(receipt.observed_at, now, ttl)) throw new Error("controller_ready_bundle_evidence_missing");
  }
}

function sameFreshness(left: Evidence["freshness"] | undefined, right: Evidence["freshness"] | undefined): boolean {
  return Boolean(left && right && left.head_sha === right.head_sha && left.base_sha === right.base_sha && left.merge_state_status === right.merge_state_status);
}
function timestamp(value: string): number { return Date.parse(value); }
function isNonFutureTimestamp(value: string, now: number): boolean { const observed = timestamp(value); return Number.isFinite(observed) && observed <= now; }
function isTimestampWithinTtl(value: string, now: number, ttl: number): boolean { const observed = timestamp(value); return Number.isFinite(observed) && observed <= now && now - observed <= ttl; }

const ALLOWED_EDGES: Readonly<Record<ControllerState, readonly ControllerState[]>> = {
  intake: ["admitted", "awaiting_human_decision"],
  admitted: ["waiting_for_runtime", "awaiting_human_decision"],
  waiting_for_runtime: ["leased", "awaiting_human_decision", "freshness_invalidated"],
  leased: ["executing", "waiting_for_runtime", "freshness_invalidated", "awaiting_human_decision"],
  executing: ["evidence_collecting", "repairing", "waiting_for_runtime", "awaiting_human_decision", "freshness_invalidated"],
  evidence_collecting: ["ready_for_human_review", "freshness_invalidated", "repairing", "awaiting_human_decision"],
  freshness_invalidated: ["evidence_collecting", "repairing", "awaiting_human_decision"],
  repairing: ["waiting_for_runtime", "evidence_collecting", "awaiting_human_decision", "freshness_invalidated"],
  ready_for_human_review: ["freshness_invalidated", "awaiting_human_decision", "cancelled"],
  awaiting_human_decision: [],
  cancelled: [],
};

function validateMutation(mutation: StoreMutation): void {
  const transition = mutation.transition;
  if (!mutation.expected.state) throw new Error("invalid_controller_mutation:expected_state_required");
  if (mutation.next.pending_invalidation) throw new Error("invalid_controller_mutation:pending_invalidation_not_appendable");
  if (!transition) {
    if (!mutation.idempotency_key || mutation.outbox?.length || (mutation.evidence?.length ?? 0) === 0) throw new Error("invalid_controller_mutation:observation_envelope_incomplete");
    if (mutation.next.generation !== mutation.expected.generation || mutation.next.state !== mutation.expected.state) throw new Error("invalid_controller_mutation:observation_must_not_change_state_or_generation");
    return;
  }
  if (mutation.idempotency_key) throw new Error("invalid_controller_mutation:duplicate_idempotency_source");
  if (!transition.event_id || !transition.causal_event_id || !transition.writer || !transition.occurred_at || !transition.idempotency_key || !transition.precondition || !transition.recovery_action || transition.evidence_refs.length === 0) throw new Error("invalid_controller_mutation:transition_envelope_incomplete");
  if (transition.delivery_id !== mutation.next.delivery_id) throw new Error("invalid_controller_mutation:delivery_mismatch");
  if (transition.generation_before !== mutation.expected.generation || transition.generation_after !== mutation.next.generation) throw new Error("invalid_controller_mutation:generation_mismatch");
  if (transition.from_state !== mutation.expected.state || transition.to_state !== mutation.next.state) throw new Error("invalid_controller_mutation:state_envelope_mismatch");
  if (transition.from_state === transition.to_state) throw new Error("invalid_controller_mutation:homomorphic_transition_forbidden");
  if (!ALLOWED_EDGES[transition.from_state].includes(transition.to_state)) throw new Error("invalid_controller_mutation:transition_not_allowed");
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

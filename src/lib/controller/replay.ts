/**
 * Local-only controller model used to replay the reliability specification.
 * It deliberately has no adapters: a replay can plan notifications, but cannot
 * send them or create tasks, leases, PRs, CI runs, deployments, or resources.
 */

export type ControllerState =
  | "intake" | "admitted" | "waiting_for_runtime" | "leased" | "executing"
  | "evidence_collecting" | "freshness_invalidated" | "repairing"
  | "ready_for_human_review" | "awaiting_human_decision" | "cancelled";

export interface Freshness {
  head_sha: string;
  base_sha: string;
  merge_state_status: string;
}

export interface Evidence {
  id: string;
  kind: "result" | "ci" | "review" | "snapshot";
  /** Fixture source; a production adapter would name its authoritative provider. */
  source: string;
  /** Immutable provider ID or URL for this evidence receipt. */
  immutable_ref: string;
  /** Stable hash of the desensitized evidence payload. */
  payload_hash: string;
  freshness?: Freshness;
  status: "active" | "superseded";
  conclusion?: "passed" | "failed" | "approved";
  /** Derived solely from the fixture replay clock, never supplied by an event. */
  expired?: boolean;
  observed_at: string;
}

/** Immutable evidence fields pinned into a ready bundle for later verification. */
export interface EvidenceReceipt {
  readonly id: string;
  readonly source: string;
  readonly immutable_ref: string;
  readonly payload_hash: string;
  readonly observed_at: string;
  readonly freshness?: Readonly<Freshness>;
  readonly conclusion?: Evidence["conclusion"];
}

export interface TransitionEvent {
  event_id: string;
  /** The input event that caused this (possibly derived) transition record. */
  causal_event_id: string;
  delivery_id: string;
  generation_before: number;
  generation_after: number;
  from_state: ControllerState;
  to_state: ControllerState;
  /** Replay-model writer provenance, never a claim that an external authorization ran. */
  writer: string;
  occurred_at: string;
  idempotency_key: string;
  precondition: string;
  evidence_refs: string[];
  recovery_action: string;
}

export interface NotificationPlan {
  /** This is a plan only; no recipient, channel, or provider request is represented. */
  dedupe_key: string;
  signal: "offline" | "reconnect" | "invalidation" | "repair_exhausted" | "ready" | "human_escalation";
  occurred_at: string;
  causal_event_id: string;
  delivery_id: string;
  generation: number;
  retry: {
    idempotency_key: string;
    backoff_minutes: readonly [5, 15];
    max_attempts: 3;
    external_delivery: false;
  };
  audit_fields: Readonly<Record<string, string | number>>;
}

/** Immutable evidence receipt admitted with ready_for_human_review. */
export interface ReadyBundle {
  readonly hash: string;
  readonly delivery_id: string;
  readonly generation: number;
  readonly freshness: Readonly<Freshness>;
  readonly snapshot_evidence_ref: string;
  readonly ci_evidence_ref: string;
  readonly review_evidence_ref: string;
  readonly snapshot_evidence: EvidenceReceipt;
  readonly ci_evidence: EvidenceReceipt;
  readonly review_evidence: EvidenceReceipt;
  readonly admitted_at: string;
}

/** The three independently admissible evidence receipts pinned into a ready bundle. */
interface ReadyBundleEvidence {
  snapshot: Evidence;
  ci: Evidence;
  review: Evidence;
}

export interface AuditEntry {
  event_id: string;
  kind: "invalid_transition" | "stale_event" | "replayed_event" | "ready_bundle_invalidated";
  reason: string;
}

export interface ControllerRecord {
  delivery_id: string;
  state: ControllerState;
  generation: number;
  attempt_count: number;
  started_count: number;
  repair_round: number;
  active_task_ids: string[];
  active_lease_id?: string;
  active_runtime_id?: string;
  active_runtime_identity?: string;
  active_lease_expires_at?: string;
  active_lease_fencing_token?: string;
  last_heartbeat_at?: string;
  consecutive_lease_losses: number;
  offline_incident_id?: string;
  offline_started_at?: string;
  checkpoint_ref?: string;
  current_freshness?: Freshness;
  evidence: Evidence[];
  /** Present only while its evidence is still admissible. */
  ready_bundle?: ReadyBundle;
  /** Immutable receipts retained after a freshness invalidation. */
  superseded_ready_bundles: ReadyBundle[];
  transitions: TransitionEvent[];
  notifications: NotificationPlan[];
  audit: AuditEntry[];
}

export type ReplayEventKind =
  | "admit" | "queue" | "lease_confirmed" | "started" | "lease_expired"
  | "result" | "snapshot" | "ci" | "review" | "evaluate_ready"
  | "repair_dispatch" | "runtime_offline" | "task_inventory" | "freshness_recheck"
  | "human_boundary";

export type HumanBoundary = "conflict" | "permission_or_credential" | "production_request";

export interface ReplayInputEvent {
  event_id: string;
  /** Optional in fixture rows because the JSONL header supplies the envelope. */
  delivery_id?: string;
  kind: ReplayEventKind;
  occurred_at: string;
  evidence_refs: string[];
  /** Required fencing token; events without it are stale rather than actionable. */
  expected_generation: number;
  /** Provenance label emitted by the fixture/model; it is not an authorization assertion. */
  writer?: string;
  lease_id?: string;
  runtime_id?: string;
  /** Stable runtime identity required in addition to the runtime label. */
  runtime_identity?: string;
  lease_expires_at?: string;
  lease_fencing_token?: string;
  /** Authoritative heartbeat observation used only by this fixed-clock model. */
  heartbeat_at?: string;
  boundary?: HumanBoundary;
  task_id?: string;
  checkpoint_ref?: string;
  result?: "completed" | "failed";
  freshness?: Freshness;
  conclusion?: "passed" | "failed" | "approved";
  expired?: boolean;
  active_task_ids?: string[];
}

export interface ReplayFixture {
  kind: "fixture";
  delivery_id: string;
  clock: string;
  state?: ControllerState;
  generation?: number;
  active_lease_id?: string;
  active_runtime_id?: string;
  active_runtime_identity?: string;
  active_lease_expires_at?: string;
  active_lease_fencing_token?: string;
  last_heartbeat_at?: string;
  consecutive_lease_losses?: number;
  current_freshness?: Freshness;
  evidence?: Evidence[];
  ready_bundle?: ReadyBundle;
}

export interface ReplayResult {
  record: ControllerRecord;
  state_sequence: ControllerState[];
  audit_hash: string;
  invariants: { ok: boolean; failures: string[]; external_effects: false };
}

const ACTIVE_STATES = new Set<ControllerState>(["waiting_for_runtime", "leased", "executing", "evidence_collecting", "freshness_invalidated", "repairing"]);
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export function createControllerRecord(input: Pick<ReplayFixture, "delivery_id" | "state" | "generation" | "active_lease_id" | "active_runtime_id" | "active_runtime_identity" | "active_lease_expires_at" | "active_lease_fencing_token" | "last_heartbeat_at" | "consecutive_lease_losses" | "current_freshness" | "evidence" | "ready_bundle">): ControllerRecord {
  return {
    delivery_id: input.delivery_id,
    state: input.state ?? "intake",
    generation: input.generation ?? 0,
    attempt_count: 0,
    started_count: 0,
    repair_round: 0,
    active_task_ids: [],
    active_lease_id: input.active_lease_id,
    active_runtime_id: input.active_runtime_id,
    active_runtime_identity: input.active_runtime_identity,
    active_lease_expires_at: input.active_lease_expires_at,
    active_lease_fencing_token: input.active_lease_fencing_token,
    last_heartbeat_at: input.last_heartbeat_at,
    consecutive_lease_losses: input.consecutive_lease_losses ?? 0,
    current_freshness: input.current_freshness && { ...input.current_freshness },
    evidence: input.evidence?.map((evidence) => ({ ...evidence, freshness: evidence.freshness && { ...evidence.freshness } })) ?? [],
    ready_bundle: input.ready_bundle && cloneReadyBundle(input.ready_bundle),
    superseded_ready_bundles: [],
    transitions: [],
    notifications: [],
    audit: [],
  };
}

export function replay(events: ReplayInputEvent[], fixture: ReplayFixture): ReplayResult {
  const record = createControllerRecord(fixture);
  const seen = new Set<string>();
  const notificationKeys = new Set<string>();
  const states = [record.state];
  const clock = parseTimestamp(fixture.clock);

  for (const event of events) {
    if (seen.has(event.event_id)) {
      record.audit.push({ event_id: event.event_id, kind: "replayed_event", reason: "event_id_already_applied" });
      continue;
    }
    seen.add(event.event_id);
    if (clock === undefined) {
      invalid(record, event, "fixture_clock_invalid");
      continue;
    }
    const occurredAt = parseTimestamp(event.occurred_at);
    if (occurredAt === undefined) {
      invalid(record, event, "event_timestamp_invalid");
      continue;
    }
    if (occurredAt > clock) {
      invalid(record, event, "event_timestamp_after_fixture_clock");
      continue;
    }
    if (event.delivery_id && event.delivery_id !== record.delivery_id) {
      record.audit.push({ event_id: event.event_id, kind: "stale_event", reason: "delivery_id_mismatch" });
      continue;
    }
    if (event.expected_generation === undefined) {
      record.audit.push({ event_id: event.event_id, kind: "stale_event", reason: "generation_missing" });
      continue;
    }
    if (event.expected_generation !== record.generation) {
      record.audit.push({ event_id: event.event_id, kind: "stale_event", reason: "generation_mismatch" });
      continue;
    }
    reduce(record, event, states, notificationKeys, clock);
  }

  const failures: string[] = [];
  for (const transition of record.transitions) {
    if (!transition.precondition || !transition.idempotency_key || !transition.recovery_action || transition.evidence_refs.length === 0) {
      failures.push(`transition_envelope_incomplete:${transition.event_id}`);
    }
  }
  if (record.active_task_ids.length > 1) failures.push("multiple_active_tasks");
  return {
    record,
    state_sequence: states,
    audit_hash: fnv1a(JSON.stringify({ transitions: record.transitions, audit: record.audit, notifications: record.notifications })),
    invariants: { ok: failures.length === 0, failures, external_effects: false },
  };
}

function reduce(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (event.evidence_refs.length === 0) return invalid(record, event, "missing_evidence");
  switch (event.kind) {
    case "admit":
      transition(record, event, "admitted", states, "authorization_and_scope_valid", "read_latest_record_no_task_creation");
      return;
    case "queue":
      if (!transition(record, event, "waiting_for_runtime", states, "executable_plan_and_allowed_scope", "retry_same_task_idempotency_key")) return;
      record.active_task_ids = [event.task_id ?? `work:${record.generation}`];
      return;
    case "lease_confirmed":
      if (record.active_task_ids.length !== 1 || !event.lease_id || !event.runtime_id || !event.lease_expires_at) return invalid(record, event, "lease_requires_exactly_one_task_runtime_and_expiry");
      if (!leaseExpiryValid(event, event.lease_expires_at)) return invalid(record, event, "lease_expiry_invalid_or_not_after_confirmation");
      if (!event.runtime_identity || !event.lease_fencing_token || !heartbeatFreshAt(event)) return invalid(record, event, "heartbeat_missing_or_older_than_90_seconds_or_lease_envelope_incomplete");
      if (!transition(record, event, "leased", states, "fresh_heartbeat_and_confirmed_fenced_lease", "new_lease_required_after_expiry")) return;
      record.active_lease_id = event.lease_id;
      record.active_runtime_id = event.runtime_id;
      record.active_runtime_identity = event.runtime_identity;
      record.active_lease_expires_at = event.lease_expires_at;
      record.active_lease_fencing_token = event.lease_fencing_token;
      record.last_heartbeat_at = event.heartbeat_at;
      notify(record, event, notificationKeys, "reconnect", `${record.delivery_id}:${record.generation}:reconnect:${event.event_id}`);
      record.offline_incident_id = undefined;
      record.offline_started_at = undefined;
      return;
    case "started":
      if (!matchingLeaseFence(record, event)) return;
      if (!heartbeatFreshForLeaseEvent(record, event)) return invalid(record, event, "heartbeat_missing_stale_or_reversed");
      if (!leaseStillValidAt(record, clock)) return stale(record, event, "lease_expired");
      if (!transition(record, event, "executing", states, "matching_unexpired_fenced_start_receipt", "lease_expiry_returns_to_waiting_without_attempt")) return;
      record.started_count += 1;
      record.last_heartbeat_at = heartbeatSource(record, event);
      return;
    case "lease_expired":
      if (!matchingLeaseFence(record, event)) return;
      if (!heartbeatFreshForLeaseEvent(record, event)) return invalid(record, event, "heartbeat_missing_stale_or_reversed");
      if (!leaseExpiredAt(record, clock)) return invalid(record, event, "lease_not_expired");
      if (!transition(record, event, "waiting_for_runtime", states, "matching_lease_expired_without_terminal_result", "preserve_checkpoint_and_reacquire_new_lease")) return;
      clearActiveLease(record);
      record.checkpoint_ref = event.checkpoint_ref ?? record.checkpoint_ref;
      record.consecutive_lease_losses += 1;
      if (record.consecutive_lease_losses >= 3 && transition(record, event, "awaiting_human_decision", states, "three_consecutive_lease_losses", "freeze_work_and_require_human_decision", false, "escalate:three_consecutive_lease_losses", `${event.event_id}:human_escalation`)) {
        record.active_task_ids = [];
        notify(record, event, notificationKeys, "human_escalation", `${record.delivery_id}:${record.generation}:human_escalation:three_consecutive_lease_losses`, humanEscalationAuditFields(record, event, "three_consecutive_lease_losses"));
      }
      return;
    case "result":
      return applyResult(record, event, states, notificationKeys, clock);
    case "snapshot":
      return applySnapshot(record, event, states, notificationKeys, clock);
    case "ci":
      return addFreshEvidence(record, event, "ci", clock);
    case "review":
      return addFreshEvidence(record, event, "review", clock);
    case "evaluate_ready": {
      const bundleEvidence = readyBundleEvidence(record, clock);
      if (!bundleEvidence) return invalid(record, event, "active_unexpired_matching_snapshot_and_fresh_clean_passing_ci_and_approved_review_required");
      const bundle = createReadyBundle(record, bundleEvidence, event.occurred_at);
      const freshness = record.current_freshness!;
      const readyKey = `${record.delivery_id}:${record.generation}:ready:${freshnessHash(freshness)}:${bundle.hash}`;
      if (transition(record, event, "ready_for_human_review", states, "current_freshness_and_matching_unexpired_evidence", "recheck_freshness_before_any_human_acceptance", false, `ready:${freshnessHash(freshness)}:${bundle.hash}`)) {
        record.ready_bundle = bundle;
        notify(record, event, notificationKeys, "ready", readyKey, {
          freshness: freshnessAuditValue(freshness),
          evidence_bundle_id: bundle.hash,
          acceptance_result: "ready_for_human_review",
        });
      }
      return;
    }
    case "repair_dispatch":
      if (record.repair_round >= 2) {
        if (transition(record, event, "awaiting_human_decision", states, "repair_budget_exhausted", "stop_automation_and_wait_for_human")) {
          notify(record, event, notificationKeys, "repair_exhausted", `${record.delivery_id}:${record.generation}:repair_exhausted:${event.event_id}`, repairAuditFields(record, event, "repair_budget_exhausted", "wait_for_human_decision"));
        }
        return;
      }
      if (transition(record, event, "waiting_for_runtime", states, "repair_round_below_two_and_no_active_repair", "dispatch_one_idempotent_repair_task")) {
        record.repair_round += 1;
        record.active_task_ids = [event.task_id ?? `repair:${record.repair_round}`];
      }
      return;
    case "runtime_offline":
      return applyOffline(record, event, states, notificationKeys);
    case "task_inventory":
      if ((event.active_task_ids?.length ?? 0) <= 1) return;
      if (transition(record, event, "awaiting_human_decision", states, "multiple_active_tasks_detected", "freeze_and_require_human_decision")) {
        record.active_task_ids = [...(event.active_task_ids ?? [])];
      }
      return;
    case "freshness_recheck":
      return recheckReadyEvidence(record, event, states, notificationKeys, clock);
    case "human_boundary":
      return applyHumanBoundary(record, event, states, notificationKeys);
  }
}

function applyResult(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (!matchingLeaseFence(record, event)) return;
  if (!heartbeatFreshForLeaseEvent(record, event)) return invalid(record, event, "heartbeat_missing_stale_or_reversed");
  if (!leaseStillValidAt(record, clock)) return stale(record, event, "lease_expired");
  if (!event.result) return invalid(record, event, "terminal_result_required");
  const to = event.result === "completed" ? "evidence_collecting" : record.repair_round < 2 ? "repairing" : "awaiting_human_decision";
  if (!transition(record, event, to, states, "matching_fenced_terminal_result", "record_terminal_result_once_and_never_reuse_lease")) return;
  record.attempt_count += 1;
  record.last_heartbeat_at = heartbeatSource(record, event);
  clearActiveLease(record);
  record.active_task_ids = [];
  record.consecutive_lease_losses = 0;
  // Result freshness is correlation evidence only. An authoritative snapshot is
  // the sole source allowed to establish current_freshness.
  record.evidence.push(evidenceFromEvent(event, "result", clock, event.freshness ? normalizeFreshness(event.freshness) : undefined, event.result === "completed" ? "passed" : "failed"));
  if (to === "awaiting_human_decision") notify(record, event, notificationKeys, "repair_exhausted", `${record.delivery_id}:${record.generation}:repair_exhausted:${event.event_id}`, repairAuditFields(record, event, "terminal_failure_after_repair_budget", "wait_for_human_decision"));
}

function applySnapshot(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (!event.freshness) {
    // A snapshot without F cannot prove that the ready bundle is still for the
    // current PR. Revoke any active generation before recording the rejected
    // observation; never leave prior acceptance evidence actionable.
    if (record.state !== "freshness_invalidated" && canInvalidateFreshness(record) && (record.current_freshness || record.ready_bundle)) {
      invalidateFreshness(record, event, undefined, states, notificationKeys, "freshness_unknown");
    }
    return invalid(record, event, "freshness_required");
  }
  const freshness = normalizeFreshness(event.freshness);
  if (evidenceExpired(event, clock, "snapshot")) {
    // Keep the supplied snapshot reference as rejected evidence so the
    // fail-closed decision remains independently auditable.
    const rejected = evidenceFromEvent(event, "snapshot", clock, freshness);
    rejected.status = "superseded";
    record.evidence.push(rejected);
    if (canInvalidateFreshness(record) && (record.current_freshness || record.ready_bundle)) {
      // An expired snapshot cannot establish a replacement authoritative F.
      invalidateFreshness(record, event, undefined, states, notificationKeys, "authoritative_snapshot_expired");
    }
    return invalid(record, event, "authoritative_snapshot_expired");
  }
  if (record.state === "freshness_invalidated") {
    // The invalidated generation can only recover from a newly observed clean
    // authoritative snapshot. Supersede the failed/unknown F observation too,
    // so a later ready bundle can only see evidence for the replacement F.
    const priorFreshness = record.current_freshness;
    if (priorFreshness) {
      record.evidence.forEach((evidence) => {
        if (evidence.freshness && sameFreshness(evidence.freshness, priorFreshness)) evidence.status = "superseded";
      });
    }
    record.current_freshness = freshness;
    record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
    if (freshness.merge_state_status === "clean") {
      transition(record, event, "evidence_collecting", states, "authoritative_new_generation_snapshot", "collect_new_ci_and_review_evidence", false, `refresh:${freshnessHash(freshness)}`);
    }
    return;
  }
  if (!record.current_freshness) {
    record.current_freshness = freshness;
    record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
    return;
  }
  if (sameFreshness(record.current_freshness, freshness)) return;
  if (!canInvalidateFreshness(record)) return invalid(record, event, "freshness_change_from_non_active_state");
  invalidateFreshness(record, event, freshness, states, notificationKeys, "authoritative_freshness_changed_or_unknown", clock);
}

function canInvalidateFreshness(record: ControllerRecord): boolean {
  return record.state !== "freshness_invalidated" && (ACTIVE_STATES.has(record.state) || record.state === "ready_for_human_review");
}

function invalidateFreshness(record: ControllerRecord, event: ReplayInputEvent, freshness: Freshness | undefined, states: ControllerState[], notificationKeys: Set<string>, reason: string, clock?: number): void {
  const oldFreshness = record.current_freshness;
  const oldHash = oldFreshness ? freshnessHash(oldFreshness) : "freshness_unknown";
  const oldBundle = record.ready_bundle;
  if (!transition(record, event, "freshness_invalidated", states, reason, "supersede_old_evidence_and_collect_new_generation", true, `invalidate:${oldHash}:${reason}`)) return;
  record.evidence.forEach((evidence) => {
    if (evidence.freshness && (!oldFreshness || sameFreshness(evidence.freshness, oldFreshness))) evidence.status = "superseded";
  });
  if (oldBundle) {
    record.superseded_ready_bundles.push(oldBundle);
    record.ready_bundle = undefined;
    record.audit.push({ event_id: event.event_id, kind: "ready_bundle_invalidated", reason: `${reason}:${oldBundle.hash}` });
  }
  record.current_freshness = freshness;
  clearActiveLease(record);
  record.active_task_ids = [];
  if (clock !== undefined && freshness) record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
  notify(record, event, notificationKeys, "invalidation", `${record.delivery_id}:${record.generation}:invalidation:${oldHash}:${reason}`, {
    old_freshness: freshnessAuditValue(oldFreshness),
    new_freshness: freshnessAuditValue(freshness),
    trigger_field: invalidationTrigger(oldFreshness, freshness, reason),
    superseded_evidence_ids: record.evidence.filter((evidence) => evidence.status === "superseded").map((evidence) => evidence.id).join(",") || "none",
    snapshot_id: event.evidence_refs[0] ?? "none",
  });
}

function recheckReadyEvidence(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (record.state !== "ready_for_human_review" || !record.ready_bundle || !record.current_freshness) {
    return invalid(record, event, "ready_bundle_and_current_freshness_required_for_recheck");
  }
  const bundle = record.ready_bundle;
  if (!readyBundleVerifiable(record, bundle)) {
    invalidateFreshness(record, event, undefined, states, notificationKeys, "ready_bundle_unverifiable");
    return;
  }
  const snapshotExpired = !isTimestampWithinTtl(bundle.snapshot_evidence.observed_at, clock, SNAPSHOT_TTL_MS);
  const ciExpired = !isTimestampWithinTtl(bundle.ci_evidence.observed_at, clock, EVIDENCE_TTL_MS);
  const reviewExpired = !isTimestampWithinTtl(bundle.review_evidence.observed_at, clock, EVIDENCE_TTL_MS);
  if (snapshotExpired || ciExpired || reviewExpired) {
    invalidateFreshness(record, event, undefined, states, notificationKeys, "ready_evidence_expired");
  }
}

function addFreshEvidence(record: ControllerRecord, event: ReplayInputEvent, kind: "ci" | "review", clock: number): void {
  if (record.state !== "evidence_collecting") return invalid(record, event, "evidence_only_while_collecting");
  if (!event.freshness || !record.current_freshness || !sameFreshness(normalizeFreshness(event.freshness), record.current_freshness)) {
    return stale(record, event, "evidence_freshness_mismatch");
  }
  if (kind === "ci" && event.conclusion !== "passed" && event.conclusion !== "failed") return invalid(record, event, "ci_conclusion_required");
  if (kind === "review" && event.conclusion !== "approved") return invalid(record, event, "approved_review_required");
  record.evidence.push(evidenceFromEvent(event, kind, clock, normalizeFreshness(event.freshness), event.conclusion));
}

function applyOffline(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>): void {
  if (record.state !== "waiting_for_runtime") return invalid(record, event, "offline_only_while_waiting_for_runtime");
  record.offline_incident_id ??= event.event_id;
  record.offline_started_at ??= event.occurred_at;
  const elapsed = Date.parse(event.occurred_at) - Date.parse(record.offline_started_at);
  if (Number.isNaN(elapsed)) return invalid(record, event, "offline_timestamp_invalid");
  const bucket = Math.floor(elapsed / (30 * 60 * 1000));
  notify(record, event, notificationKeys, "offline", `${record.delivery_id}:${record.generation}:offline:${record.offline_incident_id}:${bucket}`);
  if (bucket >= 1 && transition(record, event, "awaiting_human_decision", states, "offline_for_at_least_30_minutes", "revoke_queued_work_and_wait_for_human")) {
    record.active_task_ids = [];
  }
}

function applyHumanBoundary(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>): void {
  if (!isHumanBoundary(event.boundary)) return invalid(record, event, "human_boundary_kind_required");
  if (!transition(record, event, "awaiting_human_decision", states, `fail_closed_${event.boundary}`, "perform_no_external_operation_and_wait_for_human", false, `escalate:${event.boundary}`)) return;
  record.active_task_ids = [];
  clearActiveLease(record);
  notify(record, event, notificationKeys, "human_escalation", `${record.delivery_id}:${record.generation}:human_escalation:${event.boundary}`, humanEscalationAuditFields(record, event, event.boundary));
}

function isHumanBoundary(value: string | undefined): value is HumanBoundary {
  return value === "conflict" || value === "permission_or_credential" || value === "production_request";
}

function clearActiveLease(record: ControllerRecord): void {
  record.active_lease_id = undefined;
  record.active_runtime_id = undefined;
  record.active_runtime_identity = undefined;
  record.active_lease_expires_at = undefined;
  record.active_lease_fencing_token = undefined;
  record.last_heartbeat_at = undefined;
}

function transition(record: ControllerRecord, event: ReplayInputEvent, to: ControllerState, states: ControllerState[], precondition: string, recovery: string, incrementGeneration = false, transitionKey = `transition:${event.event_id}`, transitionEventId = event.event_id): boolean {
  if (!allowed(record.state, to)) {
    invalid(record, event, `transition_not_allowed:${record.state}:${to}`);
    return false;
  }
  const before = record.generation;
  const from = record.state;
  record.generation += incrementGeneration ? 1 : 0;
  record.state = to;
  record.transitions.push({
    event_id: transitionEventId,
    causal_event_id: event.event_id,
    delivery_id: record.delivery_id,
    generation_before: before,
    generation_after: record.generation,
    from_state: from,
    to_state: to,
    writer: event.writer ?? "replay:model",
    occurred_at: event.occurred_at,
    idempotency_key: `${record.delivery_id}:${before}:${transitionKey}`,
    precondition,
    evidence_refs: [...event.evidence_refs],
    recovery_action: recovery,
  });
  states.push(to);
  return true;
}

function allowed(from: ControllerState, to: ControllerState): boolean {
  const edges: Partial<Record<ControllerState, ControllerState[]>> = {
    intake: ["admitted", "awaiting_human_decision"],
    admitted: ["waiting_for_runtime", "awaiting_human_decision"],
    waiting_for_runtime: ["leased", "awaiting_human_decision", "freshness_invalidated"],
    leased: ["executing", "waiting_for_runtime", "freshness_invalidated"],
    executing: ["evidence_collecting", "repairing", "waiting_for_runtime", "awaiting_human_decision", "freshness_invalidated"],
    evidence_collecting: ["ready_for_human_review", "freshness_invalidated", "repairing", "awaiting_human_decision"],
    freshness_invalidated: ["evidence_collecting", "repairing", "awaiting_human_decision"],
    repairing: ["waiting_for_runtime", "evidence_collecting", "awaiting_human_decision", "freshness_invalidated"],
    ready_for_human_review: ["freshness_invalidated", "awaiting_human_decision", "cancelled"],
  };
  return edges[from]?.includes(to) ?? false;
}

function readyBundleEvidence(record: ControllerRecord, clock: number): ReadyBundleEvidence | undefined {
  const freshness = record.current_freshness;
  if (!freshness || freshness.merge_state_status !== "clean") return undefined;
  const snapshot = record.evidence.find((e) => e.kind === "snapshot" && e.status === "active" && !e.expired && isTimestampWithinTtl(e.observed_at, clock, SNAPSHOT_TTL_MS) && sameFreshness(e.freshness, freshness));
  const ci = record.evidence.find((e) => e.kind === "ci" && e.status === "active" && e.conclusion === "passed" && !e.expired && isTimestampWithinTtl(e.observed_at, clock, EVIDENCE_TTL_MS) && sameFreshness(e.freshness, freshness));
  const review = record.evidence.find((e) => e.kind === "review" && e.status === "active" && e.conclusion === "approved" && !e.expired && isTimestampWithinTtl(e.observed_at, clock, EVIDENCE_TTL_MS) && sameFreshness(e.freshness, freshness));
  return snapshot && ci && review ? { snapshot, ci, review } : undefined;
}

function createReadyBundle(record: ControllerRecord, evidence: ReadyBundleEvidence, admittedAt: string): ReadyBundle {
  const freshness = record.current_freshness!;
  const fields = {
    delivery_id: record.delivery_id,
    generation: record.generation,
    freshness: { ...freshness },
    snapshot_evidence_ref: evidence.snapshot.id,
    ci_evidence_ref: evidence.ci.id,
    review_evidence_ref: evidence.review.id,
    snapshot_evidence: evidenceReceipt(evidence.snapshot),
    ci_evidence: evidenceReceipt(evidence.ci),
    review_evidence: evidenceReceipt(evidence.review),
    admitted_at: admittedAt,
  };
  return { ...fields, hash: fnv1a(JSON.stringify(fields)) };
}

function readyBundleVerifiable(record: ControllerRecord, bundle: ReadyBundle): boolean {
  if (bundle.hash !== readyBundleHash(bundle)) return false;
  if (bundle.delivery_id !== record.delivery_id || bundle.generation !== record.generation || !sameFreshness(bundle.freshness, record.current_freshness)) return false;
  if (bundle.snapshot_evidence_ref !== bundle.snapshot_evidence.id || bundle.ci_evidence_ref !== bundle.ci_evidence.id || bundle.review_evidence_ref !== bundle.review_evidence.id) return false;
  return receiptMatchesActiveEvidence(record, bundle.snapshot_evidence, "snapshot", bundle.freshness, undefined)
    && receiptMatchesActiveEvidence(record, bundle.ci_evidence, "ci", bundle.freshness, "passed")
    && receiptMatchesActiveEvidence(record, bundle.review_evidence, "review", bundle.freshness, "approved");
}

export function readyBundleHash(bundle: ReadyBundle): string {
  const { hash: _hash, ...fields } = bundle;
  return fnv1a(JSON.stringify(fields));
}

function receiptMatchesActiveEvidence(record: ControllerRecord, receipt: EvidenceReceipt, kind: Evidence["kind"], freshness: Freshness, conclusion: Evidence["conclusion"] | undefined): boolean {
  if (!sameFreshness(receipt.freshness, freshness) || receipt.conclusion !== conclusion) return false;
  const evidence = record.evidence.find((candidate) => candidate.id === receipt.id && candidate.kind === kind && candidate.status === "active");
  return Boolean(evidence
    && evidence.source === receipt.source
    && evidence.immutable_ref === receipt.immutable_ref
    && evidence.payload_hash === receipt.payload_hash
    && evidence.observed_at === receipt.observed_at
    && sameFreshness(evidence.freshness, freshness)
    && evidence.conclusion === conclusion
    && !evidence.expired);
}

function evidenceReceipt(evidence: Evidence): EvidenceReceipt {
  return {
    id: evidence.id,
    source: evidence.source,
    immutable_ref: evidence.immutable_ref,
    payload_hash: evidence.payload_hash,
    observed_at: evidence.observed_at,
    freshness: evidence.freshness && { ...evidence.freshness },
    conclusion: evidence.conclusion,
  };
}

function cloneReadyBundle(bundle: ReadyBundle): ReadyBundle {
  return {
    ...bundle,
    freshness: { ...bundle.freshness },
    snapshot_evidence: { ...bundle.snapshot_evidence, freshness: bundle.snapshot_evidence.freshness && { ...bundle.snapshot_evidence.freshness } },
    ci_evidence: { ...bundle.ci_evidence, freshness: bundle.ci_evidence.freshness && { ...bundle.ci_evidence.freshness } },
    review_evidence: { ...bundle.review_evidence, freshness: bundle.review_evidence.freshness && { ...bundle.review_evidence.freshness } },
  };
}

function matchingLeaseFence(record: ControllerRecord, event: ReplayInputEvent): boolean {
  if (!event.runtime_id) {
    stale(record, event, "runtime_missing");
    return false;
  }
  if (event.runtime_id !== record.active_runtime_id) {
    stale(record, event, "runtime_mismatch");
    return false;
  }
  if (!event.runtime_identity) {
    stale(record, event, "runtime_identity_missing");
    return false;
  }
  if (event.runtime_identity !== record.active_runtime_identity) {
    stale(record, event, "runtime_identity_mismatch");
    return false;
  }
  if (!event.lease_id || event.lease_id !== record.active_lease_id) {
    stale(record, event, "lease_mismatch");
    return false;
  }
  if (!event.lease_fencing_token) {
    stale(record, event, "lease_fencing_token_missing");
    return false;
  }
  if (event.lease_fencing_token !== record.active_lease_fencing_token) {
    stale(record, event, "lease_fencing_token_mismatch");
    return false;
  }
  return true;
}

function heartbeatFreshAt(event: ReplayInputEvent): boolean {
  if (!event.heartbeat_at) return false;
  const occurredAt = parseTimestamp(event.occurred_at);
  const heartbeatAt = parseTimestamp(event.heartbeat_at);
  return occurredAt !== undefined && heartbeatAt !== undefined && heartbeatAt <= occurredAt && occurredAt - heartbeatAt <= 90 * 1000;
}

/**
 * Matching lease events accept an explicit event heartbeat, or the last
 * accepted lease heartbeat recorded on the model. It is always evaluated at
 * the event timestamp, so missing, stale, and reversed observations fail.
 */
function heartbeatFreshForLeaseEvent(record: ControllerRecord, event: ReplayInputEvent): boolean {
  const heartbeatAt = heartbeatSource(record, event);
  if (!heartbeatAt) return false;
  const occurredAt = parseTimestamp(event.occurred_at);
  const heartbeat = parseTimestamp(heartbeatAt);
  return occurredAt !== undefined && heartbeat !== undefined && heartbeat <= occurredAt && occurredAt - heartbeat <= 90 * 1000;
}

function heartbeatSource(record: ControllerRecord, event: ReplayInputEvent): string | undefined {
  return event.heartbeat_at ?? record.last_heartbeat_at;
}

function leaseExpiryValid(event: ReplayInputEvent, expiresAt: string): boolean {
  const occurredAt = parseTimestamp(event.occurred_at);
  const expiry = parseTimestamp(expiresAt);
  return occurredAt !== undefined && expiry !== undefined && expiry > occurredAt;
}

function leaseStillValidAt(record: ControllerRecord, clock: number): boolean {
  const expiry = record.active_lease_expires_at ? parseTimestamp(record.active_lease_expires_at) : undefined;
  return expiry !== undefined && clock < expiry;
}

function leaseExpiredAt(record: ControllerRecord, clock: number): boolean {
  const expiry = record.active_lease_expires_at ? parseTimestamp(record.active_lease_expires_at) : undefined;
  return expiry !== undefined && clock >= expiry;
}

function evidenceFromEvent(event: ReplayInputEvent, kind: Evidence["kind"], clock: number, freshness?: Freshness, conclusion?: Evidence["conclusion"]): Evidence {
  const immutableRef = event.evidence_refs[0];
  return {
    id: immutableRef,
    kind,
    source: `fixture:${kind}`,
    immutable_ref: immutableRef,
    payload_hash: fnv1a(JSON.stringify({ kind, occurred_at: event.occurred_at, immutable_ref: immutableRef, freshness, conclusion })),
    freshness,
    status: "active",
    conclusion,
    expired: evidenceExpired(event, clock, kind),
    observed_at: event.occurred_at,
  };
}

function evidenceExpired(event: ReplayInputEvent, clock: number, kind: Evidence["kind"]): boolean {
  return !isTimestampWithinTtl(event.occurred_at, clock, kind === "snapshot" ? SNAPSHOT_TTL_MS : EVIDENCE_TTL_MS);
}

function isTimestampWithinTtl(timestamp: string, clock: number, ttl: number): boolean {
  const value = parseTimestamp(timestamp);
  return value !== undefined && value <= clock && clock - value <= ttl;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function notify(record: ControllerRecord, event: ReplayInputEvent, keys: Set<string>, signal: NotificationPlan["signal"], key: string, signalAuditFields: Readonly<Record<string, string | number>> = {}): void {
  if (keys.has(key)) return;
  keys.add(key);
  record.notifications.push({
    dedupe_key: key,
    signal,
    occurred_at: event.occurred_at,
    causal_event_id: event.event_id,
    delivery_id: record.delivery_id,
    generation: record.generation,
    retry: { idempotency_key: `${key}:retry`, backoff_minutes: [5, 15], max_attempts: 3, external_delivery: false },
    audit_fields: {
      delivery_id: record.delivery_id,
      generation: record.generation,
      runtime_id: record.active_runtime_id ?? "none",
      runtime_identity: record.active_runtime_identity ?? "none",
      lease_id: record.active_lease_id ?? "none",
      lease_fencing_token: record.active_lease_fencing_token ?? "none",
      offline_incident_id: record.offline_incident_id ?? "none",
      dedupe_key: key,
      heartbeat_age_seconds: heartbeatAgeSeconds(record, event.occurred_at),
      transition_event_id: event.event_id,
      ...signalAuditFields,
    },
  });
}

function freshnessAuditValue(freshness: Freshness | undefined): string {
  return freshness ? `${freshness.head_sha}:${freshness.base_sha}:${freshness.merge_state_status}` : "freshness_unknown";
}

function invalidationTrigger(oldFreshness: Freshness | undefined, newFreshness: Freshness | undefined, reason: string): string {
  if (!newFreshness) return reason;
  if (!oldFreshness || oldFreshness.head_sha !== newFreshness.head_sha) return "head_sha";
  if (oldFreshness.base_sha !== newFreshness.base_sha) return "base_sha";
  if (oldFreshness.merge_state_status !== newFreshness.merge_state_status) return "merge_state_status";
  return reason;
}

function repairAuditFields(record: ControllerRecord, event: ReplayInputEvent, cause: string, nextAction: string): Readonly<Record<string, string | number>> {
  return {
    repair_round: record.repair_round,
    cause,
    attempt_count: record.attempt_count,
    evidence_refs: event.evidence_refs.join(","),
    next_action: nextAction,
  };
}

function humanEscalationAuditFields(record: ControllerRecord, event: ReplayInputEvent, reason: string): Readonly<Record<string, string | number>> {
  return {
    escalation_reason: reason,
    evidence_refs: event.evidence_refs.join(","),
    freshness: freshnessAuditValue(record.current_freshness),
    acceptance_result: "human_decision_required",
  };
}

function heartbeatAgeSeconds(record: ControllerRecord, occurredAt: string): number {
  const heartbeatAt = record.last_heartbeat_at ? parseTimestamp(record.last_heartbeat_at) : undefined;
  const timestamp = parseTimestamp(occurredAt);
  return heartbeatAt === undefined || timestamp === undefined ? -1 : Math.max(0, Math.floor((timestamp - heartbeatAt) / 1000));
}

function invalid(record: ControllerRecord, event: ReplayInputEvent, reason: string): void {
  record.audit.push({ event_id: event.event_id, kind: "invalid_transition", reason });
}

function stale(record: ControllerRecord, event: ReplayInputEvent, reason: string): void {
  record.audit.push({ event_id: event.event_id, kind: "stale_event", reason });
}

export function normalizeFreshness(freshness: Freshness): Freshness {
  return { ...freshness, merge_state_status: freshness.merge_state_status.toLowerCase() };
}

export function sameFreshness(left: Freshness | undefined, right: Freshness | undefined): boolean {
  return Boolean(left && right && left.head_sha === right.head_sha && left.base_sha === right.base_sha && left.merge_state_status === right.merge_state_status);
}

export function freshnessHash(freshness: Freshness): string {
  return fnv1a(`${freshness.head_sha}:${freshness.base_sha}:${freshness.merge_state_status}`);
}

/** Parse a desensitized JSONL fixture; the first row fixes replay clock/state. */
export function replayJsonl(jsonl: string): ReplayResult {
  const rows = jsonl.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReplayFixture | ReplayInputEvent);
  const [fixture, ...events] = rows;
  if (!fixture || fixture.kind !== "fixture") throw new Error("controller_replay_fixture_header_required");
  return replay(events as ReplayInputEvent[], fixture);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

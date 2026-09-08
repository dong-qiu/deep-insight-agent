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
  freshness?: Freshness;
  status: "active" | "superseded";
  conclusion?: "passed" | "failed" | "approved";
  /** Derived solely from the fixture replay clock, never supplied by an event. */
  expired?: boolean;
  observed_at: string;
}

export interface TransitionEvent {
  event_id: string;
  delivery_id: string;
  generation_before: number;
  generation_after: number;
  from_state: ControllerState;
  to_state: ControllerState;
  occurred_at: string;
  idempotency_key: string;
  precondition: string;
  evidence_refs: string[];
  recovery_action: string;
}

export interface NotificationPlan {
  dedupe_key: string;
  signal: "offline" | "reconnect" | "invalidation" | "repair_exhausted" | "ready";
  occurred_at: string;
  causal_event_id: string;
}

export interface AuditEntry {
  event_id: string;
  kind: "invalid_transition" | "stale_event" | "replayed_event";
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
  active_lease_expires_at?: string;
  offline_incident_id?: string;
  offline_started_at?: string;
  checkpoint_ref?: string;
  current_freshness?: Freshness;
  evidence: Evidence[];
  transitions: TransitionEvent[];
  notifications: NotificationPlan[];
  audit: AuditEntry[];
}

export type ReplayEventKind =
  | "admit" | "queue" | "lease_confirmed" | "started" | "lease_expired"
  | "result" | "snapshot" | "ci" | "review" | "evaluate_ready"
  | "repair_dispatch" | "runtime_offline" | "task_inventory";

export interface ReplayInputEvent {
  event_id: string;
  /** Optional in fixture rows because the JSONL header supplies the envelope. */
  delivery_id?: string;
  kind: ReplayEventKind;
  occurred_at: string;
  evidence_refs: string[];
  /** Required fencing token; events without it are stale rather than actionable. */
  expected_generation: number;
  lease_id?: string;
  runtime_id?: string;
  lease_expires_at?: string;
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
  active_lease_expires_at?: string;
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

export function createControllerRecord(input: Pick<ReplayFixture, "delivery_id" | "state" | "generation" | "active_lease_id" | "active_runtime_id" | "active_lease_expires_at">): ControllerRecord {
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
    active_lease_expires_at: input.active_lease_expires_at,
    evidence: [],
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
      if (!transition(record, event, "leased", states, "fresh_heartbeat_and_confirmed_fenced_lease", "new_lease_required_after_expiry")) return;
      record.active_lease_id = event.lease_id;
      record.active_runtime_id = event.runtime_id;
      record.active_lease_expires_at = event.lease_expires_at;
      record.offline_incident_id = undefined;
      record.offline_started_at = undefined;
      return notify(record, event, notificationKeys, "reconnect", `${record.delivery_id}:${record.generation}:reconnect:${event.event_id}`);
    case "started":
      if (!matchingLeaseFence(record, event)) return;
      if (!leaseStillValidAt(record, event)) return stale(record, event, "lease_expired");
      if (!transition(record, event, "executing", states, "matching_unexpired_fenced_start_receipt", "lease_expiry_returns_to_waiting_without_attempt")) return;
      record.started_count += 1;
      return;
    case "lease_expired":
      if (!matchingLeaseFence(record, event)) return;
      if (!leaseExpiredAt(record, event)) return invalid(record, event, "lease_not_expired");
      if (!transition(record, event, "waiting_for_runtime", states, "matching_lease_expired_without_terminal_result", "preserve_checkpoint_and_reacquire_new_lease")) return;
      record.active_lease_id = undefined;
      record.active_runtime_id = undefined;
      record.active_lease_expires_at = undefined;
      record.checkpoint_ref = event.checkpoint_ref ?? record.checkpoint_ref;
      return;
    case "result":
      return applyResult(record, event, states, notificationKeys, clock);
    case "snapshot":
      return applySnapshot(record, event, states, notificationKeys, clock);
    case "ci":
      return addFreshEvidence(record, event, "ci", clock);
    case "review":
      return addFreshEvidence(record, event, "review", clock);
    case "evaluate_ready":
      if (!readyEvidence(record, clock)) return invalid(record, event, "active_unexpired_matching_snapshot_and_fresh_clean_passing_ci_and_approved_review_required");
      if (transition(record, event, "ready_for_human_review", states, "current_freshness_and_matching_unexpired_evidence", "recheck_freshness_before_any_human_acceptance")) {
        notify(record, event, notificationKeys, "ready", `${record.delivery_id}:${record.generation}:ready:${event.event_id}`);
      }
      return;
    case "repair_dispatch":
      if (record.repair_round >= 2) {
        if (transition(record, event, "awaiting_human_decision", states, "repair_budget_exhausted", "stop_automation_and_wait_for_human")) {
          notify(record, event, notificationKeys, "repair_exhausted", `${record.delivery_id}:${record.generation}:repair_exhausted:${event.event_id}`);
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
  }
}

function applyResult(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (!matchingLeaseFence(record, event)) return;
  if (!leaseStillValidAt(record, event)) return stale(record, event, "lease_expired");
  if (!event.result) return invalid(record, event, "terminal_result_required");
  const to = event.result === "completed" ? "evidence_collecting" : record.repair_round < 2 ? "repairing" : "awaiting_human_decision";
  if (!transition(record, event, to, states, "matching_fenced_terminal_result", "record_terminal_result_once_and_never_reuse_lease")) return;
  record.attempt_count += 1;
  record.active_lease_id = undefined;
  record.active_runtime_id = undefined;
  record.active_lease_expires_at = undefined;
  record.active_task_ids = [];
  // Result freshness is correlation evidence only. An authoritative snapshot is
  // the sole source allowed to establish current_freshness.
  record.evidence.push(evidenceFromEvent(event, "result", clock, event.freshness, event.result === "completed" ? "passed" : "failed"));
  if (to === "awaiting_human_decision") notify(record, event, notificationKeys, "repair_exhausted", `${record.delivery_id}:${record.generation}:repair_exhausted:${event.event_id}`);
}

function applySnapshot(record: ControllerRecord, event: ReplayInputEvent, states: ControllerState[], notificationKeys: Set<string>, clock: number): void {
  if (!event.freshness) return invalid(record, event, "freshness_required");
  const freshness = normalizeFreshness(event.freshness);
  if (evidenceExpired(event, clock, "snapshot")) {
    // Keep the supplied snapshot reference as rejected evidence so the
    // fail-closed decision remains independently auditable.
    record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
    return invalid(record, event, "authoritative_snapshot_expired");
  }
  if (!record.current_freshness) {
    record.current_freshness = freshness;
    record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
    return;
  }
  if (sameFreshness(record.current_freshness, freshness)) {
    if (record.state === "freshness_invalidated") {
      transition(record, event, "evidence_collecting", states, "authoritative_new_generation_snapshot", "collect_new_ci_and_review_evidence");
    }
    return;
  }
  if (!ACTIVE_STATES.has(record.state) && record.state !== "ready_for_human_review") return invalid(record, event, "freshness_change_from_non_active_state");
  const oldHash = freshnessHash(record.current_freshness);
  if (!transition(record, event, "freshness_invalidated", states, "authoritative_freshness_changed_or_unknown", "supersede_old_evidence_and_collect_new_generation", true)) return;
  record.evidence.forEach((evidence) => { if (evidence.freshness && sameFreshness(evidence.freshness, record.current_freshness!)) evidence.status = "superseded"; });
  record.current_freshness = freshness;
  record.active_lease_id = undefined;
  record.active_runtime_id = undefined;
  record.active_lease_expires_at = undefined;
  record.active_task_ids = [];
  record.evidence.push(evidenceFromEvent(event, "snapshot", clock, freshness));
  notify(record, event, notificationKeys, "invalidation", `${record.delivery_id}:${record.generation}:invalidation:${oldHash}:${event.event_id}`);
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

function transition(record: ControllerRecord, event: ReplayInputEvent, to: ControllerState, states: ControllerState[], precondition: string, recovery: string, incrementGeneration = false): boolean {
  if (!allowed(record.state, to)) {
    invalid(record, event, `transition_not_allowed:${record.state}:${to}`);
    return false;
  }
  const before = record.generation;
  const from = record.state;
  record.generation += incrementGeneration ? 1 : 0;
  record.state = to;
  record.transitions.push({
    event_id: event.event_id,
    delivery_id: record.delivery_id,
    generation_before: before,
    generation_after: record.generation,
    from_state: from,
    to_state: to,
    occurred_at: event.occurred_at,
    idempotency_key: `${record.delivery_id}:${before}:${from}_to_${to}:${event.event_id}`,
    precondition,
    evidence_refs: [...event.evidence_refs],
    recovery_action: recovery,
  });
  states.push(to);
  return true;
}

function allowed(from: ControllerState, to: ControllerState): boolean {
  const edges: Partial<Record<ControllerState, ControllerState[]>> = {
    intake: ["admitted"],
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

function readyEvidence(record: ControllerRecord, clock: number): boolean {
  const freshness = record.current_freshness;
  return Boolean(freshness && freshness.merge_state_status === "clean"
    && record.evidence.some((e) => e.kind === "snapshot" && e.status === "active" && !e.expired && isTimestampWithinTtl(e.observed_at, clock, SNAPSHOT_TTL_MS) && sameFreshness(e.freshness, freshness))
    && record.evidence.some((e) => e.kind === "ci" && e.status === "active" && e.conclusion === "passed" && !e.expired && sameFreshness(e.freshness, freshness))
    && record.evidence.some((e) => e.kind === "review" && e.status === "active" && e.conclusion === "approved" && !e.expired && sameFreshness(e.freshness, freshness)));
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
  if (!event.lease_id || event.lease_id !== record.active_lease_id) {
    stale(record, event, "lease_mismatch");
    return false;
  }
  return true;
}

function leaseExpiryValid(event: ReplayInputEvent, expiresAt: string): boolean {
  const occurredAt = parseTimestamp(event.occurred_at);
  const expiry = parseTimestamp(expiresAt);
  return occurredAt !== undefined && expiry !== undefined && expiry > occurredAt;
}

function leaseStillValidAt(record: ControllerRecord, event: ReplayInputEvent): boolean {
  const occurredAt = parseTimestamp(event.occurred_at);
  const expiry = record.active_lease_expires_at ? parseTimestamp(record.active_lease_expires_at) : undefined;
  return occurredAt !== undefined && expiry !== undefined && occurredAt <= expiry;
}

function leaseExpiredAt(record: ControllerRecord, event: ReplayInputEvent): boolean {
  const occurredAt = parseTimestamp(event.occurred_at);
  const expiry = record.active_lease_expires_at ? parseTimestamp(record.active_lease_expires_at) : undefined;
  return occurredAt !== undefined && expiry !== undefined && occurredAt >= expiry;
}

function evidenceFromEvent(event: ReplayInputEvent, kind: Evidence["kind"], clock: number, freshness?: Freshness, conclusion?: Evidence["conclusion"]): Evidence {
  return {
    id: event.evidence_refs[0],
    kind,
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

function notify(record: ControllerRecord, event: ReplayInputEvent, keys: Set<string>, signal: NotificationPlan["signal"], key: string): void {
  if (keys.has(key)) return;
  keys.add(key);
  record.notifications.push({ dedupe_key: key, signal, occurred_at: event.occurred_at, causal_event_id: event.event_id });
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

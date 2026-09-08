/**
 * Reconciles recorded, read-only snapshots into the local ControllerStore.
 * It intentionally cannot dispatch work or call a provider mutation endpoint.
 */
import type { ControllerRecord, Evidence, Freshness, NotificationPlan, TransitionEvent } from "./replay.js";
import type { GitHubEvidencePort, GitHubEvidenceSnapshot, RuntimeReceipt, RuntimeSnapshot, RuntimeSnapshotPort, RuntimeTaskSnapshot, RuntimeTerminalReceipt } from "./ports.js";
import { ControllerStore, type DurableControllerRecord, type StoreMutation } from "./store.js";

const HEARTBEAT_MS = 90_000;
const SNAPSHOT_MS = 10 * 60_000;
const EVIDENCE_MS = 24 * 60 * 60_000;

export interface ReconcileResult { kind: "updated" | "unchanged" | "frozen" | "missing"; record?: DurableControllerRecord; reason?: string; }

export async function reconcileController(
  store: ControllerStore,
  deliveryId: string,
  ports: { runtime: RuntimeSnapshotPort; github: GitHubEvidencePort },
  now: string,
): Promise<ReconcileResult> {
  let record = store.load(deliveryId);
  if (!record) return { kind: "missing" };
  if (record.pending_invalidation) return { kind: "frozen", record: store.recoverPendingInvalidation(deliveryId, now), reason: "pending_invalidation_recovered" };

  let runtime: RuntimeSnapshot;
  let github: GitHubEvidenceSnapshot;
  try {
    [runtime, github] = await Promise.all([ports.runtime.readRuntimeSnapshot(deliveryId), ports.github.readGitHubEvidenceSnapshot(deliveryId)]);
  } catch (error) {
    return freeze(store, record, now, `read_only_adapter_error:${error instanceof Error ? error.message : "unknown"}`);
  }

  const active = runtime.tasks.filter((task) => task.state === "queued" || task.state === "leased" || task.state === "running");
  if (active.length > 1) return freeze(store, record, now, "multiple_active_tasks");

  const githubResult = reconcileGitHub(store, record, github, now);
  if (githubResult) {
    record = githubResult.record ?? record;
    if (githubResult.kind === "frozen") return githubResult;
  }
  return reconcileRuntime(store, record, runtime, now) ?? githubResult ?? { kind: "unchanged", record };
}

function reconcileGitHub(store: ControllerStore, record: DurableControllerRecord, snapshot: GitHubEvidenceSnapshot, now: string): ReconcileResult | undefined {
  const source = snapshot.snapshot;
  if (!source || stale(source.observed_at, now, SNAPSHOT_MS) || !isClean(source.freshness)) {
    return invalidateOrFreeze(store, record, now, "github_snapshot_missing_stale_or_unknown", source?.freshness);
  }
  if (record.state === "freshness_invalidated") {
    const next: DurableControllerRecord = { ...record, state: "evidence_collecting", current_freshness: { ...source.freshness }, evidence: [...record.evidence, ...toEvidence({ ...snapshot, ci: undefined, review: undefined }).filter((item) => !record.evidence.some((existing) => existing.id === item.id))], updated_at: now };
    return commit(store, record, next, now, "freshness_refreshed", "new_generation_clean_snapshot", "evidence_collecting", next.evidence.filter((item) => !record.evidence.some((existing) => existing.id === item.id)));
  }
  if (record.current_freshness && !sameFreshness(record.current_freshness, source.freshness)) {
    return invalidateOrFreeze(store, record, now, "github_freshness_changed", source.freshness);
  }
  if ((record.state === "evidence_collecting" || record.state === "ready_for_human_review") && !hasCurrentEvidenceBundle(snapshot, source.freshness, now)) {
    return invalidateOrFreeze(store, record, now, "github_ci_review_missing_stale_or_mismatched", source.freshness);
  }
  const evidence = toEvidence(snapshot);
  const additions = evidence.filter((item) => !record.evidence.some((existing) => existing.id === item.id));
  const next = { ...record, current_freshness: { ...source.freshness }, evidence: [...record.evidence, ...additions], updated_at: now };
  const ready = readyEvidence(next, now);
  if (ready && next.state === "evidence_collecting") {
    next.state = "ready_for_human_review";
    return commit(store, record, next, now, "ready", "matching_current_clean_ci_and_review", "ready_for_human_review", additions, [plan(next, "ready", now, "github_snapshot")]);
  }
  if (additions.length > 0 || !record.current_freshness) return observe(store, record, next, additions, now);
  return undefined;
}

function reconcileRuntime(store: ControllerStore, record: DurableControllerRecord, runtime: RuntimeSnapshot, now: string): ReconcileResult | undefined {
  const active = runtime.tasks.find((task) => task.state === "queued" || task.state === "leased" || task.state === "running");
  const terminal = runtime.tasks.find((task) => task.state === "completed" || task.state === "failed");
  if (record.state === "waiting_for_runtime" && active?.state === "leased") {
    if (!runtime.heartbeat_at || stale(runtime.heartbeat_at, now, HEARTBEAT_MS) || !active.lease_id || !active.runtime_id || !active.runtime_identity || !active.lease_fencing_token || !active.lease_expires_at || time(active.lease_expires_at) <= time(now)) {
      return freeze(store, record, now, "lease_confirmation_evidence_incomplete_or_expired");
    }
    const next: DurableControllerRecord = { ...record, state: "leased", active_task_ids: [active.task_id], active_lease_id: active.lease_id, active_runtime_id: active.runtime_id, active_runtime_identity: active.runtime_identity, active_lease_fencing_token: active.lease_fencing_token, active_lease_expires_at: active.lease_expires_at, last_heartbeat_at: runtime.heartbeat_at, offline_incident_id: undefined, offline_started_at: undefined, updated_at: now };
    return commit(store, record, next, now, "lease_reconnected", "fresh_heartbeat_and_matching_read_only_lease_snapshot", "leased", [localEvidence(record, `runtime-lease:${active.task_id}`, now)], [plan(next, "reconnect", now, active.lease_id)]);
  }
  if (record.state === "waiting_for_runtime" && active?.state === "running") return freeze(store, record, now, "task_lease_inconsistent");
  if (record.state === "leased" && active?.state === "running") {
    if (receiptIsUsable(record, active.start_receipt, runtime.heartbeat_at, now)) {
      const next: DurableControllerRecord = { ...record, state: "executing", last_heartbeat_at: runtime.heartbeat_at, updated_at: now };
      return commit(store, record, next, now, "runtime_started", "matching_unexpired_fenced_start_receipt", "executing", [localEvidence(record, `runtime-start:${active.task_id}`, now)]);
    }
    store.appendAudit(record.delivery_id, "invalid_receipt", "start_receipt_missing_stale_or_fence_mismatch", now);
  }
  if (terminal && record.active_lease_id) {
    if (!matchesLease(record, terminal)) {
      store.appendAudit(record.delivery_id, "stale_event", "old_lease_or_result_fenced", now);
    } else if (record.state === "executing" && terminalReceiptIsUsable(record, terminal, runtime.heartbeat_at, now)) {
      const next: DurableControllerRecord = { ...record, state: terminal.result === "failed" ? "repairing" : "evidence_collecting", attempt_count: record.attempt_count + 1, active_task_ids: [], active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: now };
      return commit(store, record, next, now, "terminal_result", "matching_fenced_terminal_result", next.state, [localEvidence(record, `runtime-result:${terminal.task_id}`, now)]);
    } else {
      store.appendAudit(record.delivery_id, "invalid_receipt", "terminal_receipt_missing_stale_or_result_mismatch", now);
    }
  }
  const heartbeatOffline = !runtime.heartbeat_at || stale(runtime.heartbeat_at, now, HEARTBEAT_MS);
  if (heartbeatOffline && (record.state === "leased" || record.state === "executing")) {
    const offlineStarted = record.offline_started_at ?? now;
    const elapsed = time(now) - time(offlineStarted);
    const state = elapsed >= 30 * 60_000 || record.consecutive_lease_losses >= 3 ? "awaiting_human_decision" : "waiting_for_runtime";
    const next: DurableControllerRecord = { ...record, state, active_task_ids: state === "awaiting_human_decision" ? [] : record.active_task_ids, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, offline_started_at: offlineStarted, offline_incident_id: record.offline_incident_id ?? `offline:${record.delivery_id}:${record.generation}`, updated_at: now };
    return commit(store, record, next, now, "runtime_offline", "heartbeat_older_than_90_seconds", state, [localEvidence(record, "runtime-heartbeat", now)], [plan(next, state === "awaiting_human_decision" ? "human_escalation" : "offline", now, "runtime_offline")]);
  }
  if (record.active_lease_expires_at && time(record.active_lease_expires_at) <= time(now) && (record.state === "leased" || record.state === "executing")) {
    const losses = record.consecutive_lease_losses + 1;
    const state = losses >= 3 ? "awaiting_human_decision" : "waiting_for_runtime";
    const next: DurableControllerRecord = { ...record, state, consecutive_lease_losses: losses, active_task_ids: state === "awaiting_human_decision" ? [] : record.active_task_ids, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, checkpoint_ref: active?.checkpoint_ref ?? record.checkpoint_ref, updated_at: now };
    return commit(store, record, next, now, "lease_interrupted", losses >= 3 ? "third_lost_lease" : "expired_without_matching_terminal_result", state, [localEvidence(record, "runtime-lease-expiry", now)], losses >= 3 ? [plan(next, "human_escalation", now, "third_lost_lease")] : undefined);
  }
  return undefined;
}

function invalidateOrFreeze(store: ControllerStore, record: DurableControllerRecord, now: string, reason: string, observed?: Freshness): ReconcileResult {
  if (!record.current_freshness) return freeze(store, record, now, reason);
  const key = `${record.delivery_id}:${record.generation}:invalidate:${reason}`;
  const fence = store.beginInvalidation(record.delivery_id, { generation: record.generation, state: record.state }, { idempotency_key: key, observed_freshness: observed, reason, fenced_at: now });
  if (fence.kind === "cas_conflict" || fence.kind === "semantic_conflict") return { kind: "frozen", record: fence.record, reason: fence.kind };
  const superseded = record.evidence.map((evidence) => ({ ...evidence, status: "superseded" as const }));
  const next: DurableControllerRecord = { ...record, generation: record.generation + 1, state: "freshness_invalidated", current_freshness: observed && isClean(observed) ? { ...observed } : undefined, evidence: superseded, ready_bundle: undefined, superseded_ready_bundles: record.ready_bundle ? [...record.superseded_ready_bundles, record.ready_bundle] : record.superseded_ready_bundles, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: now };
  const result = commit(store, fence.record!, next, now, "freshness_invalidated", reason, "freshness_invalidated", superseded, [plan(next, "invalidation", now, reason)], key);
  return result.kind === "updated" ? result : { kind: "frozen", record: result.record, reason: result.reason };
}

function freeze(store: ControllerStore, record: DurableControllerRecord, now: string, reason: string): ReconcileResult {
  if (record.state === "awaiting_human_decision") return { kind: "frozen", record, reason };
  const next: DurableControllerRecord = { ...record, state: "awaiting_human_decision", active_task_ids: [], active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: now };
  const result = commit(store, record, next, now, "human_escalation", `fail_closed:${reason}`, "awaiting_human_decision", [localEvidence(record, `local:${reason}`, now)], [plan(next, "human_escalation", now, reason)]);
  return { kind: "frozen", record: result.record, reason };
}

function commit(store: ControllerStore, before: DurableControllerRecord, next: DurableControllerRecord, now: string, kind: string, precondition: string, toState: ControllerRecord["state"], evidence: Evidence[] = [], outbox?: NotificationPlan[], fixedKey?: string): ReconcileResult {
  const transition = transitionFor(before, next, now, kind, precondition, toState, fixedKey);
  const mutation: StoreMutation = { expected: { generation: before.generation, state: before.state }, next, transition, evidence, outbox };
  const result = store.compareAndAppend(mutation);
  if (result.kind === "applied" || result.kind === "replayed") return { kind: "updated", record: result.record };
  return { kind: "frozen", record: result.record, reason: result.kind };
}

/** Snapshot collection is deliberately not a state transition. */
function observe(store: ControllerStore, before: DurableControllerRecord, next: DurableControllerRecord, evidence: Evidence[], now: string): ReconcileResult {
  const ids = evidence.map((item) => item.id).sort().join(",");
  const mutation: StoreMutation = { expected: { generation: before.generation, state: before.state }, next, evidence, idempotency_key: `${before.delivery_id}:${before.generation}:evidence:${hash(`${ids}:${now}`)}` };
  const result = store.compareAndAppend(mutation);
  if (result.kind === "applied" || result.kind === "replayed") return { kind: "updated", record: result.record };
  return { kind: "frozen", record: result.record, reason: result.kind };
}

function transitionFor(before: DurableControllerRecord, next: DurableControllerRecord, now: string, kind: string, precondition: string, toState: ControllerRecord["state"], fixedKey?: string): TransitionEvent {
  const key = fixedKey ?? `${before.delivery_id}:${before.generation}:${kind}:${hash(`${kind}:${now}:${toState}`)}`;
  return { event_id: `controller:${hash(`${before.delivery_id}:${before.generation}:${next.generation}:${before.state}:${toState}:${kind}:${key}`)}`, causal_event_id: `${kind}:${hash(`${now}:${precondition}`)}`, delivery_id: before.delivery_id, generation_before: before.generation, generation_after: next.generation, from_state: before.state, to_state: toState, writer: "controller:reconciler", occurred_at: now, idempotency_key: key, precondition, evidence_refs: [kind], recovery_action: "persist_local_state_only_and_recheck_read_only_snapshots" };
}

function toEvidence(snapshot: GitHubEvidenceSnapshot): Evidence[] {
  const entries: Evidence[] = [];
  if (snapshot.snapshot) entries.push({ ...snapshot.snapshot, kind: "snapshot", source: "github:recorded-read-only", status: "active" });
  if (snapshot.ci) entries.push({ ...snapshot.ci, kind: "ci", source: "github:recorded-read-only", status: "active" });
  if (snapshot.review) entries.push({ ...snapshot.review, kind: "review", source: "github:recorded-read-only", status: "active" });
  return entries;
}

function localEvidence(record: DurableControllerRecord, id: string, observedAt: string): Evidence {
  return { id: `${record.delivery_id}:${id}:${hash(observedAt)}`, kind: "result", source: "controller:local-store", immutable_ref: id, payload_hash: hash(`${record.delivery_id}:${id}:${observedAt}`), status: "active", observed_at: observedAt };
}

function readyEvidence(record: DurableControllerRecord, now: string): boolean {
  if (!record.current_freshness || !isClean(record.current_freshness)) return false;
  const matching = (kind: Evidence["kind"], conclusion: Evidence["conclusion"], ttl: number) => record.evidence.some((item) => item.kind === kind && item.status === "active" && item.conclusion === conclusion && item.freshness && sameFreshness(item.freshness, record.current_freshness!) && !stale(item.observed_at, now, ttl));
  return matching("snapshot", undefined, SNAPSHOT_MS) && matching("ci", "passed", EVIDENCE_MS) && matching("review", "approved", EVIDENCE_MS);
}

function hasCurrentEvidenceBundle(snapshot: GitHubEvidenceSnapshot, freshness: Freshness, now: string): boolean {
  const matching = (entry: GitHubEvidenceSnapshot["snapshot"] | GitHubEvidenceSnapshot["ci"] | GitHubEvidenceSnapshot["review"] | undefined, conclusion: Evidence["conclusion"], ttl: number) => Boolean(entry && ("conclusion" in entry ? entry.conclusion : undefined) === conclusion && sameFreshness(entry.freshness, freshness) && !stale(entry.observed_at, now, ttl));
  return matching(snapshot.snapshot, undefined, SNAPSHOT_MS) && matching(snapshot.ci, "passed", EVIDENCE_MS) && matching(snapshot.review, "approved", EVIDENCE_MS);
}

function plan(record: DurableControllerRecord, signal: NotificationPlan["signal"], now: string, cause: string): NotificationPlan {
  const causal = `${signal}:${hash(`${record.delivery_id}:${record.generation}:${cause}`)}`;
  return { dedupe_key: `${record.delivery_id}:${record.generation}:${signal}:${causal}`, signal, occurred_at: now, causal_event_id: causal, delivery_id: record.delivery_id, generation: record.generation, retry: { idempotency_key: `${record.delivery_id}:${record.generation}:notify:${signal}:${causal}`, backoff_minutes: [5, 15], max_attempts: 3, external_delivery: false }, audit_fields: { cause, persisted_only: 1 } };
}

function matchesLease(record: DurableControllerRecord, task: { lease_id?: string; runtime_id?: string; runtime_identity?: string; lease_fencing_token?: string; lease_expires_at?: string }): boolean {
  return Boolean(record.active_lease_id && task.lease_id === record.active_lease_id && task.runtime_id === record.active_runtime_id && task.runtime_identity === record.active_runtime_identity && task.lease_fencing_token === record.active_lease_fencing_token && task.lease_expires_at === record.active_lease_expires_at);
}
function receiptIsUsable(record: DurableControllerRecord, receipt: RuntimeReceipt | undefined, heartbeatAt: string | undefined, now: string): boolean {
  return Boolean(receipt?.observed_at && heartbeatAt && !stale(heartbeatAt, now, HEARTBEAT_MS) && !stale(receipt.observed_at, now, HEARTBEAT_MS) && matchesLease(record, receipt) && record.active_lease_expires_at && time(record.active_lease_expires_at) > time(now));
}
function terminalReceiptIsUsable(record: DurableControllerRecord, task: RuntimeTaskSnapshot, heartbeatAt: string | undefined, now: string): boolean {
  const expected = task.state === "completed" ? "completed" : task.state === "failed" ? "failed" : undefined;
  const receipt: RuntimeTerminalReceipt | undefined = task.terminal_receipt;
  return Boolean(expected && task.result === expected && receipt?.result === expected && receiptIsUsable(record, receipt, heartbeatAt, now));
}
function isClean(freshness: Freshness): boolean { return freshness.merge_state_status.toLowerCase() === "clean"; }
function sameFreshness(a: Freshness, b: Freshness): boolean { return a.head_sha === b.head_sha && a.base_sha === b.base_sha && a.merge_state_status.toLowerCase() === b.merge_state_status.toLowerCase(); }
function stale(observed: string, now: string, max: number): boolean { return !Number.isFinite(time(observed)) || time(now) - time(observed) > max; }
function time(value: string): number { return Date.parse(value); }
function hash(value: string): string { let result = 2166136261; for (let i = 0; i < value.length; i += 1) result = Math.imul(result ^ value.charCodeAt(i), 16777619); return (result >>> 0).toString(16); }

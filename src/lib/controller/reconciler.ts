/**
 * Reconciles recorded, read-only snapshots into the local ControllerStore.
 * It intentionally cannot dispatch work or call a provider mutation endpoint.
 */
import { normalizeFreshness, readyBundleFor, type ControllerRecord, type Evidence, type Freshness, type NotificationPlan, type TransitionEvent } from "./replay.js";
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
  const normalized = normalizeGitHubSnapshot(snapshot);
  const source = normalized.snapshot;
  if (!source || stale(source.observed_at, now, SNAPSHOT_MS) || !isClean(source.freshness)) {
    return invalidateOrFreeze(store, record, now, "github_snapshot_missing_stale_or_unknown", source?.freshness);
  }
  if (record.state === "freshness_invalidated") {
    const incoming = toEvidence({ ...normalized, ci: undefined, review: undefined }, record.generation);
    if (evidenceConflict(record, incoming)) return freeze(store, record, now, "github_evidence_identity_conflict");
    const next: DurableControllerRecord = { ...record, state: "evidence_collecting", current_freshness: { ...source.freshness }, evidence: [...record.evidence, ...incoming.filter((item) => !record.evidence.some((existing) => existing.id === item.id))], updated_at: now };
    return commit(store, record, next, now, "freshness_refreshed", "new_generation_clean_snapshot", "evidence_collecting", next.evidence.filter((item) => !record.evidence.some((existing) => existing.id === item.id)));
  }
  if (record.current_freshness && !sameFreshness(record.current_freshness, source.freshness)) {
    return invalidateOrFreeze(store, record, now, "github_freshness_changed", source.freshness);
  }
  if ((record.state === "evidence_collecting" || record.state === "ready_for_human_review") && !hasCurrentEvidenceBundle(normalized, source.freshness, now)) {
    return invalidateOrFreeze(store, record, now, "github_ci_review_missing_stale_or_mismatched", source.freshness);
  }
  const evidence = toEvidence(normalized, record.generation);
  if (evidenceConflict(record, evidence)) return freeze(store, record, now, "github_evidence_identity_conflict");
  const additions = evidence.filter((item) => !record.evidence.some((existing) => existing.id === item.id));
  const next = { ...record, current_freshness: { ...source.freshness }, evidence: [...record.evidence, ...additions], updated_at: now };
  const ready = readyEvidence(next, now);
  if (ready && next.state === "evidence_collecting") {
    next.state = "ready_for_human_review";
    const bundle = readyBundleFor(next, now);
    if (!bundle) return freeze(store, record, now, "ready_bundle_construction_failed");
    next.ready_bundle = bundle;
    return commit(store, record, next, now, "ready", "matching_current_clean_ci_and_review", "ready_for_human_review", additions, [plan(next, "ready", now, "github_snapshot")]);
  }
  if (additions.length > 0 || !record.current_freshness) return observe(store, record, next, additions, now);
  return undefined;
}

function reconcileRuntime(store: ControllerStore, record: DurableControllerRecord, runtime: RuntimeSnapshot, now: string): ReconcileResult | undefined {
  const active = runtime.tasks.find((task) => task.state === "queued" || task.state === "leased" || task.state === "running");
  const terminal = runtime.tasks.find((task) => task.state === "completed" || task.state === "failed");
  if (record.state === "waiting_for_runtime" && active?.state === "leased") {
    if (!runtime.heartbeat_at || !validFreshTimestamp(runtime.heartbeat_at, now, HEARTBEAT_MS) || !active.lease_id || !active.runtime_id || !active.runtime_identity || !active.lease_fencing_token || !validFutureTimestamp(active.lease_expires_at, now)) {
      return freeze(store, record, now, "lease_confirmation_evidence_incomplete_or_expired");
    }
    const next: DurableControllerRecord = { ...record, state: "leased", active_task_ids: [active.task_id], active_lease_id: active.lease_id, active_runtime_id: active.runtime_id, active_runtime_identity: active.runtime_identity, active_lease_fencing_token: active.lease_fencing_token, active_lease_expires_at: active.lease_expires_at, last_heartbeat_at: runtime.heartbeat_at, offline_incident_id: undefined, offline_started_at: undefined, updated_at: now };
    return commit(store, record, next, now, "lease_reconnected", "fresh_heartbeat_and_matching_read_only_lease_snapshot", "leased", [localEvidence(next, `runtime-lease:${active.task_id}`, now)], [plan(next, "reconnect", now, active.lease_id)]);
  }
  if (record.state === "waiting_for_runtime" && active?.state === "running") return freeze(store, record, now, "task_lease_inconsistent");
  if (record.state === "leased" && active?.state === "running") {
    if (receiptIsUsable(record, active, active.start_receipt, runtime.heartbeat_at, now, "running")) {
      const next: DurableControllerRecord = { ...record, state: "executing", last_heartbeat_at: runtime.heartbeat_at, updated_at: now };
      return commit(store, record, next, now, "runtime_started", "matching_unexpired_fenced_start_receipt", "executing", [receiptEvidence(next, "runtime-start", active.start_receipt!, now)]);
    }
    store.appendAudit(record.delivery_id, "invalid_receipt", "start_receipt_missing_stale_or_fence_mismatch", now);
  }
  if (terminal && record.active_lease_id) {
    if (!matchesLease(record, terminal)) {
      store.appendAudit(record.delivery_id, "stale_event", "old_lease_or_result_fenced", now);
    } else if (record.state === "executing" && terminalReceiptIsUsable(record, terminal, runtime.heartbeat_at, now)) {
      const next: DurableControllerRecord = { ...record, state: terminal.result === "failed" ? "repairing" : "evidence_collecting", attempt_count: record.attempt_count + 1, active_task_ids: [], active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: now };
      return commit(store, record, next, now, "terminal_result", "matching_fenced_terminal_result", next.state, [receiptEvidence(next, "runtime-result", terminal.terminal_receipt!, now)]);
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
    return commit(store, record, next, now, "runtime_offline", "heartbeat_older_than_90_seconds", state, [localEvidence(next, "runtime-heartbeat", now)], [plan(next, state === "awaiting_human_decision" ? "human_escalation" : "offline", now, "runtime_offline")]);
  }
  if (record.active_lease_expires_at && time(record.active_lease_expires_at) <= time(now) && (record.state === "leased" || record.state === "executing")) {
    const losses = record.consecutive_lease_losses + 1;
    const state = losses >= 3 ? "awaiting_human_decision" : "waiting_for_runtime";
    const next: DurableControllerRecord = { ...record, state, consecutive_lease_losses: losses, active_task_ids: state === "awaiting_human_decision" ? [] : record.active_task_ids, active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, checkpoint_ref: active?.checkpoint_ref ?? record.checkpoint_ref, updated_at: now };
    return commit(store, record, next, now, "lease_interrupted", losses >= 3 ? "third_lost_lease" : "expired_without_matching_terminal_result", state, [localEvidence(next, "runtime-lease-expiry", now)], losses >= 3 ? [plan(next, "human_escalation", now, "third_lost_lease")] : undefined);
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
  const result = commit(store, fence.record!, next, now, "freshness_invalidated", reason, "freshness_invalidated", [localEvidence(next, "freshness-invalidation", now)], [plan(next, "invalidation", now, reason)], key);
  return result.kind === "updated" ? result : { kind: "frozen", record: result.record, reason: result.reason };
}

function freeze(store: ControllerStore, record: DurableControllerRecord, now: string, reason: string): ReconcileResult {
  if (record.state === "awaiting_human_decision") return { kind: "frozen", record, reason };
  const next: DurableControllerRecord = { ...record, state: "awaiting_human_decision", ready_bundle: undefined, superseded_ready_bundles: record.ready_bundle ? [...record.superseded_ready_bundles, record.ready_bundle] : record.superseded_ready_bundles, active_task_ids: [], active_lease_id: undefined, active_runtime_id: undefined, active_runtime_identity: undefined, active_lease_expires_at: undefined, active_lease_fencing_token: undefined, updated_at: now };
  const result = commit(store, record, next, now, "human_escalation", `fail_closed:${reason}`, "awaiting_human_decision", [localEvidence(next, `local:${reason}`, now)], [plan(next, "human_escalation", now, reason)]);
  return { kind: "frozen", record: result.record, reason };
}

function commit(store: ControllerStore, before: DurableControllerRecord, next: DurableControllerRecord, now: string, kind: string, precondition: string, toState: ControllerRecord["state"], evidence: Evidence[] = [], outbox?: NotificationPlan[], fixedKey?: string): ReconcileResult {
  const transition = transitionFor(before, next, now, kind, precondition, toState, evidence.map((item) => item.id), fixedKey);
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

function transitionFor(before: DurableControllerRecord, next: DurableControllerRecord, now: string, kind: string, precondition: string, toState: ControllerRecord["state"], evidenceRefs: string[], fixedKey?: string): TransitionEvent {
  const key = fixedKey ?? `${before.delivery_id}:${before.generation}:${kind}:${hash(`${kind}:${now}:${toState}`)}`;
  return { event_id: `controller:${hash(`${before.delivery_id}:${before.generation}:${next.generation}:${before.state}:${toState}:${kind}:${key}`)}`, causal_event_id: `${kind}:${hash(`${now}:${precondition}`)}`, delivery_id: before.delivery_id, generation_before: before.generation, generation_after: next.generation, from_state: before.state, to_state: toState, writer: "controller:reconciler", occurred_at: now, idempotency_key: key, precondition, evidence_refs: [...evidenceRefs], recovery_action: "persist_local_state_only_and_recheck_read_only_snapshots" };
}

function toEvidence(snapshot: GitHubEvidenceSnapshot, generation: number): Evidence[] {
  const entries: Evidence[] = [];
  if (snapshot.snapshot) entries.push(versionedEvidence(snapshot.snapshot, "snapshot", generation));
  if (snapshot.ci) entries.push(versionedEvidence(snapshot.ci, "ci", generation));
  if (snapshot.review) entries.push(versionedEvidence(snapshot.review, "review", generation));
  return entries;
}

function normalizeGitHubSnapshot(snapshot: GitHubEvidenceSnapshot): GitHubEvidenceSnapshot {
  const normalize = <T extends { freshness: Freshness }>(entry: T | undefined): T | undefined => entry && { ...entry, freshness: normalizeFreshness(entry.freshness) };
  return { ...snapshot, snapshot: normalize(snapshot.snapshot), ci: normalize(snapshot.ci), review: normalize(snapshot.review) };
}

function versionedEvidence(entry: NonNullable<GitHubEvidenceSnapshot["snapshot"]> | NonNullable<GitHubEvidenceSnapshot["ci"]> | NonNullable<GitHubEvidenceSnapshot["review"]>, kind: Evidence["kind"], generation: number): Evidence {
  const version = `${generation}:${entry.id}:${entry.payload_hash}:${freshnessKey(entry.freshness)}`;
  return { ...entry, id: `github:${kind}:${hash(version)}`, kind, source: "github:recorded-read-only", status: "active" };
}

function evidenceConflict(record: DurableControllerRecord, incoming: Evidence[]): boolean {
  return incoming.some((item) => {
    const existing = record.evidence.find((candidate) => candidate.status === "active" && evidenceIdentity(record.generation, candidate) === evidenceIdentity(record.generation, item));
    return Boolean(existing && (existing.payload_hash !== item.payload_hash || evidenceReceipt(existing) !== evidenceReceipt(item)));
  });
}

/** The provider's immutable ref names an evidence receipt; payload and receipt fields must not rewrite it. */
function evidenceIdentity(generation: number, evidence: Evidence): string {
  return `${generation}:${evidence.kind}:${evidence.source}:${evidence.immutable_ref}:${evidence.freshness ? freshnessKey(evidence.freshness) : "none"}`;
}
function evidenceReceipt(evidence: Evidence): string {
  return JSON.stringify({ observed_at: evidence.observed_at, conclusion: evidence.conclusion, expired: evidence.expired });
}

function localEvidence(record: DurableControllerRecord, id: string, observedAt: string): Evidence {
  return { id: `${record.delivery_id}:${id}:${hash(observedAt)}`, kind: "result", source: "controller:local-store", immutable_ref: id, payload_hash: hash(`${record.delivery_id}:${id}:${observedAt}`), status: "active", observed_at: observedAt };
}

function receiptEvidence(record: DurableControllerRecord, kind: string, receipt: RuntimeReceipt, observedAt: string): Evidence {
  const identity = receipt.receipt_id!;
  return { id: `${record.delivery_id}:${record.generation}:${kind}:${hash(identity)}`, kind: "result", source: "runtime:recorded-read-only", immutable_ref: identity, payload_hash: hash(JSON.stringify(receipt)), status: "active", observed_at: observedAt };
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

function matchesLease(record: DurableControllerRecord, task: { task_id?: string; lease_id?: string; runtime_id?: string; runtime_identity?: string; lease_fencing_token?: string; lease_expires_at?: string }): boolean {
  return Boolean(record.active_lease_id && task.task_id && record.active_task_ids.includes(task.task_id) && task.lease_id === record.active_lease_id && task.runtime_id === record.active_runtime_id && task.runtime_identity === record.active_runtime_identity && task.lease_fencing_token === record.active_lease_fencing_token && task.lease_expires_at === record.active_lease_expires_at);
}
function receiptIsUsable(record: DurableControllerRecord, task: RuntimeTaskSnapshot, receipt: RuntimeReceipt | undefined, heartbeatAt: string | undefined, now: string, expectedState: "running" | "completed" | "failed"): boolean {
  return Boolean(receipt?.receipt_id && receipt.delivery_id === record.delivery_id && receipt.generation === record.generation && receipt.task_id === task.task_id && receipt.expected_state === expectedState && receipt.observed_at && heartbeatAt && validFreshTimestamp(heartbeatAt, now, HEARTBEAT_MS) && validFreshTimestamp(receipt.observed_at, now, HEARTBEAT_MS) && time(receipt.observed_at) >= time(heartbeatAt) && matchesLease(record, task) && matchesLease(record, receipt) && receipt.task_id === task.task_id && record.active_lease_expires_at && time(record.active_lease_expires_at) > time(now));
}
function terminalReceiptIsUsable(record: DurableControllerRecord, task: RuntimeTaskSnapshot, heartbeatAt: string | undefined, now: string): boolean {
  const expected = task.state === "completed" ? "completed" : task.state === "failed" ? "failed" : undefined;
  const receipt: RuntimeTerminalReceipt | undefined = task.terminal_receipt;
  return Boolean(expected && task.result === expected && receipt?.result === expected && receiptIsUsable(record, task, receipt, heartbeatAt, now, expected));
}
function isClean(freshness: Freshness): boolean { return freshness.merge_state_status.toLowerCase() === "clean"; }
function sameFreshness(a: Freshness, b: Freshness): boolean { return a.head_sha === b.head_sha && a.base_sha === b.base_sha && a.merge_state_status.toLowerCase() === b.merge_state_status.toLowerCase(); }
function stale(observed: string, now: string, max: number): boolean { return !validFreshTimestamp(observed, now, max); }
function validFreshTimestamp(observed: string, now: string, max: number): boolean { return Number.isFinite(time(observed)) && Number.isFinite(time(now)) && time(observed) <= time(now) && time(now) - time(observed) <= max; }
function validFutureTimestamp(value: string | undefined, now: string): boolean { return Boolean(value && Number.isFinite(time(value)) && Number.isFinite(time(now)) && time(value) > time(now)); }
function freshnessKey(value: Freshness): string { return `${value.head_sha}:${value.base_sha}:${value.merge_state_status.toLowerCase()}`; }
function time(value: string): number { return Date.parse(value); }
function hash(value: string): string { let result = 2166136261; for (let i = 0; i < value.length; i += 1) result = Math.imul(result ^ value.charCodeAt(i), 16777619); return (result >>> 0).toString(16); }

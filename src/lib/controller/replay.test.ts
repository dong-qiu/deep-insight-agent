import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createControllerRecord, freshnessHash, readyBundleHash, replay, replayJsonl, type ReplayInputEvent } from "./replay.js";

const fixture = (name: string) => replayJsonl(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("controller dry-run replay", () => {
  it("keeps unconfirmed offline scheduling at zero attempts", () => {
    const result = fixture("runtime-offline-before-lease.jsonl");
    expect(result.record).toMatchObject({ state: "waiting_for_runtime", attempt_count: 0, started_count: 0 });
    expect(result.record.notifications).toHaveLength(1);
    expect(result.invariants).toEqual({ ok: true, failures: [], external_effects: false });
  });

  it("does not charge an interrupted started task and requires a new lease", () => {
    const result = fixture("runtime-interrupted-after-start.jsonl");
    expect(result.record).toMatchObject({ state: "waiting_for_runtime", attempt_count: 0, started_count: 0, checkpoint_ref: "checkpoint-redacted" });
    expect(result.record.active_lease_id).toBeUndefined();
  });

  it("escalates a persistent offline incident without consuming an attempt", () => {
    const result = replay([
      { event_id: "offline-1", kind: "runtime_offline", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["heartbeat-missing"], expected_generation: 0 },
      { event_id: "offline-2", kind: "runtime_offline", occurred_at: "2026-09-01T00:30:00.000Z", evidence_refs: ["heartbeat-missing"], expected_generation: 0 },
    ], { kind: "fixture", delivery_id: "delivery-offline-escalation", clock: "2026-09-01T00:31:00.000Z", state: "waiting_for_runtime" });
    expect(result.record).toMatchObject({ state: "awaiting_human_decision", attempt_count: 0 });
    expect(result.record.notifications.filter((plan) => plan.signal === "offline")).toHaveLength(2);
  });

  it("dedupes duplicate and old-generation events without duplicate plans", () => {
    const result = fixture("duplicate-and-out-of-order.jsonl");
    expect(result.record.attempt_count).toBe(1);
    expect(result.record.transitions.filter((event) => event.event_id === "result-1")).toHaveLength(1);
    expect(result.record.notifications.filter((plan) => plan.signal === "offline")).toHaveLength(1);
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "result-1", kind: "replayed_event" }),
      expect.objectContaining({ event_id: "old-result", kind: "stale_event" }),
    ]));
  });

  it.each([
    "base-changes-after-approval.jsonl",
    "head-changes-after-approval.jsonl",
    "merge-state-changes-after-approval.jsonl",
    "merge-state-unknown-after-approval.jsonl",
  ])("invalidates all approval evidence when freshness changes: %s", (name) => {
    const result = fixture(name);
    expect(result.record.generation).toBe(1);
    expect(result.record.state).toBe("freshness_invalidated");
    expect(result.record.evidence.filter((evidence) => evidence.kind === "ci" || evidence.kind === "review").every((evidence) => evidence.status === "superseded")).toBe(true);
    expect(result.record.notifications.filter((plan) => plan.signal === "invalidation")).toHaveLength(1);
    expect(result.record.transitions.some((event) => event.to_state === "ready_for_human_review")).toBe(false);
  });

  it("accepts ready only for matching clean CI and review evidence", () => {
    const result = fixture("ready-with-current-evidence.jsonl");
    expect(result.record.state).toBe("ready_for_human_review");
    expect(result.record.ready_bundle).toMatchObject({
      generation: 0,
      freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" },
      snapshot_evidence_ref: "snapshot",
      ci_evidence_ref: "ci",
      review_evidence_ref: "review",
      snapshot_evidence: { source: "fixture:snapshot", immutable_ref: "snapshot", payload_hash: expect.any(String) },
      ci_evidence: { source: "fixture:ci", immutable_ref: "ci", payload_hash: expect.any(String) },
      review_evidence: { source: "fixture:review", immutable_ref: "review", payload_hash: expect.any(String) },
    });
    const ready = result.record.notifications.filter((plan) => plan.signal === "ready");
    const freshness = { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" };
    const readyKey = `delivery-ready:0:ready:${freshnessHash(freshness)}:${result.record.ready_bundle!.hash}`;
    expect(ready).toEqual([expect.objectContaining({ dedupe_key: readyKey })]);
    expect(result.record.transitions).toContainEqual(expect.objectContaining({
      event_id: "ready-1",
      idempotency_key: readyKey,
    }));

    const jsonl = readFileSync(new URL("./fixtures/ready-with-current-evidence.jsonl", import.meta.url), "utf8").trim();
    const duplicateReadyEvent = jsonl.split("\n").at(-1)!;
    const replayed = replayJsonl(`${jsonl}\n${duplicateReadyEvent}`);
    expect(replayed.record.notifications.filter((plan) => plan.signal === "ready")).toEqual([
      expect.objectContaining({ dedupe_key: readyKey }),
    ]);
  });

  it.each([
    ["stale", "stale-snapshot-after-ready.jsonl", "authoritative_freshness_changed_or_unknown"],
    ["expired", "expired-snapshot-after-ready.jsonl", "authoritative_snapshot_expired"],
    ["unknown", "unknown-snapshot-after-ready.jsonl", "authoritative_freshness_changed_or_unknown"],
    ["missing", "missing-freshness-after-ready.jsonl", "freshness_unknown"],
  ])("invalidates an already-ready immutable bundle for a %s authoritative snapshot", (_case, name, cause) => {
    const result = fixture(name);
    const [bundle] = result.record.superseded_ready_bundles;
    expect(result.record).toMatchObject({ state: "freshness_invalidated", generation: 1, ready_bundle: undefined });
    expect(bundle).toMatchObject({
      generation: 0,
      freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" },
      snapshot_evidence_ref: "snapshot-clean",
      ci_evidence_ref: "ci-clean",
      review_evidence_ref: "review-clean",
    });
    expect(result.record.evidence.filter((evidence) => evidence.kind === "ci" || evidence.kind === "review").every((evidence) => evidence.status === "superseded")).toBe(true);
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ready_bundle_invalidated", reason: expect.stringContaining(bundle.hash) }),
      expect.objectContaining({ kind: "replayed_event" }),
    ]));
    expect(result.record.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: "ready", dedupe_key: `${result.record.delivery_id}:0:ready:${freshnessHash(bundle.freshness)}:${bundle.hash}` }),
      expect.objectContaining({ signal: "invalidation", dedupe_key: `${result.record.delivery_id}:1:invalidation:${freshnessHash({ head_sha: "h1", base_sha: "b1", merge_state_status: "clean" })}:${cause}` }),
    ]));
    expect(result.record.notifications.filter((plan) => plan.signal === "invalidation")).toHaveLength(1);
    expect(result.record.transitions).toContainEqual(expect.objectContaining({
      to_state: "freshness_invalidated",
      idempotency_key: `${result.record.delivery_id}:0:invalidate:${freshnessHash({ head_sha: "h1", base_sha: "b1", merge_state_status: "clean" })}:${cause}`,
    }));
  });

  it.each([
    "freshness-recovery-after-expired-ready.jsonl",
    "freshness-recovery-after-unknown-ready.jsonl",
  ])("recovers an invalidated generation only after a new clean authoritative snapshot: %s", (name) => {
    const result = fixture(name);
    expect(result.record).toMatchObject({
      state: "evidence_collecting",
      generation: 1,
      current_freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" },
      ready_bundle: undefined,
    });
    expect(result.record.evidence.filter((evidence) => evidence.freshness?.head_sha === "h1").every((evidence) => evidence.status === "superseded")).toBe(true);
    expect(result.record.transitions).toContainEqual(expect.objectContaining({
      from_state: "freshness_invalidated",
      to_state: "evidence_collecting",
      precondition: "authoritative_new_generation_snapshot",
      idempotency_key: `${result.record.delivery_id}:1:refresh:${freshnessHash({ head_sha: "h2", base_sha: "b1", merge_state_status: "clean" })}`,
    }));
  });

  it("invalidates a persisted ready bundle when a periodic recheck sees expired evidence", () => {
    const accepted = fixture("ready-with-current-evidence.jsonl").record;
    const result = replay([
      { event_id: "ready-recheck", kind: "freshness_recheck", occurred_at: "2026-09-02T00:04:00.000Z", evidence_refs: ["recheck"], expected_generation: 0 },
    ], {
      kind: "fixture",
      delivery_id: accepted.delivery_id,
      clock: "2026-09-02T00:04:00.000Z",
      state: accepted.state,
      generation: accepted.generation,
      current_freshness: accepted.current_freshness,
      evidence: accepted.evidence,
      ready_bundle: accepted.ready_bundle,
    });
    expect(result.record).toMatchObject({ state: "freshness_invalidated", generation: 1, ready_bundle: undefined });
    expect(result.record.notifications).toContainEqual(expect.objectContaining({
      signal: "invalidation",
      dedupe_key: `delivery-ready:1:invalidation:${freshnessHash({ head_sha: "h1", base_sha: "b1", merge_state_status: "clean" })}:ready_evidence_expired`,
    }));
  });

  it("fails closed when a recovered ready bundle no longer verifies against active evidence", () => {
    const accepted = fixture("ready-with-current-evidence.jsonl").record;
    const tampered = { ...accepted.ready_bundle!, hash: "00000000" };
    const result = replay([
      { event_id: "ready-recheck", kind: "freshness_recheck", occurred_at: "2026-09-01T00:04:00.000Z", evidence_refs: ["recheck"], expected_generation: 0 },
    ], {
      kind: "fixture",
      delivery_id: accepted.delivery_id,
      clock: "2026-09-01T00:06:00.000Z",
      state: accepted.state,
      generation: accepted.generation,
      current_freshness: accepted.current_freshness,
      evidence: accepted.evidence,
      ready_bundle: tampered,
    });
    expect(result.record).toMatchObject({ state: "freshness_invalidated", generation: 1, ready_bundle: undefined });
    expect(result.record.transitions).toContainEqual(expect.objectContaining({
      idempotency_key: `delivery-ready:0:invalidate:${freshnessHash({ head_sha: "h1", base_sha: "b1", merge_state_status: "clean" })}:ready_bundle_unverifiable`,
    }));
  });

  it("fails closed when a recovered bundle's public evidence ref is changed with a recomputed hash", () => {
    const accepted = fixture("ready-with-current-evidence.jsonl").record;
    const changedRef = { ...accepted.ready_bundle!, ci_evidence_ref: "ci-other", hash: "" };
    const tampered = { ...changedRef, hash: readyBundleHash(changedRef) };
    const result = replay([
      { event_id: "ready-recheck", kind: "freshness_recheck", occurred_at: "2026-09-01T00:04:00.000Z", evidence_refs: ["recheck"], expected_generation: 0 },
    ], {
      kind: "fixture",
      delivery_id: accepted.delivery_id,
      clock: "2026-09-01T00:06:00.000Z",
      state: accepted.state,
      generation: accepted.generation,
      current_freshness: accepted.current_freshness,
      evidence: accepted.evidence,
      ready_bundle: tampered,
    });
    expect(result.record.audit).toContainEqual(expect.objectContaining({
      event_id: "ready-recheck",
      kind: "ready_bundle_invalidated",
      reason: expect.stringContaining("ready_bundle_unverifiable"),
    }));
  });

  it("derives evidence expiry from the fixture clock and rejects foreign events", () => {
    const result = replay([
      { event_id: "current", kind: "snapshot", occurred_at: "2026-09-01T23:55:00.000Z", evidence_refs: ["current"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "foreign", delivery_id: "other-delivery", kind: "snapshot", occurred_at: "2026-09-01T23:55:00.000Z", evidence_refs: ["foreign"], expected_generation: 0, freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "ci", kind: "ci", occurred_at: "2026-08-31T23:59:00.000Z", evidence_refs: ["ci"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "passed", expired: false },
      { event_id: "review", kind: "review", occurred_at: "2026-09-01T23:56:00.000Z", evidence_refs: ["review"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "approved" },
      { event_id: "ready", kind: "evaluate_ready", occurred_at: "2026-09-01T23:57:00.000Z", evidence_refs: ["bundle"], expected_generation: 0 },
    ], { kind: "fixture", delivery_id: "delivery-current", clock: "2026-09-02T00:00:00.000Z", state: "evidence_collecting", active_lease_id: "unused" });
    expect(result.record.state).toBe("evidence_collecting");
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "foreign", kind: "stale_event", reason: "delivery_id_mismatch" }),
      expect.objectContaining({ event_id: "ready", kind: "invalid_transition" }),
    ]));
  });

  it("returns to evidence collection only after a new authoritative snapshot", () => {
    const result = replay([
      { event_id: "result", kind: "result", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["result"], expected_generation: 0, lease_id: "l1", runtime_id: "runtime-1", result: "completed", freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "initial", kind: "snapshot", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["s1"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "changed", kind: "snapshot", occurred_at: "2026-09-01T00:01:00.000Z", evidence_refs: ["s2"], expected_generation: 0, freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "confirmed", kind: "snapshot", occurred_at: "2026-09-01T00:02:00.000Z", evidence_refs: ["s2-confirmed"], expected_generation: 1, freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" } },
    ], { kind: "fixture", delivery_id: "delivery-refresh", clock: "2026-09-01T00:03:00.000Z", state: "executing", active_lease_id: "l1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });
    expect(result.record).toMatchObject({ state: "evidence_collecting", generation: 1 });
  });

  it("escalates after two repair rounds and never dispatches a third", () => {
    const result = fixture("repair-exhaustion.jsonl");
    expect(result.record).toMatchObject({ state: "awaiting_human_decision", repair_round: 2, attempt_count: 3 });
    expect(result.record.transitions.filter((event) => event.event_id === "repair-dispatch-3")).toHaveLength(0);
    expect(result.record.audit).toContainEqual(expect.objectContaining({ event_id: "repair-dispatch-3", kind: "invalid_transition" }));
    expect(result.record.notifications.filter((plan) => plan.signal === "repair_exhausted")).toHaveLength(1);
  });

  it("fails closed on missing evidence, invalid edges, and multiple active tasks", () => {
    const record = createControllerRecord({ delivery_id: "delivery-test", state: "waiting_for_runtime" });
    const events: ReplayInputEvent[] = [
      { event_id: "missing", kind: "lease_confirmed", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: [], expected_generation: 0, lease_id: "l1" },
      { event_id: "multiple", kind: "task_inventory", occurred_at: "2026-09-01T00:01:00.000Z", evidence_refs: ["inventory"], expected_generation: 0, active_task_ids: ["a", "b"] },
    ];
    const result = replay(events, { kind: "fixture", delivery_id: record.delivery_id, clock: "2026-09-01T00:02:00.000Z", state: record.state });
    expect(result.record.state).toBe("awaiting_human_decision");
    expect(result.record.audit).toContainEqual(expect.objectContaining({ event_id: "missing", kind: "invalid_transition" }));
    expect(result.invariants).toMatchObject({ ok: false, failures: ["multiple_active_tasks"] });
  });

  it("fails closed when an event omits its generation fencing token", () => {
    const result = replay([
      { event_id: "unfenced", kind: "snapshot", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["snapshot"], freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } } as unknown as ReplayInputEvent,
    ], { kind: "fixture", delivery_id: "delivery-unfenced", clock: "2026-09-01T00:01:00.000Z", state: "evidence_collecting" });
    expect(result.record.current_freshness).toBeUndefined();
    expect(result.record.audit).toContainEqual(expect.objectContaining({ event_id: "unfenced", kind: "stale_event", reason: "generation_missing" }));
  });

  it("fails closed for invalid, future, and expired authoritative snapshot times", () => {
    const result = replay([
      { event_id: "invalid", kind: "snapshot", occurred_at: "not-a-time", evidence_refs: ["invalid"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "future", kind: "snapshot", occurred_at: "2026-09-01T00:21:00.000Z", evidence_refs: ["future"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "expired", kind: "snapshot", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["expired"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
    ], { kind: "fixture", delivery_id: "delivery-clock", clock: "2026-09-01T00:20:00.000Z", state: "evidence_collecting" });
    expect(result.record).toMatchObject({ state: "evidence_collecting" });
    expect(result.record.current_freshness).toBeUndefined();
    expect(result.record.evidence).toEqual([expect.objectContaining({ id: "expired", kind: "snapshot", expired: true })]);
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "invalid", reason: "event_timestamp_invalid" }),
      expect.objectContaining({ event_id: "future", reason: "event_timestamp_after_fixture_clock" }),
      expect.objectContaining({ event_id: "expired", reason: "authoritative_snapshot_expired" }),
    ]));
  });

  it("rejects missing or mismatched runtime fences without mutating execution", () => {
    const result = replay([
      { event_id: "wrong-start", kind: "started", occurred_at: "2026-09-01T00:01:00.000Z", evidence_refs: ["start"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-other" },
      { event_id: "missing-result-runtime", kind: "result", occurred_at: "2026-09-01T00:02:00.000Z", evidence_refs: ["result"], expected_generation: 0, lease_id: "lease-1", result: "completed" },
      { event_id: "wrong-result", kind: "result", occurred_at: "2026-09-01T00:03:00.000Z", evidence_refs: ["result"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-other", result: "completed" },
      { event_id: "wrong-expiry", kind: "lease_expired", occurred_at: "2026-09-01T00:10:00.000Z", evidence_refs: ["expiry"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-other" },
    ], { kind: "fixture", delivery_id: "delivery-runtime-fence", clock: "2026-09-01T00:11:00.000Z", state: "executing", active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });
    expect(result.record).toMatchObject({ state: "executing", started_count: 0, attempt_count: 0, active_lease_id: "lease-1", active_runtime_id: "runtime-1", evidence: [] });
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "wrong-start", kind: "stale_event", reason: "runtime_mismatch" }),
      expect.objectContaining({ event_id: "missing-result-runtime", kind: "stale_event", reason: "runtime_missing" }),
      expect.objectContaining({ event_id: "wrong-result", kind: "stale_event", reason: "runtime_mismatch" }),
      expect.objectContaining({ event_id: "wrong-expiry", kind: "stale_event", reason: "runtime_mismatch" }),
    ]));
  });

  it("rejects matching start and result events when the fixture clock has expired their lease", () => {
    const start = replay([
      { event_id: "late-start", kind: "started", occurred_at: "2026-09-01T00:09:00.000Z", evidence_refs: ["start"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-1" },
    ], { kind: "fixture", delivery_id: "delivery-late-start", clock: "2026-09-01T00:11:00.000Z", state: "leased", active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });
    const result = replay([
      { event_id: "late-result", kind: "result", occurred_at: "2026-09-01T00:09:00.000Z", evidence_refs: ["result"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-1", result: "completed" },
    ], { kind: "fixture", delivery_id: "delivery-late-result", clock: "2026-09-01T00:11:00.000Z", state: "executing", active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });

    expect(start.record).toMatchObject({ state: "leased", started_count: 0, attempt_count: 0, active_lease_id: "lease-1", evidence: [] });
    expect(result.record).toMatchObject({ state: "executing", started_count: 0, attempt_count: 0, active_lease_id: "lease-1", evidence: [] });
    expect(start.record.audit).toContainEqual(expect.objectContaining({ event_id: "late-start", kind: "stale_event", reason: "lease_expired" }));
    expect(result.record.audit).toContainEqual(expect.objectContaining({ event_id: "late-result", kind: "stale_event", reason: "lease_expired" }));
  });

  it.each([
    ["after", "2026-09-01T00:11:00.000Z"],
    ["at", "2026-09-01T00:10:00.000Z"],
  ])("revokes a matching lease_expired event when the fixture clock is %s its expiry", (_boundary, clock) => {
    const result = replay([
      { event_id: "expiry", kind: "lease_expired", occurred_at: "2026-09-01T00:09:00.000Z", evidence_refs: ["expiry"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-1", checkpoint_ref: "checkpoint" },
    ], { kind: "fixture", delivery_id: "delivery-expiry", clock, state: "executing", active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });

    expect(result.record).toMatchObject({ state: "waiting_for_runtime", attempt_count: 0, checkpoint_ref: "checkpoint" });
    expect(result.record.active_lease_id).toBeUndefined();
    expect(result.record.active_runtime_id).toBeUndefined();
    expect(result.record.active_lease_expires_at).toBeUndefined();
  });

  it("requires an active matching unexpired snapshot rather than result correlation freshness", () => {
    const result = replay([
      { event_id: "result", kind: "result", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["result-h1"], expected_generation: 0, lease_id: "lease-1", runtime_id: "runtime-1", result: "completed", freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "snapshot", kind: "snapshot", occurred_at: "2026-09-01T00:00:00.000Z", evidence_refs: ["snapshot-h2"], expected_generation: 0, freshness: { head_sha: "h2", base_sha: "b1", merge_state_status: "clean" } },
      { event_id: "ci", kind: "ci", occurred_at: "2026-09-01T00:01:00.000Z", evidence_refs: ["ci-h1"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "passed" },
      { event_id: "review", kind: "review", occurred_at: "2026-09-01T00:02:00.000Z", evidence_refs: ["review-h1"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "approved" },
      { event_id: "ready", kind: "evaluate_ready", occurred_at: "2026-09-01T00:03:00.000Z", evidence_refs: ["bundle"], expected_generation: 0 },
    ], { kind: "fixture", delivery_id: "delivery-snapshot-mismatch", clock: "2026-09-01T00:04:00.000Z", state: "executing", active_lease_id: "lease-1", active_runtime_id: "runtime-1", active_lease_expires_at: "2026-09-01T00:10:00.000Z" });
    expect(result.record.state).toBe("evidence_collecting");
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "ci", kind: "stale_event", reason: "evidence_freshness_mismatch" }),
      expect.objectContaining({ event_id: "review", kind: "stale_event", reason: "evidence_freshness_mismatch" }),
      expect.objectContaining({ event_id: "ready", kind: "invalid_transition" }),
    ]));
  });

  it("does not form a ready bundle when its authoritative snapshot is missing", () => {
    const result = replay([
      { event_id: "ci", kind: "ci", occurred_at: "2026-09-01T00:01:00.000Z", evidence_refs: ["ci"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "passed" },
      { event_id: "review", kind: "review", occurred_at: "2026-09-01T00:02:00.000Z", evidence_refs: ["review"], expected_generation: 0, freshness: { head_sha: "h1", base_sha: "b1", merge_state_status: "clean" }, conclusion: "approved" },
      { event_id: "ready", kind: "evaluate_ready", occurred_at: "2026-09-01T00:03:00.000Z", evidence_refs: ["bundle"], expected_generation: 0 },
    ], { kind: "fixture", delivery_id: "delivery-snapshot-missing", clock: "2026-09-01T00:04:00.000Z", state: "evidence_collecting" });
    expect(result.record).toMatchObject({ state: "evidence_collecting", evidence: [] });
    expect(result.record.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "ci", kind: "stale_event", reason: "evidence_freshness_mismatch" }),
      expect.objectContaining({ event_id: "review", kind: "stale_event", reason: "evidence_freshness_mismatch" }),
      expect.objectContaining({ event_id: "ready", kind: "invalid_transition" }),
    ]));
  });
});

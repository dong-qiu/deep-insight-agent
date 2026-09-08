## Controller replay dry-run
`src/lib/controller/replay.ts` is a deterministic, pure model of the Controller reliability state machine. It accepts a fixed-clock, desensitized JSONL fixture and returns the state sequence, transition/audit trace hash, notification *plans*, and invariant report. It has no adapters and cannot call Multica, GitHub, CI, runtime workers, databases, cloud services, deployments, credential stores, or notification channels.

Run the local evidence suite:

```bash
npx vitest run src/lib/controller/replay.test.ts
```

Fixtures live in `src/lib/controller/fixtures/`. Their first JSONL record fixes the delivery id, initial state, generation, and clock; every later event carries the generation fencing token it expects. A missing or mismatched token is audited as stale and cannot change state. Every accepted transition records its model `writer`, precondition, idempotency key, evidence references, and recovery action. `writer` is fixture/model provenance only: it never claims that a real authorization, conditional write, or external action occurred.

The lease fixtures require a fixed-clock heartbeat age check (at most 90 seconds), runtime identity, and a `lease_fencing_token` for confirmation and all matching lease events. A matching lease event uses its own `heartbeat_at` when present, otherwise the last accepted lease heartbeat; missing, stale, or reversed observations are rejected without state mutation. The model counts consecutive lease losses and escalates the third to `awaiting_human_decision` without increasing attempts; its escalation transition has a deterministic derived event ID while retaining the source event as its causal ID. `human_boundary` fixtures for conflict, permission/credential, and production requests fail closed into the same human boundary and explicitly model no external operation.

Notification output is likewise a deterministic plan, not a delivery: each plan has a signal-specific dedupe key, audit fields, and a 5/15-minute retry policy with `external_delivery: false`. Invalidation records old/new freshness, trigger, superseded evidence IDs, and snapshot ID; ready records freshness, bundle ID, and acceptance; repair exhaustion records round/cause/attempt/evidence/next action; human escalation records reason/evidence/freshness/acceptance. It contains no recipient, channel, provider receipt, or scheduler integration. The included scenarios cover unconfirmed offline work, interrupted work, duplicate/out-of-order delivery, lease heartbeats/fences/loss escalation, human boundaries, notification-plan dedupe, head/base/merge freshness changes, clean matching ready evidence, and two-round repair exhaustion.

This is model-level replay evidence only. It proves reducer, idempotency, freshness invalidation, task-cardinality checks, lease-envelope and human-boundary decisions, and notification-plan deduplication for the supplied inputs. It does **not** prove actual Multica or GitHub integration, exactly-once conditional storage writes, webhook delivery, provider receipts, external notification delivery, real runtime lease behavior, or AC9 integration proof. Those need an explicitly authorized integration stage.

## INSI-155 local persistence boundary

`src/lib/controller/store.ts` is a separate Node-only SQLite `ControllerStore`. It requires an explicit local file path, rejects `:memory:` and never reads `DB_PATH`, so it cannot attach to the application's live SQLite database or another worktree's store. The store atomically records compare-and-append state, transition/evidence audit rows and deterministic local notification outbox plans. A persisted `pending_invalidation` fence makes every acceptance predicate fail closed; restart recovery freezes the delivery for a human rather than guessing freshness.

`src/lib/controller/reconciler.ts` consumes only injected `RuntimeSnapshotPort` and `GitHubEvidencePort` reads. Its tests use recorded/fake snapshots and a capability-denied transport. This implementation neither creates/cancels/revokes tasks or leases, nor calls GitHub mutations, webhooks, CI/review mutations, credentials/IAM, merge/deploy, or notification delivery. Real Multica/GitHub sandbox integration, webhook ingress, and recipient/channel delivery remain out of scope.

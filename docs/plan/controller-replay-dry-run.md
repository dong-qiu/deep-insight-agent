## Controller replay dry-run
`src/lib/controller/replay.ts` is a deterministic, pure model of the Controller reliability state machine. It accepts a fixed-clock, desensitized JSONL fixture and returns the state sequence, transition/audit trace hash, notification *plans*, and invariant report. It has no adapters and cannot call Multica, GitHub, CI, runtime workers, databases, cloud services, deployments, credential stores, or notification channels.

Run the local evidence suite:

```bash
npx vitest run src/lib/controller/replay.test.ts
```

Fixtures live in `src/lib/controller/fixtures/`. Their first JSONL record fixes the delivery id, initial state, generation, and clock; every later event carries the generation fencing token it expects. A missing or mismatched token is audited as stale and cannot change state. The included scenarios cover unconfirmed offline work, interrupted work, duplicate/out-of-order delivery, head/base/merge freshness changes, clean matching ready evidence, and two-round repair exhaustion.

This is model-level replay evidence only. It proves reducer, idempotency, freshness invalidation, task-cardinality checks, and notification-plan deduplication for the supplied inputs. It does **not** prove actual Multica or GitHub integration, conditional storage writes, webhook delivery, external notification delivery, or real runtime lease behavior. Those need an explicitly authorized integration stage.

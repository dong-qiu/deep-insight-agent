# C1 synthetic recovery core

An executable, in-process prototype of the [recovery contract](../../docs/plan/specs/recovery-time-coverage.md), not a production recovery path.

Run `npx vitest run tests/c1-synthetic-recovery.test.ts tests/c1-durable-registry.test.ts tests/c1-freshness-anchor.test.ts` with Node 24.

Implemented:

- Separate Ed25519 issuer/recovery signing identities supplied by the test harness, not read from backups.
- A fresh synthetic epoch with an empty-at-origin baseline and a continuous immutable-object digest index.
- A shared in-memory commit gate: pending writes prevent freeze, freeze prevents new writes and late retries. External synthetic commits enter the index before acknowledgment, even if no business deletion follows.
- An optional independent, owner-private SQLite sidecar (`DurableSyntheticAuthority`) with explicit exclusive creation/reopen and externally supplied epoch/key identity. Signed hash-chained objects and signed head/pending/gate state are committed atomically with `BEGIN IMMEDIATE`, WAL and FULL synchronous mode. No signing keys are stored in the database.
- The persistent gate fences same-host processes and survives restart. Unknown pending intents remain pending until explicitly committed/aborted; failed commits cannot consume sequence numbers or silently clear pending. A persisted frozen checkpoint cannot be reopened for writing through this API.
- Explicit `createAnchored`/`openAnchored` additionally bind a separately controlled, independently keyed `SyntheticFreshnessAnchor`. The full signed registry state (including pending and frozen gate) is pinned, not merely the object count. Anchored registries refuse the old unanchored open API; existing registries cannot be automatically adopted or re-enrolled.
- Every anchored mutation durably reserves a transition before registry COMMIT, then finalizes under an anchor transaction lock held across that COMMIT. No token/checkpoint is returned before both commits succeed. A real process kill, registry COMMIT failure or finalize failure leaves durable uncertainty; all reads, writes, sampling, freeze and replay checks refuse it. There is no automatic repair/abort or anchor reset API. Normal concurrent callers wait for finalize, rather than misclassifying its transient interval as a permanent fault.
- Authenticated DB sampling digest/sequence and reusable checkpoint; strict UTC and numeric cutoff validation.
- Complete object/version/hash checks, real AES-GCM/HMAC verification, report-only refusal, no expiry-based skipping.
- A SQLite transaction with permanent synthetic deletion constraints and the real report/index/FTS cleanup primitive; repeat runs require an authenticated result-bound receipt.
- Memory-only DB enforcement: no `.env`, AWS, production files, CLI entry point or service startup. Experimental DDL is exported from the schema fact source but excluded from `SCHEMA_SQL` and production migration ledgers.

Boundaries:

- The original authority is in-memory; the optional sidecar is a same-host synthetic log, not a cloud publisher, cross-host gate, Object Lock or proof of production registry history. Every writer in these tests uses this API; that does not prove production CLI/admin writers are fenced. The sidecar and its private parent directory must be independently controlled, never shared with the business backup/live DB. No production adapter or gate-reopen operation exists.
- The unanchored v1 API detects partial corruption and gaps but **not** replacement by a complete older valid copy; a characterization test preserves that limitation. The anchored API detects that rollback only while the independent anchor and externally supplied trust identity remain current. Rolling back both files or giving the registry writer control of the anchor defeats this assumption. Separate test files/signing keys are a protocol fixture, not real OS/IAM permission separation or cloud monotonicity proof. Production trust, retention and all writer fencing remain prerequisites; synthetic checkpoints cannot authorize startup.
- `permanentlyHidden` is the experimental resolver. Production report redaction guards were independently merged in PR #394 (v47); this experiment neither deploys them nor migrates the old replay CLI. Production readers cannot be pointed at its restored state.
- Keys and objects are generated in tests. A trusted synthetic empty baseline does not establish any preexisting production baseline.
- No actual backup transport, S3/KMS/Secrets Manager permissions, same-image HTTP/cookie or app/worker startup acceptance is claimed. No deployment or service is started by these APIs.
- The existing old-runner KNOWN GAP characterization remains until a reviewed production migration replaces that path; these tests are safe regressions for the new isolated core, not a claim that the old CLI is fixed.

Next: independently review anchored protocol/process tests, then choose and authorize the production independent monotonic store, issuer/transport, coverage baseline and writer fencing. CLI migration and Node 24 same-image backup/auth/HTTP/startup acceptance remain separate. Unknown historical coverage stays refused; TD-09 remains incomplete.

# C1 synthetic recovery core

An executable, in-process prototype of the [recovery contract](../../docs/plan/specs/recovery-time-coverage.md), not a production recovery path.

Run `npx vitest run tests/c1-synthetic-recovery.test.ts tests/c1-durable-registry.test.ts`.

Implemented:

- Separate Ed25519 issuer/recovery signing identities supplied by the test harness, not read from backups.
- A fresh synthetic epoch with an empty-at-origin baseline and a continuous immutable-object digest index.
- A shared in-memory commit gate: pending writes prevent freeze, freeze prevents new writes and late retries. External synthetic commits enter the index before acknowledgment, even if no business deletion follows.
- An optional independent, owner-private SQLite sidecar (`DurableSyntheticAuthority`) with explicit exclusive creation/reopen and externally supplied epoch/key identity. Signed hash-chained objects and signed head/pending/gate state are committed atomically with `BEGIN IMMEDIATE`, WAL and FULL synchronous mode. No signing keys are stored in the database.
- The persistent gate fences same-host processes and survives restart. Unknown pending intents remain pending until explicitly committed/aborted; failed commits cannot consume sequence numbers or silently clear pending. A persisted frozen checkpoint cannot be reopened for writing through this API.
- Authenticated DB sampling digest/sequence and reusable checkpoint; strict UTC and numeric cutoff validation.
- Complete object/version/hash checks, real AES-GCM/HMAC verification, report-only refusal, no expiry-based skipping.
- A SQLite transaction with permanent synthetic deletion constraints and the real report/index/FTS cleanup primitive; repeat runs require an authenticated result-bound receipt.
- Memory-only DB enforcement: no `.env`, AWS, production files, CLI entry point or service startup. Experimental DDL is exported from the schema fact source but excluded from `SCHEMA_SQL` and production migration ledgers.

Boundaries:

- The original authority is in-memory; the optional sidecar is a same-host synthetic log, not a cloud publisher, cross-host gate, Object Lock or proof of production registry history. Every writer in these tests uses this API; that does not prove production CLI/admin writers are fenced. The sidecar and its private parent directory must be independently controlled, never shared with the business backup/live DB. No production adapter or gate-reopen operation exists.
- Signed head/objects detect partial corruption and gaps, but do **not** detect replacement by a complete older valid copy of the sidecar. Expected epoch/issuer supplied outside the registry detect identity substitution, not same-epoch rollback. An independent freshness/monotonic anchor and real retention/permission proof remain prerequisites for production. Do not use synthetic checkpoints to authorize production startup.
- `permanentlyHidden` is the experimental resolver. Existing production resolvers, schema and old replay CLI behavior are not migrated by this slice. Production readers cannot be pointed at its restored state.
- Keys and objects are generated in tests. A trusted synthetic empty baseline does not establish any preexisting production baseline.
- No actual backup transport, S3/KMS/Secrets Manager permissions, same-image HTTP/cookie or app/worker startup acceptance is claimed. No deployment or service is started by these APIs.
- The existing old-runner KNOWN GAP characterization remains until a reviewed production migration replaces that path; these tests are safe regressions for the new isolated core, not a claim that the old CLI is fixed.

Next: review the durable synthetic protocol and its process/restart tests, then specify the production permanent-constraint migration and resolver integration. Production issuer/transport/freshness contracts and CLI migration remain separate work before Node 24 same-image backup/auth/HTTP/startup acceptance. Unknown historical coverage stays refused; TD-09 remains incomplete.

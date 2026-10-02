# C1 synthetic recovery core

An executable, in-process prototype of the [recovery contract](../../docs/plan/specs/recovery-time-coverage.md), not a production recovery path.

Run `npx vitest run tests/c1-synthetic-recovery.test.ts`.

Implemented:

- Separate Ed25519 issuer/recovery signing identities supplied by the test harness, not read from backups.
- A fresh synthetic epoch with an empty-at-origin baseline and a continuous immutable-object digest index.
- A shared in-memory commit gate: pending writes prevent freeze, freeze prevents new writes and late retries. External synthetic commits enter the index before acknowledgment, even if no business deletion follows.
- Authenticated DB sampling digest/sequence and reusable checkpoint; strict UTC and numeric cutoff validation.
- Complete object/version/hash checks, real AES-GCM/HMAC verification, report-only refusal, no expiry-based skipping.
- A SQLite transaction with permanent synthetic deletion constraints and the real report/index/FTS cleanup primitive; repeat runs require an authenticated result-bound receipt.
- Memory-only DB enforcement: no `.env`, AWS, production files, CLI entry point or service startup. Experimental DDL is exported from the schema fact source but excluded from `SCHEMA_SQL` and production migration ledgers.

Boundaries:

- The authority is an in-process synthetic log, not a durable cloud publisher, multi-process maintenance gate or proof of production registry history. It has no restart/reopen facility; do not adapt it to production by changing a flag.
- `permanentlyHidden` is the experimental resolver. Existing production resolvers, schema and old replay CLI behavior are not migrated by this slice. Production readers cannot be pointed at its restored state.
- Keys and objects are generated in tests. A trusted synthetic empty baseline does not establish any preexisting production baseline.
- No actual backup transport, S3/KMS/Secrets Manager permissions, same-image HTTP/cookie or app/worker startup acceptance is claimed. No deployment or service is started by these APIs.
- The existing old-runner KNOWN GAP characterization remains until a reviewed production migration replaces that path; these tests are safe regressions for the new isolated core, not a claim that the old CLI is fixed.

Next: persist the authority/gate under a reviewed issuer/transport contract, specify the production permanent-constraint migration and resolver integration, then migrate the CLI and run Node 24 same-image backup/auth/HTTP/startup acceptance. Unknown historical coverage stays refused; TD-09 remains incomplete.

# Resource policy / I/O budget core v1 (P28 I1)

## Scope and owner

New standalone portable C11 library only: policy decoder, domain/task/object cookie ABI,
cumulative pre-effect byte reservations and real C tests. Dev is sole author of the six
new core/test files plus this spec, the dedicated ADR, resource Makefile and README.
No existing business source is released. No broker, FD adoption, kernel, app or runtime
integration. P27 original fourteen requirements/thirteen gates remain unchanged/unready.

## Canonical wire policy

The transport is **not** native struct serialization and is **not** arbitrary JSON input.
24-byte header: bytes0..7 ASCII `IARC0001`; bytes8..11 version1 big endian uint32;
bytes12..15 total wire size big endian uint32; bytes16..23 zero. The payload is exactly
the complete original `r3-resource-policy-v1` contract, ASCII JSON with sorted keys and
compact separators. `wire-contract.json` in the private P28 task root freezes the full
original value tree, payload size and SHA256 before C implementation. The checked-in C
literal is the same complete canonical payload; no field is discarded or defaulted.
All original plan/sheet/override, Node manifest/config hashes, limits, aliases, modes,
unsupported/descriptor/usage/device policies are preserved, including UNIMPLEMENTED I/O.

Decode rejects any missing/extra byte, version/length/reserved mismatch or noncanonical
payload (including unknown/missing/duplicate/null/float/overflow representations).
Equivalent but differently formatted JSON is deliberately rejected. No parser fallback.
An opaque canonical policy pointer is returned only on success; output is null on error.
Only that library-issued pointer can initialize a budget. This is identity, not a hash
signature, authority grant or readiness receipt.

## Budget / cookie contract

Cookies are two uint64 values, nonzero as a pair; domain, task and object cookies are
trusted adapter inputs. The core does not authenticate OS identities or defend against
a trusted C caller corrupting its context/storage directly. Context and slot storage
are caller-owned, initialized once with the documented initializer, bounded/no heap.
One domain atomic-flag lock serializes all operations. The caller must not copy/move a
live context, reinitialize its atomic object or use overlapping slot storage.

Request operation IDs are positive, strictly increasing across attempts in one domain;
the trusted dispatch layer must serialize issuance/order. Old/duplicate/out-of-order IDs
fail closed and hold the domain. This deliberately refuses unsupported request order;
it is not proof of Node workload compatibility. No finite total-event quota: completed
slots recycle with monotonically increasing slot generations. ID/generation exhaustion
holds before effect; storage exhaustion refuses before effect without resetting usage.

Device null read/write each1048576; zero and urandom read1048576, write forbidden;
stdout write1048576 and combined stdout+stderr2097152; stderr write combined2097152.
All counts aggregate the whole domain, across caller-authenticated tasks/objects.
Reserve updates all applicable buckets or none using subtract-before-add checks before
returning a ticket. Only the real adapter can ensure no effect precedes reserve.

Known completion must match domain/task/object/opID/slot/generation and actual<=reserved;
it releases only proven-unused reservation once. Unknown completion preserves the debit,
holds domain/no next or retry, and never later refunds uncertain effects. Wrong/stale,
duplicate or inconsistent settlement holds without decrementing any bucket. Existing
known reservations may settle while held for honest cleanup but cannot clear the hold.
Quota/direction/storage denial has no effect and never clears counters. Repeat init holds
instead of resetting usage. No callbacks, I/O, subprocess, OS task/FD discovery or heap.

## Acceptance

- Execute the actual compiled production decoder/budget functions, not a duplicate model.
- Strict C11 compiler warnings; fixed two-writer tests (two pthread workers plus main).
- Policy malformed length/magic/version/reserved/full payload byte mutations; independent
  numeric/hash/size expectations against the original frozen contract.
- cap-1/exact/+1, UINT64 overflow-sized request, all-or-none stdout+combined refusal,
  device direction, task/object/domain identity mismatch, duplicate/op-ID ordering,
  slot exhaustion/reuse/generation, short/unknown/double/wrong/late settlement and init.
- Tests use fixed small arrays and finite iterations; no filesystem/network/DB/subprocess
  in test binary. Build/test outputs in an owned external build root; no downloaded compiler.
- Actual compiler/SDK/linker/target/source/tests/argv/env and case counts bound before run;
  each engineering child<=120s+2s; RLIMIT_CORE=0, stdout1MiB/stderr2MiB/aggregate2MiB.
- `npm run typecheck` in this actual isolated candidate; no app build required for isolated C.
- Two fresh independent nonauthors Standards/Spec after stable candidate; at most2 rounds.

## Evidence layers / nonclaims

Source/static and actual Darwin C tests are I1 engineering evidence only. Trusted Linux
bootstrap evidence remains absent. Future actual pre-effect resource/Node probe and
business runtime are NOT_RUN. Host charged physical enforcement UNKNOWN; rlimit/RSS
observations do not sign original cgroup limits. No new original ready gate, deployment,
safe rollback, paid model, owner transfer or controller completion.

Eval-Gate: skip (new isolated C accounting library; no AI output/eval/validator/source change).

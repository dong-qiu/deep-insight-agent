# Isolated resource policy / I/O core v1

See the [spec](../docs/plan/specs/resource-policy-budget-core-v1.md) and
[ADR](../docs/develop/adr-resource-policy-budget-core-v1.md). This module performs no I/O.
It is **not an executor** and none of the original resource gates are ready.

`make -C resource BUILD_DIR=/absolute/new/owned/build/root test` compiles the real
production functions and runs25 finite test groups (two workers plus main,32 ordered
writer rounds and32 direct duplicate-writer races, sequential groups).
For the P28 evidence use the frozen direct actual-compiler command rather than relying
on PATH; toolchain/source/test/argv/environment/bounds are captured before compilation.
Never reuse a live context or slots across domains, copy/move the atomic context, or
reuse a domain cookie across lifetimes. Cookies must come from a trusted authenticating
adapter, which is not implemented here. Use `IO_DOMAIN_V1_INITIALIZER` once.

The contiguous attempt-ID contract starts1 and rejects gaps/replays/order errors/wrap.
Valid quota/direction/storage denials consume their attempt number, not bytes/slots.
Known-unused bytes may be released once; unknown effects permanently quarantine this
in-memory domain with no refund/retry. Inconsistent actual>reserved permanently poisons
that reservation too: later same-ticket known0 cannot refund/recycle it; honest known
cleanup is only for other unpoisoned reservations and never clears hold.
Crash persistence and OS effect ordering are
separate future requirements, not supplied by this library.

The wire decoder intentionally accepts one exact canonical policy value tree only,
including all original policy hashes/limits/unsupported flags. Extra JSON formatting or
fields are rejected. A policy handle is not a signed authority or readiness receipt.

Darwin C tests and repository typechecking do not prove Linux ABI, kernel/cgroup charged
peak, lossless task lifetime, original Node probe, application integration or deployment.

## Linux engineering CI (P29)

Full-scope GitHub CI compiles these actual production sources with installed GCC and
Clang, strict C11 warnings-as-errors, then runs all25 groups (32 ordered and32 direct
duplicate-writer rounds per binary). Both matrix lanes must succeed in the existing
required `typecheck · test · build` aggregate; failure/cancellation/skipping a full-scope
lane fails that gate. Documentation-only scope skips this lane, not the existing docs gate.

`python3 -B resource/ci_runner_v1.py run --compiler gcc --output /absolute/new/output`
requires Linux and a new output directory. Each phase records tool/source identity,
argv/environment, real exit/wait/two EOFs and bounded raw streams. Evidence uploads even
on failure; prior files are never overwritten. Children have120s+2s termination grace,
core dumps disabled, stdout1MiB/stderr2MiB/combined2MiB, observed owned build cap64MiB.
This is trusted engineering supervision, not original physical memory/disk/cgroup proof.
The runner records GitHub ImageOS/ImageVersion/runner OS+arch, compiler-selected linker
query and bytes/version before compilation, and actual linker version from the link.
Before the C binary runs, ELF PT_INTERP and `ldd` dependency resolution bind the loader,
libc and other file dependencies by resolved path/hash. vDSO is explicitly virtual with
no invented disk hash; this is not full process-map attestation. Required identity gaps
are recorded as UNKNOWN and fail the engineering lane. File identities are rechecked.

`python3 -B resource/ci_runner_v1_test.py` uses clearly separate supervisor fixtures to
test compile/test nonzero, timeout/output caps, raw preservation and fail-closed aggregate
decisions. These fixtures do not stand in for the production C tests in either lane.

## Pending lifetime journal (P30)

The separate [lifetime protocol](../docs/plan/specs/resource-lifetime-journal-v1.md)
and [ADR](../docs/develop/adr-resource-lifetime-journal-v1.md) add a bounded pending
journal and real private-file durable receiver. Only reported waitable-one-exec lifecycle
shapes are supported. Birth and terminal capacity are reserved together, and slots are
reused only after full terminal reports plus actual receiver write/fsync. A caller ACK
boolean cannot grant reuse. Real kernel identity/prebirth and per-run charge adapters are
still absent; this component does not make any original readiness gate true.

`make -C resource BUILD_DIR=/absolute/new/owned/root test-lifetime` runs29 unwrapped
positive/protocol groups (including64 sequential reuses and32 two-contender rounds) and
7 separate negative-only syscall-fault/concurrency groups. Each invocation requires new
fixture directories. The negative build is not positive durable-storage proof. Full CI
runs both builds with GCC and Clang inside the existing mandatory C matrix, retaining
raw results and actual receipt bytes. No original Node/VM/business database is executed.

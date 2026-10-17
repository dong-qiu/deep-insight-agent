# Isolated resource policy / I/O core v1

See the [spec](../docs/plan/specs/resource-policy-budget-core-v1.md) and
[ADR](../docs/develop/adr-resource-policy-budget-core-v1.md). This module performs no I/O.
It is **not an executor** and none of the original resource gates are ready.

`make -C resource BUILD_DIR=/absolute/new/owned/build/root test` compiles the real
production functions and runs21 finite test groups (two workers plus main,32 rounds).
For the P28 evidence use the frozen direct actual-compiler command rather than relying
on PATH; toolchain/source/test/argv/environment/bounds are captured before compilation.
Never reuse a live context or slots across domains, copy/move the atomic context, or
reuse a domain cookie across lifetimes. Cookies must come from a trusted authenticating
adapter, which is not implemented here. Use `IO_DOMAIN_V1_INITIALIZER` once.

The strict increasing operation-ID contract rejects duplicates/out-of-order requests.
Known-unused bytes may be released once; unknown effects permanently quarantine this
in-memory domain with no refund/retry. Crash persistence and OS effect ordering are
separate future requirements, not supplied by this library.

The wire decoder intentionally accepts one exact canonical policy value tree only,
including all original policy hashes/limits/unsupported flags. Extra JSON formatting or
fields are rejected. A policy handle is not a signed authority or readiness receipt.

Darwin C tests and repository typechecking do not prove Linux ABI, kernel/cgroup charged
peak, lossless task lifetime, original Node probe, application integration or deployment.

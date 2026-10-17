# P28 I1: isolated canonical policy and cumulative I/O core

Status: engineering implementation only; no executor admission. Dedicated new ADR is
authorized because existing decisions.md/business files remain owned elsewhere.

Choose a closed canonical byte envelope rather than a new permissive JSON parser or C
struct wire image. It preserves the complete original policy and rejects every alternate
representation. A library-issued opaque policy prevents caller-selected limits. It does
not authenticate an untrusted environment or release the original UNIMPLEMENTED gate.

Use caller-owned fixed storage and one C11 atomic lock per domain. Subtract-before-add
checks and atomic multi-bucket reservation prevent local counter overflow/partial debit.
Tickets bind domain/task/object/opID/slot-generation, with monotonically ordered caller
IDs. Completed slots recycle; unknown effects hold debit and quarantine without retry.
The trusted adapter must order IDs and authenticate actual identity/effect ordering. The
core is not a security boundary against memory corruption by that caller.

Known settlement can clean up while held but cannot unlock. Repeat init never resets an
active domain. Any future persistence/adapter/kernel or identity adoption is a separate
design and implementation window; this in-memory core does not claim crash durability.

Keep three proof layers separate: actual C source/unit evidence now; actual trusted
Linux bootstrap not present; real resource/probe/business corroboration NOT_RUN. A fixed
counter unit test is not the minimum genuine backend slice. Original P05/P07 charge and
no-loss lifetime blockers remain. No guessed margin or unmetered prepare-child exception.

This module has no application imports, callbacks, heap, I/O or mutable policy knobs.
Application integration, shared architecture changes and existing file ownership remain
unreleased. Normal engineering compiler/typecheck authority comes from the new P28 order,
not from an assertion that the old untrusted resource gate became ready.

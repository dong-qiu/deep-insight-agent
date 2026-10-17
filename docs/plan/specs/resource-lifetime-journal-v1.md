# Pending lifetime journal v1

## Component boundary

This is an in-memory, bounded pending journal plus a real private-file durable receiver.
It does not authenticate kernel tasks, namespace identities, tracer waits or real-parent
reaps. Those are explicit prerequisites of a future adapter. Cookies are opaque reported
identities, NOT kernel credentials. Original task/thread cap16, all other original policy
fields and all13 readiness gates remain unchanged/unready. Caller storage and all receiver
bytes/page-cache/FD/kernel allocations need actual per-run charge ownership before any
original execution. Fixed C arrays are not a memory/cgroup proof. No crash/restart reopen.

## Supported shape and obligations

Only a waitable child with one successful exec is supported. Nonwaitable/auto-reap,
nonleader exec, group-stop, reparent and unknown shapes quarantine instead of invented
parent ACKs. An external authenticated prebirth adapter must reserve before creation.
The component reserves two256-byte record units together, birth and terminal, in a fixed
caller-owned slot (at most16 pending slots). Intermediate reports remain in fixed fields.
There is no total sequential-birth quota: known fully ACKed slots recycle with new birth
IDs/generations. ID/generation/offset representation exhaustion holds before reuse.

Birth, exec and exit are ordered. After exit, kernel release, tracer wait and actual
real-parent reap are independent required reports and may arrive in either order. Every
report has a contiguous per-ticket ordinal and matching observer/tracer/parent cookie.
Duplicates, gaps, wrong/stale/cross-domain identities and unsupported events hold/no-next.
Known-no-birth cancellation has its own terminal shape and still needs durable receiver
ACK. Unknown birth never becomes cancellation. Exit/cgroup-empty/kill alone never frees.
Fullness is known pre-effect backpressure, not record dropping. Missing obligations on an
attempted finalization quarantine; legitimate still-pending state is not fabricated ACK.

## Durable ACK and concurrency

No caller-supplied ACK boolean exists. Flush reserves one in-flight intent under the core
atomic mutation lock, pins the exact ticket/generation and preallocated bytes, unlocks,
then performs actual append/write and fsync. It commits slot reuse only after known full
write+fsync and matching unchanged intent. No filesystem I/O runs under the core lock.
An invalid concurrent report may quarantine but cannot mutate the pinned bytes or grant
reuse. Unknown sibling reports do not erase honest cleanup, and no cleanup clears hold.

Receiver creation uses an exclusive new0600 regular file under caller's private0700 owned
directory. It retains the original live FD plus a private duplicate guard of the same
open-file description, owner PID, device/inode, flags, size and position. Checks and a
seek-coupling probe reject a replaced/reopened description before append. Creation syncs
file and directory; each512-byte birth+terminal receipt requires actual full write+fsync.
Short/EINTR/error, changed FD, partial write or fsync uncertainty poison receiver/domain;
no retry, overwrite, refund or next birth. Receiver append bytes grow and are explicitly
per-run attributed; this is not a trusted-infrastructure exemption or scratch64 proof.

## Finite validation

Actual production C functions, GCC/Clang strict C11, existing IO regressions unchanged.
Cover capacity cap-1/exact/+1, two reserve contenders, full lifecycle/real receiver,
no-birth/unknown birth, missing/wrong obligations, report order/duplicates/stale/cross-domain,
wrap, reuse only after ACK, honest sibling cleanup while held, and sequential cycles
exceeding pending capacity. Positive durable tests use unwrapped real OS write/fsync.
An explicitly separate negative-only syscall-fault build tests real partial writes and
injected EINTR/error/fsync failure; it never substitutes for positive durable proof.
Fixtures/files/outputs are newly owned and bounded; no original Node/probe/VM/business DB.
Test events are explicitly adapter-report fixtures, not forged kernel certificates.

Eval-Gate: skip (isolated C journal/receiver and tests; no AI output semantics change).

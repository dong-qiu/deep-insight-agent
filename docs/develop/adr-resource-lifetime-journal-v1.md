# ADR: bounded pending journal and synchronous durable receiver

Choose bounded pending/backpressure, not a postbirth overwrite ring or a cumulative
birth quota. Reserve birth AND mandatory terminal capacity before eligibility. Keep
exit, release, tracer observation, parent reap and receiver ACK distinct; support only
explicit waitable-one-exec shape and refuse other shapes. Authentication/charged memory
and restart recovery remain prerequisites, not consequences of this component.

Choose in-flight intent/unlocked real I/O/fenced commit. No user callback or ACK boolean
can stand in for write+fsync. Receiver owns one original live open-file description and
private duplicate guard; FD/record/ticket drift or unknown I/O holds without retry/reuse.
Full known completion may release only its own slot and cannot clear domain quarantine.
Append persistence is genuine but does not prove lossless controller crash recovery,
bounded physical allocation, an original Linux task graph or original qualification.

See [protocol and acceptance](../plan/specs/resource-lifetime-journal-v1.md).

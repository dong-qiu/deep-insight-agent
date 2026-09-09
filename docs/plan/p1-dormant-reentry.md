# P1 Dormant Lifecycle and Re-entry

## Current record

- Lifecycle: `dormant`
- Product decision: P0 fulfils the current traceability and auditability scope.
- Production admission: not granted. Existing anchor, dashboard and deploy guards remain fail-closed.
- Code boundary: P0 injects `NOOP_P1_TELEMETRY_SINK`; only non-production `P1_LIFECYCLE=dev` composes the SQLite telemetry adapter.

## Re-entry checklist

Do not treat this document or `P1_LIFECYCLE` as authorization. Before starting a new P1 delivery, create a scoped parent task and record:

1. Product outcome, non-goals, owner, acceptance criteria, and affected P1 seams.
2. Whether the change affects P0 or shared code; if so, require P0 equivalence tests and the complete P1 integrity/capacity/vector suite.
3. For `P1-dev`, use only task-local SQLite and synthetic/licensed fixtures. No production data, credentials, deployment, or external endpoint enablement.
4. Before any production admission, obtain the separate INSI-25 governance evidence for retention/legal hold, Object Lock, KMS/IAM, signing, on-call, baseline and recovery rehearsal; then add an explicit ADR and container-level admission tests.

## Required verification

- P0 collection, analysis, validation and report publication behavior remains unchanged.
- Dormant runs add no rows to `funnel_event`, `cost_ledger`, `validator_result_fact`, `dashboard_trace_fact_v1`, or `dashboard_cost_fact_v1`.
- External P1 dashboard and anchor seams remain fail-closed (404/disabled) in the production image.
- A P1 change or shared-boundary change runs the P1 integrity, capacity, vector and container-level contract gates.

# A1 v2 full-text evaluation profile — 2026-09-16

> Classification: local operational profile for controlled A1 evaluation. It is not a production-default change, a completed A1 run, a v2 lock, baseline evidence, DCP evidence, or an Eval-Gate pass.

## Fixed local configuration

| variable | value | rationale |
| --- | --- | --- |
| `ANALYZE_BATCH_CHARS` | `12000` | The full-text cohort diagnostic completed the previously failing prompt-injection topic as two deterministic chunks. |
| `VALIDATOR_THINKING` | `0` | Retains the selected relay-stable validator setting. |
| `COVERAGE_THINKING` | `0` | Keeps the independent coverage role explicitly non-thinking. |
| `VALIDATOR_BATCH` | `0` | Preserves the individually judged, fail-closed validator path. |

The local `.env.local` carries these values. It is ignored by Git and is copied only into explicitly created, isolated worktrees. `run-a1.ts` records all output-affecting values in `EvalConfig`; any resume whose effective configuration differs is rejected.

## Evidence and boundary

The local-only `t_prompt_injection` liveness diagnostic completed four full-text items with the `12000` chunk budget, two analyzer chunks, five display-safe insights and five display-coverage audits. The diagnostic observed transient analyzer connection retries that recovered; it did not weaken quote coverage, validator behavior, or failure handling.

This profile must not be silently substituted for the production default (`30000`). A production-default change requires a separate run-budget/SLO decision and ordinary review. A full controlled A1 may use this profile only after its source snapshot has become `verified_v2`, with no smoke limits, an immutable lock, and the required label receipt.

## Eval-Gate status

The source-cohort and local raw-archive handoff fixes are covered by the targeted and full repository tests recorded for this branch. The real-model diagnostic verifies only the affected liveness path. The candidate remains `candidate_pending_labels`, so no baseline comparison, DCP conclusion, or `Eval-Gate: pass` trailer is valid.

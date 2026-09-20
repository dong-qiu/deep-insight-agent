# A1 v2 analyzer liveness diagnostic — 2026-09-11

> Classification: bounded operational diagnostic only. It is **not** A1 quality evidence, a baseline comparison, DCP evidence, or a dataset-lock promotion.

## Fixed input and configuration

| field | value |
| --- | --- |
| candidate input SHA-256 | `6f77758219c21bc0c74a5abe44a5cd94b4f3c880b9bc23848f38dfead22d9a0e` |
| topic/window | `t_code_agents`, first 20 selected items |
| analyzer / validator / coverage | `claude-opus-4-7` / `claude-opus-4-8` / `claude-opus-4-6` |
| thinking | `VALIDATOR_THINKING=1`, `COVERAGE_THINKING=0` |
| analyzer batch budget | `ANALYZE_BATCH_CHARS=12000` |
| single-request timeout | `LLM_TIMEOUT_MS=120000` |
| retry diagnostic setting | `LLM_MAX_RETRIES=0`, `LLM_TRANSIENT_RETRIES=0`, `VALIDATOR_RETRIES=0` |
| diagnostic run ID | `a1-ladder-20260910180244-a4ec24e0` |

The JSON telemetry is deliberately ignored from Git. It records item-ID hashes, timing, error classes and aggregate role-call counters only; it contains no body, URL, endpoint or credential.

## Result

The 20-item input completed in 7 analyzer chunks:

- Total wall time: **1,106,598 ms** (18 m 27 s).
- Analyzer: **7 calls / 7 underlying requests / 0 failures**; per-chunk model output was **39.5–60.7 s**.
- Display coverage: **45 validator + 45 coverage calls/requests / 0 failures**; its seven chunk stages took **41.0–176.9 s**.
- Result contained 31 `display_coverage_audits` for 31 returned insights.

This completes the 4→8→12→20 liveness investigation sufficiently to distinguish the two concerns:

1. A 30k source-character batch previously reached the analyzer wall-clock limit under the 45 s diagnostic threshold. A 12k budget completed this 20-item route with the actual 120 s operational timeout and no retries.
2. The dominant total latency is not a hidden analyzer retry. It is the number of generated candidates, each of which receives independent validator and coverage review in bounded parallel waves. A single source item can generate many candidates, so input item count is not a reliable proxy for this cost.

## Decision boundary

`ANALYZE_BATCH_CHARS=12000` is an **evidence-backed candidate operational setting**, not an unreviewed production-default change. Any production configuration change must first define a run budget/SLO for the coverage stage and preserve all display-coverage gates. Do not disable validator thinking or weaken/reduce audit coverage to shorten this path.

The candidate snapshot remains `pending_source_terms_review` and `candidate_pending_labels`; this successful diagnostic must not be used to build a `verified_v2` lock or a baseline.

## Supporting implementation

The diagnostic runner now persists an in-progress rung and each completed `model_output` / `display_coverage` stage with cumulative per-role call/request telemetry. It also supports a bounded `A1_LADDER_ITEM_OFFSET` replay window without copying source bodies. Relevant commits: `238160e`, `ec6396e`, `6d47e2a`, `92e7d6b`.

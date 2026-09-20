# A1 v2 platform-topic capacity diagnostic — 2026-09-13

> Classification: bounded operational diagnostic only. It is not A1 quality evidence, a baseline
> comparison, a dataset-lock promotion, a source-terms decision or DCP evidence.

## Question

The completed five-topic automatic run produced only 2 reader-visible insights for
`t_coding_agent_platforms` (required: 10). Before changing the source pair or creating a new
controlled snapshot, test whether unused, already archived material from the same fixed pair can
plausibly close the gap.

## Bounded input

An isolated, local-only input was deterministically built from the existing fixed platform pair:

| Field | Value |
| --- | --- |
| input SHA-256 | `9a26d2d78a2b3e7ed22fee644878b8449d3625e56f276368b52aace697abd289` |
| items / sources | 60 / 2 (`src_openai_codex_releases`: 10; `src_cursor_changelog`: 50) |
| completeness | all 60 `fetch_status=ok` and carry raw archive handles |
| models | analyzer `claude-opus-4-7`; validator `claude-opus-4-8`; coverage `claude-opus-4-6` |
| thinking | validator on; coverage off |

This is a capacity probe, not an expanded source snapshot: it was not uploaded, labelled,
source-terms approved for a changed population, or used to make a lock.

## Results

1. With the ordinary retry stack and `ANALYZE_BATCH_CHARS=30000`, the first 22-item analyzer
   chunk completed but its display audit took 1,478,263 ms. Of 26 validator and 26 coverage
   logical calls, 21 in each role failed after 68 underlying requests. The following analyzer
   chunk then ended in `Connection error`.
2. The validator thinking canary immediately succeeded with forced structured tool use. Therefore
   the failure is not evidence of a missing key, invalid model selection or an unsupported
   thinking transport.
3. Repeating the same input with `LLM_MAX_RETRIES=0`, `LLM_TRANSIENT_RETRIES=0` and
   `VALIDATOR_RETRIES=0` made the first 22-item display audit complete in 137,706 ms. Its six
   primary-audit calls and five quote-self-contained calls all completed as `tool_use`; none had
   `max_tokens` or a failure. The next analyzer chunk timed out.
4. Reducing only `ANALYZE_BATCH_CHARS` to 12000 made a first 12-item model/coverage chunk succeed
   (three primary + three countercheck calls, all `tool_use`). The following six-item analyzer
   chunk still exceeded the 120,000 ms wall-clock limit.
5. That same six-item input was then replayed alone with the same bounded configuration. It
   completed in 501,961 ms: 13 insights passed display coverage and received 13 corresponding
   display-coverage audits. Its primary audit made 21 calls (20 `tool_use`, one fail-closed
   failure); 16 counterchecks all ended as `tool_use`. No phase reported `max_tokens`.

The three diagnostic artifacts have SHA-256 values
`4950f9e4d28e599afc66e1751d3694d2921c6bdf23bf255524bdb3b26669e0bb`,
`960c00a263e56ed2543b917f18f6f94ab8094cb34c0a18288b38c63a57deba89`, and
`4c0cb9627f30b66d49c81ee5f062a6fc8ecd45f1ad417695521ee6f9c4e0857f` respectively. They stay
local because their telemetry is diagnostic evidence, not a publishable evaluation artifact.

## Interpretation and boundary

The initial 24.6-minute tail was primarily retry amplification after display-audit connection
failures, not output truncation. The bounded run proves the new `by_operation` telemetry can
separate `display_quote_primary` from `display_quote_countercheck` and shows neither was at fault
in its successful first chunk. The exact six-item replay then succeeded, so the previous analyzer
timeout is an intermittent execution failure rather than a deterministic content rejection.

The 13 count is **display-safe analyzer output**, not a reader-visible/DCP count: the replay did
not invoke production `validateBatch()` or `selectInsights()`. A complete five-topic run on a
newly frozen, approved population remains necessary to learn whether all citations pass the
validator whitelist.

Do not infer that 60 inputs are insufficient, nor that they would reach 10 reader-visible insights.
The next safe prerequisite is a checkpointed full-quality run that can complete the same fixed
input without weakening thinking, quote coverage or fail-closed handling. Only after it completes
may the team decide whether to freeze an expanded candidate or add an explicitly approved platform
source.

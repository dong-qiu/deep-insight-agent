# A1 v2 formal readiness audit — 2026-09-19

> Status: **controlled human-label preparation is ready; formal v2 promotion is blocked.**
> This audit contains aggregate metadata and hashes only. It does not contain source text, excerpts,
> raw paths, labels, model output, or reviewer decisions.

## Verified controlled inputs

The replacement source population is the immutable
`a1-v2-platform-expanded-140-20260913` candidate. Its source manifest is versioned, KMS-encrypted
and protected by S3 Object Lock Compliance through 2026-12-12.

| Property | Verified value |
| --- | --- |
| Population | 140 globally de-duplicated content items, across 5 topics and 10 sources |
| Topic allocation | Four topics × 20; coding-agent-platforms × 60 |
| Raw-origin distribution | 60 article-page archives; 80 feed archives |
| Full-text source check | All 60 entries from sources configured `full_text` have `article_page` origin; no full-text entry has a feed-only origin |
| Archive binding | Every manifest entry records a raw-archive SHA-256, byte length, source-body origin, body hash and content hash; the preparer verified the archive/body/hash binding before manifest creation |
| Quality input | SHA-256 `2d62a7d31d5a38ae0ac9e1c3950209792b479bb9fb5c2695863a7b278a25b9aa`; 809,598 bytes |

This population supersedes the earlier source-incomplete cohort described in
`a1-v2-source-completeness-investigation-2026-09-12.md`. The older cohort and its pair worklist
remain historical evidence only and must not be used for formal labels, a dataset lock, DCP, or
baseline comparison.

## Prepared human-label hand-off

The formal 100-pair label-free blind worklist and two byte-identical, blank reviewer templates
exist in the controlled bucket. They are KMS-encrypted, versioned, and Object-Locked through at
least 2026-12-15. Their recorded hashes are:

| Artifact | SHA-256 |
| --- | --- |
| Blind worklist | `be0ddf243f405b648fc71fe62b4425a126e9a0d264ea326ffb6823c2d897d1cd` |
| Reviewer template 1 | `1a2f14a4861367e96ba8ca442ebd2705b99279cc53cd32838fcb40645425b21a` |
| Reviewer template 2 | `1a2f14a4861367e96ba8ca442ebd2705b99279cc53cd32838fcb40645425b21a` |

The two slots must be completed independently by two different human reviewers. Each submission
must bind its opaque reviewer ID, the fixed worklist hash and all 100 pair hashes. Only after both
submissions are frozen may a third, distinct human adjudicate exactly their disagreements.

## Formal promotion blockers

1. The existing `approved_all` owner decision is explicitly **prototype/internal only**. It is not
   the source-specific formal terms decision required for a `verified_v2` lock.
2. There are no two complete human blind submissions, no third-human adjudication, and no eligible
   human consistency-label receipt for this population.
3. The prototype AI-assisted final contains 22 actual `not_support` rows, below the formal minimum
   of 40. Its `prototype_ai_assisted` / `lock_eligible=false` receipt cannot be promoted or used to
   fill the gap.
4. Therefore no `verified_v2` dataset lock exists. Automatic A1 results against this candidate are
   pipeline evidence only, not a DCP result or comparable baseline.
5. After an eligible lock exists, two separate full A1 automatic runs must pass on the same clean
   commit, fixed model/Thinking configuration and the exact lock before a new baseline candidate
   can be evaluated.

## Current next action

On 2026-09-20, ADR-0030 selected the existing prototype-only, internal non-commercial research
scope. Formal v2 promotion and its source-specific owner decision / two-human blind-review path
are therefore deferred, not waived. The immutable worklist and source precheck remain frozen for
future re-entry; no `verified_v2` lock, baseline, DCP or release conclusion may be inferred while
this scope remains active.

## Latest internal prototype diagnostic

On 2026-09-20, run `a1-20260919191125-553e3a79` completed on the current dirty worktree using
the fixed serial configuration (`independent_call_concurrency=1`, validator thinking off, coverage
thinking off). It is retained as an internal diagnostic artifact only; its aggregate artifact
hashes are bound by the terminal manifest.

| Check | Result |
| --- | --- |
| Core completion | 5/5 quality topics; 121/121 labelled consistency pairs; no Coverage execution failures |
| Automatic threshold rows | 9/9 passed |
| Citation safety | Display unsafe accept 0/30; projection violation 0/40; quote self-contained unsafe accept 0/4 |
| Validator classifier | Accuracy 95.0%; negative recall 100%; completion 100% |
| Runtime observation | Single-judge p95 5.0 s, maximum 10.4 s; Coverage countercheck p95 5.1 s, maximum 9.6 s |
| Estimated cost | USD 5.8422 |

The terminal manifest correctly records `auto_gate=pass` but
`baseline_comparison=incomparable` and `dcp_eligibility=ineligible`. This result neither creates
an approved baseline nor relaxes any formal promotion blocker above. It is evidence that the
prototype execution path and its fail-closed coverage controls completed for this configuration.

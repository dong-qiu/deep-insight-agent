# A1 v2 source-complete prototype candidate — 2026-09-13

> Status: `candidate_pending_labels`; prototype-only, `lock_eligible=false`.

This replaces neither the old candidate nor its labels. It is a new, source-complete 100-item candidate created after the RSS-summary completeness defect was fixed.

| Item | Value |
| --- | --- |
| Snapshot ID | `a1-v2-source-complete-100-20260913` |
| Population | 100 globally deduplicated items; 5 topics × 20; 10 sources × 10 |
| Body origins | 60 `article_page`, 40 `feed` |
| Source manifest | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/candidates/a1-v2-source-complete-100-20260913/source-manifest.json?versionId=isN8_DV43DH4QrFfZKw7ERHhz3QL7qL.` |
| Source manifest SHA-256 | `ce13a3a9d82d91f5aacb986e832ef72c0c460e891400ceca348523107ea44211` |
| Prototype owner decision | `A1-V2-TERMS-PROTOTYPE-20260913-SOURCE-COMPLETE-100` · `approved_all` only for named internal prototype uses |
| Blind worklist | 100 label-free pairs; SHA-256 `8baa45b635d59de06307268eb7a00c7e3354c23f3b8896bccbc4da9014f21b2d` |
| AI-assisted disagreement worklist | 14 label-free pairs; SHA-256 `afedfc92d0d3cb7002f9b271de3abc11ca58493a83eb7d3d2ec0e56224736b02` |

The source input, raw envelopes, candidates, blind worklist and diagnostic artifacts are private, versioned, KMS-encrypted, and Object-Lock retained. This document intentionally contains no source body, excerpt, raw path, AI verdict, or human label.

## AI-assisted diagnostic only

Two distinct models reviewed the same immutable blind worklist:

- validator: `claude-opus-4-8`, `thinking=true`;
- coverage: `claude-opus-4-6`, `thinking=false`.

They disagreed on 14/100 pairs. Their comparison receipt is `prototype_ai_assisted` and permanently `lock_eligible=false`; a human adjudication remains required for every disagreement. The legacy 16-pair worklist belongs to the superseded snapshot and must not be combined with these 14 pairs.

## Source-integrity revalidation — 2026-09-13

The controlled source manifest was read back at its recorded immutable version and independently
reconstructed with `eval:prepare-controlled-v2-snapshot`. The reconstructed no-body manifest is
identical after excluding its generated-at timestamp:

| Check | Result |
| --- | --- |
| quality bytes / SHA-256 | 724,409 bytes / `a9f75b256d12c6ab0dcce7eb407b06bfbc2ae2c1a6557535a5c1691dda248f75` |
| source manifest SHA-256 | `ce13a3a9d82d91f5aacb986e832ef72c0c460e891400ceca348523107ea44211` |
| entries / topics / raw envelopes | 100 / 5 / 100; all `fetch_status=ok` |
| reconstruction comparison | equal after the volatile timestamp is removed; comparable digest `f51b63d86c07669332a979934c81b3069c9415c5a77d513174c1c64e556b619d` |
| storage retention | KMS-encrypted Object Lock Compliance through `2026-12-11T16:25:50.514Z` |

This validates source-body/archive binding and transfer integrity. It leaves the candidate status
as `candidate_pending_labels`; it is not a v2 dataset lock or a source-terms decision for a
changed snapshot.

## Automatic A1 follow-up — 2026-09-13

The earlier first-run deadline was subsequently recovered under the exact full input/configuration
through its hashed checkpoints. Run `a1-20260913113937-058b1976` completed with automatic gate
`pass` (manifest SHA-256 `b197fc08059479ace681d9e754b640631de2a12ef229227ab229677631ca24a9`; no-body
run-record SHA-256 `1f0b87bf9223401652cf1ee3c553f0644e6d209e870bf33f628d4087198d9843`).

This is useful automatic pipeline evidence only. It remains `baseline_comparison=incomparable`,
`manual_review=pending` and `dcp_eligibility=ineligible` because the legacy lock rejects the
external quality path and there is no eligible human label receipt. Its reader-visible sample was
128 total, but `t_coding_agent_platforms` produced 2/10 required insights; all other topics met
the per-topic floor. No DCP, baseline, source-terms or release conclusion follows from this run.

The prior role-level telemetry recorded two validator `max_tokens` stops but could not attribute
them to a pipeline phase. New runs now retain redaction-safe phase telemetry; the separate
[platform-capacity diagnostic](./a1-v2-platform-capacity-diagnostic-2026-09-13.md) records the
first use of that attribution.

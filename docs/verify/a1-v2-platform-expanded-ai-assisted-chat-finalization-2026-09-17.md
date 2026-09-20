# A1 v2 platform-expanded AI-assisted chat finalization — 2026-09-17

> Classification: finalized prototype-only consistency artifact. It is not a blind human adjudication, `verified_v2` lock, comparable baseline, DCP conclusion, release-quality claim, or Eval-Gate pass.

## Provenance-safe adjudication mode

Two different-model, different-role AI reviews first identified 16 disagreements in the immutable 100-pair blind worklist. The human adjudicator then explicitly requested and received independent AI advice in this conversation before deciding every disagreement. Therefore the frozen adjudication states:

```text
adjudication_mode = human_with_ai_advice
blind_attestation = false
receipt.status = prototype_ai_assisted
receipt.lock_eligible = false
```

The opaque adjudicator ID is `human-chat-adjudicator-20260917`; it does not identify the person. The new converter and finalizer were introduced in commit `eac39ca`. They are deliberately distinct from the existing blind-human commands and do not relax their `blind_attestation=true` requirement.

## Immutable artifacts

All objects below were independently read back after upload. Each has matching SHA-256, SSE-KMS, S3 versioning and S3 Compliance Object Lock through at least 2026-12-15. No third-party body, source excerpt, or user rationale is stored in this document.

| object | immutable reference | SHA-256 |
| --- | --- | --- |
| chat progress (16 user decisions) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-assisted-chat-adjudication-progress.local.json?versionId=pzep5D_5Z8p1qESiwANOANToXUnfiQN2` | `d09819e6bedc0a47f9255e05ac319dd8aa355fb34813478736d4ef2322c36022` |
| bound non-blind human adjudication | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-chat-adjudication.local.json?versionId=F6waCmQA_JXApBDTGHpRSbmgIuUBL2NG` | `ce8e17f9d59d4e62640b7ea4dd7edea7e96f8ce904cd91ba6da359bf320ee88e` |
| final 100-pair prototype labels | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/citation-consistency-v2-ai-assisted-chat-final.local.jsonl?versionId=WTY_EBgiSOzBrNZfy0nwX2gG_CigR.GG` | `6e5f64533608f3ce626ba89760bb86971ddcce81dcb3b7bc57b6ee7cf45441a1` |
| final prototype receipt | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/citation-consistency-v2-ai-assisted-chat-final-receipt.local.json?versionId=R9xRsEGXJPUwMUukGnyCWgv.DY0yX7R_` | `e43979b6ea252020708a23bab42b1a491f18dfd7ba70aac825132bd90db04b0b` |
| finalization manifest | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-assisted-chat-finalization.json?versionId=ZN3F11sRBXqQi.p5_WV0nunGnWwqLTHc` | `0b72988b7496bb35770ec538cf8c6e7ad275337ef1ceeaafb536d59e566b5821` |

## Result and limits

| label | count |
| --- | ---: |
| `support` | 73 |
| `uncertain` | 1 |
| `not_support` | 26 |
| `not_support.exaggeration` | 13 |
| `not_support.out_of_context` | 3 |
| `not_support.misattribution` | 10 |

All 100 pairs are resolved and all three negative types are represented. The artifact nevertheless fails the formal data-shape requirement because `not_support` is 26, below the required 40. Independently, two full reviewers were AI and the adjudicator received AI advice. It must remain excluded from `labels:receipt`, `verified_v2`, baseline, DCP and release-quality flows.

## Verification

- Targeted finalization/CSV tests: 8 passed.
- Full repository tests: 1586 passed.
- TypeScript 6/7 type checks and lint: passed.
- A1 was not run: `run-a1.ts` does not invoke this offline prototype-only conversion/finalization path, so an A1 run would not establish its correctness. No `Eval-Gate: pass` is claimed.

For formal v2, prepare a fresh candidate population with at least 40 actual human-confirmed `not_support` cases, then use two independent human blind submissions and a third blind human adjudicator as specified in [`a1-controlled-v2-dataset.md`](../plan/specs/a1-controlled-v2-dataset.md).

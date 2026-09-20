# A1 v2 platform-expanded AI-assisted review — 2026-09-16

> Classification: prototype-only AI-assisted consistency evidence. It is not a human-label receipt, `verified_v2` lock, baseline, DCP result, release-quality claim, or Eval-Gate pass.

## Fixed blind-review input

Both reviewers received the same 100-pair immutable blind worklist, without generator intents, labels, rationales, or the other reviewer's output:

`s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/blind-worklist.local.jsonl?versionId=a.T.3hdXCTiGrYl8dW7Zwt5__yN.kMgy`

Its SHA-256 is `be0ddf243f405b648fc71fe62b4425a126e9a0d264ea326ffb6823c2d897d1cd`; its pair-population SHA-256 is `69c58d76f129331f6db606bb9e003d675977f7ae3009377d7df12f8969f97b0a`.

| reviewer | role | model | Thinking | completed decisions | calls | cost (USD) |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `ai-validator` | `validator` | `claude-opus-4-8` | off | 100 | 20 | 0.645735 |
| `ai-coverage` | `coverage` | `claude-opus-4-6` | off | 100 | 20 | 0.500745 |

The models and roles differ. Both record the same prompt hash, worklist hash, pair-population hash, structured transport version, response-budget version and actual model configuration in their immutable submissions. A transient transport retry in the coverage review retried the same batch; it did not skip, replace, or fabricate any decision.

## Frozen prototype artifacts

All listed objects were read back after upload, matched their recorded SHA-256, use SSE-KMS, and are under S3 Compliance Object Lock through at least 2026-12-15.

| object | immutable reference | SHA-256 |
| --- | --- | --- |
| validator AI submission | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/ai-validator-review.local.json?versionId=ueJOu4pp0GNJPefe9fXzfl4Q7mZpMCPn` | `7754099e18100ba82e0fb949b99245c6b7a84ab74f1213f53b6529d33cb66955` |
| coverage AI submission | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/ai-coverage-review.local.json?versionId=Y8mepsCldEYQkaOQe0J82m7BuGnj9ix.` | `23abe562f0bcd14402b280a213257bd799b4dc12a481e263eac4b0540d6a4248` |
| comparison receipt | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/ai-comparison-receipt.local.json?versionId=WiVum.GWwJKMRDznnDDd_eC9iuN5APze` | `cd4efbaee346f31cc5891449a7dc7a27231eadb751f9f099e749ea45498c7801` |
| label-free human dispute worklist | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/ai-disputes.local.jsonl?versionId=6O3QbY_wAHVnJZFl3FGv8MB2gU8QjcEM` | `48b343926f9790c4857d7f7a7ac74c9a9461fd5401eeb5b2525c556fa5174e6f` |
| blank human adjudication CSV | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-adjudication.local.csv?versionId=DaLW6ip1DIcCCiGwvG227PtkbbLIhNwQ` | `42a793ec9076dbd45971508b61f0b6229de975dd718e1f31d92ce857a5aa0850` |
| human adjudication dispatch | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-adjudication-dispatch.json?versionId=t44vnryMYmLD.aL4KcMs20ZkuFAyXcTC` | `33e607caa767c57097ada64320225043e0f9a49ddbc4b7adc9afec10bb8144c8` |

The comparison receipt is valid `prototype_ai_assisted`, has zero structural issues, and has `lock_eligible=false`. It found 16/100 disagreements. The dispute worklist and CSV contain only `id`, pair hash, statement and source text; they do not contain either AI decision or negative type.

## Pending human action

One human adjudicator receives only the 16-row blank CSV and its accompanying source/statement evidence. They must decide every row without being shown either AI decision, filling `expected_consistency` and `negative_type` only where the result is `not_support`.

The controlled runner then converts the completed CSV with:

```bash
npm run labels:ai-dispute-to-adjudication -- \
  <ai-disputes.local.jsonl> <completed-human-adjudication.local.csv> \
  <opaque-human-adjudicator-id> <human-adjudication.local.json>
```

It will run `labels:ai-finalize` only after that 16-row human submission has been validated and frozen. The resulting receipt must retain `status: prototype_ai_assisted` and `lock_eligible: false`; it cannot be repurposed as the separate formal two-human label path prepared in [`a1-v2-formal-label-preparation-2026-09-16.md`](a1-v2-formal-label-preparation-2026-09-16.md).

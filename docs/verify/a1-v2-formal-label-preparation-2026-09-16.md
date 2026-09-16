# A1 v2 formal label preparation — 2026-09-16

> Classification: controlled preparation evidence only. This record is neither a human-label receipt nor a `verified_v2` lock, and it does not establish an A1 baseline, DCP result, or Eval-Gate pass.

## Prepared cohort

The frozen source candidate remains `a1-v2-platform-expanded-140-20260913`. This preparation selects its 100-item formal-label subset and binds it to the immutable source manifest:

`s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/candidates/a1-v2-platform-expanded-140-20260913/source-manifest.json?versionId=qTIXgZJL0I96HD4_yHo02UQ2ilPjTwha`

The selected input quality SHA-256 is `2d62a7d31d5a38ae0ac9e1c3950209792b479bb9fb5c2695863a7b278a25b9aa`.

Candidate generation ran from commit `8f2fbc7` with `LABEL_CANDIDATE_BATCH_SIZE=5`. The local checkpoint is solely a recovery mechanism for a transient model connection failure; it contains no source text and cannot publish a partial set. The completed candidate set has SHA-256 `907487cbce827978d2c22a498fc22385a9dbbf5ccd5d3915cf8355cd6b40d4e2`.

The generator planned 40 negative *intents* (15 `exaggeration`, 15 `out_of_context`, 10 `misattribution`). These are not human labels and must not be reported as actual `not_support` coverage.

## Immutable preparation objects

All preparation objects below were independently read back after upload. They use SSE-KMS and S3 Compliance Object Lock through at least 2026-12-15.

| object | immutable reference | SHA-256 | checked property |
| --- | --- | --- | --- |
| candidate set | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/candidates.local.jsonl?versionId=37W0bV9sSHWMfptTtE7gqeJ_Q4wbAtfz` | `907487cbce827978d2c22a498fc22385a9dbbf5ccd5d3915cf8355cd6b40d4e2` | 100 generated candidate records |
| candidate diagnostic | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/candidates.diagnostic.local.json?versionId=0zU88gj_6gYejXhYHzHitwxTNZb5IWsr` | `d1a99e47567824c65b61e8686a329312e0f0c8c85e2f2825caac4b485ce16fb3` | internal diagnostic; never distribute to blind reviewers |
| blind worklist | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/blind-worklist.local.jsonl?versionId=a.T.3hdXCTiGrYl8dW7Zwt5__yN.kMgy` | `be0ddf243f405b648fc71fe62b4425a126e9a0d264ea326ffb6823c2d897d1cd` | 100 unique pair hashes; no intended labels, topic, or source metadata |
| reviewer template 1 | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-reviewer-slot-1.local.csv?versionId=z0LnMpiLzx8HwcQdLQb9.dvYLIqyENUj` | `1a2f14a4861367e96ba8ca442ebd2705b99279cc53cd32838fcb40645425b21a` | 100 blank, spreadsheet-safe rows |
| reviewer template 2 | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/human-reviewer-slot-2.local.csv?versionId=5YlO28xnAjoCYwFB8fN6JVgIBXvWcYKj` | `1a2f14a4861367e96ba8ca442ebd2705b99279cc53cd32838fcb40645425b21a` | byte-identical to template 1; labels remain blank |
| reviewer dispatch | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/formal-label-preparation/a1-v2-platform-expanded-140-20260913-formal-100-20260916/reviewer-dispatch.json?versionId=5wRCJzexEu54QPnKuAHPrFmAqAg0ZByw` | `d4638d7c4c430a4303a168e8e5b81c36b46f8faf93154dbb50b05537aaeba20e` | two reviewer slots and an explicit non-promotion boundary |

## Pending human-only procedure

Status is `reviewer_submissions_pending`.

1. Give each template only to a different human reviewer. They make all 100 decisions independently and fill only `expected_consistency` and, for `not_support`, `negative_type`.
2. Each human uses `npm run labels:csv-to-submission` against the immutable blind worklist with a distinct opaque reviewer ID, then its resulting submission is frozen in the controlled bucket.
3. Freeze both submissions, calculate their disagreements, and give only those disagreements to a third, distinct human adjudicator.
4. Create and validate the human receipt. Only then may the candidate be considered for `verified_v2`; it must still satisfy the actual 40-`not_support` and subtype coverage gates.

AI-generated candidates and prototype AI-assisted labels remain useful diagnostic artifacts but are not substitutes for any of these human submissions.

# A1 v2 platform-expanded prototype candidate — 2026-09-14

> Status: `prototype_ai_assisted_finalized`; prototype-only, `lock_eligible=false`.

This is a new controlled population, created to test whether broader already-archived input from
the fixed platform source pair can resolve the previous platform-topic capacity shortfall. It does
not alter or promote either earlier 100-item candidate, and it contains no source body, excerpt,
raw path, AI verdict, or label.

| Item | Value |
| --- | --- |
| Snapshot ID | `a1-v2-platform-expanded-140-20260913` |
| Population | 140 globally deduplicated items; 5 topics |
| Topic distribution | Four non-platform topics × 20; `t_coding_agent_platforms` = 60 |
| Source distribution | 10 sources; `src_openai_codex_releases` = 10 and `src_cursor_changelog` = 50; every other source = 10 |
| Quality input | 809,598 bytes; SHA-256 `2d62a7d31d5a38ae0ac9e1c3950209792b479bb9fb5c2695863a7b278a25b9aa` |
| Source manifest | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/candidates/a1-v2-platform-expanded-140-20260913/source-manifest.json?versionId=qTIXgZJL0I96HD4_yHo02UQ2ilPjTwha` |
| Source manifest SHA-256 | `8f7bde7465fc7ad04a160b8b8308f1ab7cc2f6bd40a4bc591f1f6850f553f1c3` |
| Prototype owner decision | `A1-V2-TERMS-PROTOTYPE-20260914-PLATFORM-EXPANDED-140` · `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/owner-decisions/a1-v2-terms-prototype-20260914-platform-expanded-140.json?versionId=v5BQVBfANMh3e0jR21lYWaZyN29cdKre` |
| Owner decision SHA-256 | `16c68d5d6d5b726037cd838b32e170c271c495eaf48ceed15b8718f16209795a` |
| Candidate manifest retention | SSE-KMS, Object Lock Compliance through `2026-12-12T15:50:49.815Z` |
| Unlabeled candidate pairs | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-platform-expanded-140-20260913/citation-consistency-candidates.jsonl?versionId=IzVItD6boJSTh.LF.tki5WZj50khZZzb` · SHA-256 `c304aabdfb8c97c3799a84bcc4c56b12fd844d41a4eb85447e11c6c4dd94bbe4` |
| Generator diagnostic (not for reviewers) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-platform-expanded-140-20260913/citation-consistency-candidates.diagnostic.json?versionId=Rb_PC9a6WKBK4OoFw83wRFyvoe6RLexO` · SHA-256 `b9a03023e68023a7e7a5bc56ab5240f049b19087b5615bd8747979f17b0b31cb` |
| Label-free blind worklist | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-platform-expanded-140-20260913/citation-consistency-blind-worklist.jsonl?versionId=hXPs5drASKbHE39pT37TTt9DI9q0qEmB` · SHA-256 `b26fd1df87813f4b0244babbdb26d11617c397c0e5cd01bd5f5729cfb517d046` |

## Deterministic composition and storage verification

The candidate replaces only the platform case in the source-complete 100-item input with the
separate 60-item platform capacity input. The composer rejects ambiguous topic inputs, duplicate
content IDs/URLs and pre-existing output paths. The snapshot preparer then verifies every item is
`fetch_status=ok`, has a readable raw archive and has a body/archive/content-hash binding before
emitting the no-body manifest.

Before the owner decision was written, the immutable remote manifest was read back and compared to
the local prepared manifest. The remote quality input matched the manifest hash, all three
collection/build evidence files matched their recorded hashes, and all 140 remote raw archives
matched their manifest SHA-256 values. The controlled bucket precheck confirmed private access,
SSE-KMS, versioning and 90-day Object Lock Compliance.

The fresh candidate generator selected 100 pairs deterministically: 20 per topic and 10 per
source. Its generator diagnostic records the 140-item quality-input hash, selection hash,
fixed analyzer model and the private planned-intent distribution. The human/AI reviewer worklist
contains only `id`, `statement`, `source_text` and `pair_sha256`: it has no label, negative type,
intent or rationale. All three label-preparation objects were read back from S3 and matched their
local SHA-256 values.

## Scope and non-promotion boundary

The owner record's `approved_all` status applies only to this named immutable snapshot and only to
internal A1 quality evaluation, controlled consistency-label review and model evaluation of the
retained full text. It explicitly prohibits redistribution, public display of source bodies,
training and production-publication approval. It is not legal advice, a formal source-terms
decision, a `verified_v2` lock, DCP evidence or a comparable baseline.

The next artifact must be a fresh, label-free **100-pair** blind consistency worklist derived
deterministically from this exact 140-item population (20 per topic; the expanded platform topic
is source-round-robin). Any AI-assisted labels remain diagnostic-only and cannot make this
candidate lock-eligible; formal promotion continues to require two complete human blind
submissions and a third human adjudication receipt.

## AI-assisted diagnostic progress — incomplete

The coverage reviewer completed 100/100 decisions with `claude-opus-4-6`, Thinking disabled and
the frozen worklist SHA-256 above. Its diagnostic-only submission is
`s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/ai-coverage-review.json?versionId=0WOlsSoxvIrpJt1kHA3D2jOCm.XjrJx2`
(SHA-256 `742b3b311583dfb7ff3d5358ba12e1603097c517e300773e4b401ff898b34f87`),
with SSE-KMS and Object Lock Compliance through `2026-12-12T17:38:24.598Z`.

The validator reviewer remains **incomplete** at a local-only 95/100 whole-batch checkpoint with
`claude-opus-4-8`, Thinking enabled. The remaining five-pair batch repeatedly received a relay
`Request timed out`; two identical batch attempts and then a single-pair fallback also timed out.
The affected pair is ordinary in shape (2,201 source characters, no control characters, median
length range) and coverage completed it, so this is recorded as validator/relay liveness rather
than a source-body or label failure. The partial checkpoint is intentionally not uploaded and is
not a submission.

Consequently there is no AI comparison receipt, no dispute worklist, no finalized label JSONL and
no eligible receipt. No AI label, disagreement count, v2 lock, DCP or baseline conclusion may be
inferred from this progress record.

## Validator relay recovery probe — unsuccessful

On 2026-09-14, the proposed non-semantic recovery was tested with the same immutable worklist,
`claude-opus-4-8` and `VALIDATOR_THINKING=1`, but a lower, explicitly bound response allowance of
1,536 tokens (`output-1536-v1`). This retains the 1,024-token thinking allowance and leaves 512
tokens for the forced structured response. Checkpoint binding was extended to reject resumption
when that allowance differs, so the run began in a new local output path and did not read the
earlier 95/100 checkpoint.

The first five-pair request completed. The next five-pair request did not checkpoint after the
relay's repeated timeout window, so the diagnostic process was stopped before it could spend
further retries or create a mixed/partial submission. The local checkpoint contains only the
first whole batch; it was neither uploaded nor compared, and it must not be resumed into any
future run. A direct official-endpoint probe with the locally configured credential was rejected
by that endpoint, confirming that this credential is relay-scoped rather than a usable direct API
credential.

This rules out both a larger local wall-clock timeout and this smaller response allowance as a
solution to the observed relay liveness failure. A complete fresh validator submission now
requires a stable Anthropic-compatible endpoint and credential that supports the fixed model and
thinking configuration. After that route is independently canaried, both AI reviewers must be
run afresh under their explicit response budgets before an AI-only prototype comparison may be
created. This remains diagnostic-only and does not change the formal human-label/v2-lock path.

## Completed prototype AI double review — validator Thinking off

The endpoint-change premise above was superseded by a controlled operational comparison on
2026-09-14. The validator was run from a new, empty checkpoint with the same frozen worklist,
prompt, `claude-opus-4-8` model and 3,072-token response allowance as the failed Thinking-on
attempt, changing only `VALIDATOR_THINKING` from `1` to `0`. It completed all 100 decisions in
20 calls without a timeout. This is evidence that Thinking off is currently the viable
**prototype runtime** setting for this relay; it is not a quality comparison or a production
configuration change.

Coverage was then rerun from a new checkpoint with its fixed `claude-opus-4-6`, Thinking off and
the same 3,072-token allowance, so both submissions carry the explicit response-budget
provenance introduced by the recovery work. Each final submission contains only pair hashes and
decisions, never source text. Both were uploaded with `If-None-Match: *`, the controlled KMS key,
S3 versioning and default 90-day Object Lock Compliance; each remote body was read back and
matched its local SHA-256.

| artifact | immutable reference | SHA-256 |
| --- | --- | --- |
| validator AI submission, Thinking off | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/ai-validator-review-thinking-off-3072.json?versionId=BqYldmw2ozJrkp6P2CLBDU1hhg0ueqlT` | `674ab87dacad84f495aa2d6b6cf18205f873444f54264ccdb2475548396c4b3a` |
| coverage AI submission, response-provenance version | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/ai-coverage-review-provenance-3072.json?versionId=RL4vxY4x_Fn61H8ktr9s_9tGLE1u8I8p` | `4358799e128d8561c5e553630ca605482cac85da985cd0ccbacec073bcd6a394` |
| AI comparison receipt (no decisions) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/ai-thinking-off-comparison-receipt.json?versionId=J20NRGFdml20vqqAc8L7LTPWtfQWZMVC` | `2bc77fe23f6bba5c10d0da220fd92b677db45196a46f9c099991587b8e1e53bc` |
| human dispute worklist, 20 pairs and no AI labels | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/human-adjudication-worklist-thinking-off.jsonl?versionId=wyvQ.KFcJzFrKp8qnNKPEIjwDWc8TrT3` | `d73728d66777cea95048f0f0e5a885a0cad6e764652c4ecb5817bbc54003e757` |
| blank human-adjudication CSV, 20 pairs and no AI decisions | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/human-adjudication-thinking-off.csv?versionId=krohsRmV7d9WLZnoXfujR._vgO3rf2Ee` | `bb13b355a709fbb1d54ef9c2653c4c01558238a8217c2dd9a11f4296fbebf31f` |

The two AI reviewers disagree on 20/100 pairs. Their receipt is `prototype_ai_assisted` with
`lock_eligible=false`; it is only an entry point for a human to resolve those 20 cases. The
blank CSV has exactly 20 rows and blank `expected_consistency` / `negative_type` cells. Neither
the 100/100 completion nor the 20 disagreements measures accuracy: that requires comparison to
the independent human labels described in the formal v2 path. No v2 lock, DCP, baseline or
Eval-Gate pass follows from this prototype run.

## Human adjudication and prototype finalization — 2026-09-16

The human reviewer `human-reviewer-20260916` blind-adjudicated all 20 AI disagreements. The
adjudication was checked against the immutable worklist hash and every dispute pair hash before
finalization. The finalizer accepted the two distinct-model AI submissions plus this complete
human adjudication, produced the full 100-pair prototype label JSONL, and retained the explicit
`lock_eligible=false` boundary. It does not substitute for the formal two-human blind labeling
and third-human receipt required for a `verified_v2` lock.

| artifact | immutable reference | SHA-256 |
| --- | --- | --- |
| human adjudication, 20 AI disputes | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/human-adjudication-thinking-off.json?versionId=1fzF6F.CAaU838RDGM_wyb21cVEPz_Ky` | `391ea411027783b7eac1d82c7ace2d13e1bab11f4e929c90fe478b2b03b5deef` |
| final 100-pair prototype label JSONL | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/citation-consistency-v2-ai-assisted-thinking-off-final.jsonl?versionId=OGEwLkQ1S7mgUkuX76r7GK09Nz2T7Q8i` | `b8e829e020fa2da49d8b64d184943c710484aec6cbfc8d0b1f25b8a41efa50c4` |
| final prototype receipt | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-platform-expanded-140-20260913/citation-consistency-v2-ai-assisted-thinking-off-final-receipt.json?versionId=JC3uoMROIMCeUNDb6DMzQC73Fr0jDMoJ` | `a6219ad216110bec6ca528f3fef730e74586296437f739b750f84ae57ceeaef1` |

All three objects use the controlled KMS key, S3 versioning and Object Lock Compliance through
2026-12-14; each remote object body was read back and matched the recorded SHA-256. The final
distribution is 68 `support`, 10 `uncertain` and 22 `not_support` (8 `exaggeration`, 2
`out_of_context`, 12 `misattribution`). The receipt records the resulting shape issue:
`not_support 22/40 未达 A1 样本下限`.

### Disagreement review, not an accuracy score

On these 20 deliberately selected AI-disagreement pairs, the human decision exactly matched the
Thinking-off validator on 8, matched coverage on 7, and matched neither on 5. Because this is a
conditioned subset rather than an independently sampled and fully human-labeled benchmark, these
counts do not establish either reviewer's accuracy or that Thinking off improves semantic quality.
They do establish the currently observed operational result: the Thinking-off validator completed
the frozen 100-pair run without relay timeouts, while the comparable Thinking-on run did not.

Following that result, the prototype worktree's `.env.local` and the scheduled A1 workflow both
explicitly set `VALIDATOR_THINKING=0`; `COVERAGE_THINKING` remains explicitly `0`. This is a
relay-liveness configuration, not a semantic-quality promotion. Because it differs from the
former Thinking-on EvalConfig, the old baseline remains formally incomparable. No A1 run is
claimed as an Eval-Gate pass until a `verified_v2` lock and two same-config full runs establish a
new baseline.

## Production batch-validator diagnostic — 2026-09-16

The actual production judge path (`judgeConsistency` versus source-grouped
`judgeConsistencyBatch`) was exercised with the explicit local validator configuration
`claude-opus-4-8`, `VALIDATOR_THINKING=0`, and concurrency 6.  The committed legacy regression
fixture supplied 121 cases, including 60 `not_support` cases from 85 distinct source texts; 28
shared-source groups covered 64 cases.  It made 121 single-judge and 85 grouped-judge calls.
No source body, claim text, individual judgment, or rationale is recorded here.

| metric | single judge | grouped batch judge |
| --- | ---: | ---: |
| three-way accuracy against fixture labels | 91.7% | 94.2% |
| `not_support` recall | 100.0% | 100.0% |
| execution failures | 0 | 0 |
| single/batch verdict disagreements | \- | 10 / 121 |
| batch-only missed negative | \- | 0 |

The measured model cost was USD 1.9812.  The batch safety condition therefore passed: batch
introduced no missed negative that the single path caught, and its negative recall remained above
the 95% threshold.  This demonstrates only that source grouping did not regress the tested
production judge path under this configuration; it is not a general launch decision or an A1
Eval-Gate pass.

During this work, the diagnostic script was found to load `.env.local` after importing the
runtime `MODELS` constant.  That caused three earlier, excluded diagnostic attempts to use the
default `claude-opus-4-7` rather than the intended validator; two attempts also had no retained
aggregate terminal output because their execution sessions were not preserved.  The script now
loads local configuration before dynamically importing runtime modules, and has regression tests
for local configuration loading, direct `tsx` execution, and dynamic dataset counts.  Only the
post-fix `claude-opus-4-8` result in the table is evidence for the target configuration.

The fixture is `verified_legacy`, and the target thinking setting differs from the old A1
baseline configuration.  It remains unsuitable for baseline comparison, formal v2 promotion,
DCP, or release approval.  Those require the separately defined `verified_v2` dataset and
two same-configuration full A1 runs.

## Post-main-sync production batch-validator diagnostic — 2026-09-16

After rebasing the production diagnostic and validator path onto the current main branch, the
same explicit local configuration (`claude-opus-4-8`, `VALIDATOR_THINKING=0`, concurrency 6) was
rerun against the same committed legacy fixture. It loaded 121 cases (60 `not_support`, 85 source
texts), made 121 single and 85 grouped calls, and had no transport or parsing failures. This run
exited nonzero because the batch safety gate detected a batch-only missed negative. No source body,
claim, individual verdict, or rationale is retained in this record.

| metric | single judge | grouped batch judge |
| --- | ---: | ---: |
| three-way accuracy against fixture labels | 93.4% | 91.7% |
| `not_support` recall | 100.0% | 98.3% |
| execution failures | 0 | 0 |
| single/batch verdict disagreements | \- | 6 / 121 |
| batch-only missed negative | \- | 1 |

The 28 multi-claim source groups covered 64 cases. The sole new miss was fixture index 56:
the single path returned `not_support`, while the grouped path returned `uncertain`. Its batch
recall still exceeds the standalone 95% floor, but the stronger relative gate is deliberately
failed because batch regressed relative to the simultaneously measured single path. Cost was USD
1.9667.

This contradicts the earlier one-run batch pass as a stable release signal; it does not, by
itself, prove a code regression because the live model calls are not seeded and no validator
semantic change was introduced by the main sync. The production default was therefore changed to
single-judge: batch mode now requires explicit `VALIDATOR_BATCH=1` opt-in after a controlled
repeatability check and root-cause analysis. This remains a scoped production-path diagnostic
only, not A1, baseline, DCP, v2 lock, or Eval-Gate evidence.

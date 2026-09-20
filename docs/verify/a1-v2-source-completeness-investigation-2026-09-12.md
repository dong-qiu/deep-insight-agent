# A1 v2 source-completeness investigation — 2026-09-12

> 更新（2026-09-13, Asia/Shanghai）：采集与快照完整性修复已实施并在隔离真实采集路径验证；全量 A1 质量运行仍因单主题 deadline 未完成，见文末限制。旧的 16 条人工分歧工作表已隔离，不得继续用作正式标注输入。

> Status: **root cause confirmed; remediation implemented and replacement population verified**. This remains an evidence-quality issue, not a label correction or an authorization to mutate the original frozen A1 v2 candidate population.

## Observation

During human adjudication, candidate `cl_ci_f223712b1bad58a2` was found to use an incomplete source window for the Embrace The Red article *Breaking Claude Code Opus 5 Auto Mode*.

| Field | Observed value |
| --- | --- |
| ContentItem | `ci_f223712b1bad58a2` |
| URL | `https://embracethered.com/blog/posts/2026/breaking-claude-code-opus-5-and-automode` |
| Collected | `2026-09-10T09:55:31.690Z` |
| Frozen item `fetch_status` | `ok` |
| Frozen structured `body` | 522 Unicode characters |
| Raw archive handle | `/tmp/insight-a1-v2-five-topic-final.EOk7Yg/data/raw/ci_f223712b1bad58a2.txt` |
| Current raw archive size | 1,229 Unicode characters; it also ends after the same Auto Mode introductory paragraph |

The public page contains substantial material after this stored prefix (attack walkthrough, sample-size and ASR qualifications, disclosure, mitigations, and conclusion). The A1 source pair therefore does **not** contain the complete article even though its frozen `fetch_status` is `ok`.

## Risks and constraints

1. A short prefix can directly contain an asserted fact while omitting qualifications needed to assess its scope. It is not sufficient evidence for a “complete original” claim.
2. This conflicts with the collection contract: incomplete extraction must be marked `fetch_status=partial`, and `raw_ref` must support original-content retrieval (`docs/plan/specs/data-collection.md`, behavior 6–7 and AC6/AC9).
3. The frozen A1 candidate, blind worklist, pair hashes, and in-progress adjudications must remain unchanged. Replacing the text would invalidate the existing pair binding.
4. This observation alone does not establish whether the fault is in HTTP retrieval, page rendering, readability/extraction, source-specific handling, archive writing, or snapshot construction.

## Independent analysis — completed

An independent, read-only investigation traced the exact path for `src_embracethered` / `ci_f223712b1bad58a2`.

### Confirmed root cause

1. The frozen `src_embracethered` source is configured as `fetch_mode=full_text`. However, `src/lib/agents/collector.ts:128-132` only calls `fetchArticleBody` when the RSS item's raw body is shorter than `MIN_ARTICLE_CHARS` (200).
2. This item's RSS `<description>` was 933 characters before normalization, so the collector did **not** fetch the article page. Its 522-character normalized description is exactly the stored `body` and reproduces the frozen `content_hash` `4ec301…`.
3. This is not a current public-page, renderer, normalizer, or 50k body-cap truncation. An independent current fetch returned HTTP 200, 32,750 bytes, and 14,838 extracted characters from the article.
4. `fetch_status` remained `ok` because `src/lib/sources/normalize.ts:180-205` only marks a body `partial` when its own 50k truncation occurs. It does not represent a skipped or failed `full_text` page fetch.
5. The raw archive is independently insufficient: `src/lib/agents/collector.ts:177` archives the initial `RawItem.raw` RSS item JSON, not the article-page response. For the target it therefore ends at the same introductory paragraph. This also violates the `raw_ref` retrieval expectation for successfully fetched full-text sources.

### Verified scope

- In the isolated A1 collection cohort, all 50/50 Embrace The Red items had `body == normalize(raw.description)`, matching content hashes and `fetch_status=ok`. The issue is therefore not an isolated sample anomaly.
- The local A1 v2 quality input additionally contains `ci_fd44b284cb8519ec` and `ci_7afe772fe64eba3e` with the same signature.
- Of the current 16 AI-disagreement cases, two are from this source: `cl_ci_f223712b1bad58a2` and `cl_ci_ca96096e9eed07d2`. Neither appears in the 11 decisions already recorded in the local chat-adjudication progress file; both remain pending.
- The current snapshot path has no completeness gate: `evals/build-local-eval-lib.ts:91-93` selects only by body length, and `evals/prepare-controlled-v2-snapshot.ts:62-80` does not require `fetch_status=ok`, a usable `raw_ref`, or a body/archive consistency check. Its preflight already admitted a `partial` item.
- More generally, even where a full-text page fetch succeeds, the raw writer preserves the initial feed payload. In the local 20-item set, 5 `ok` items had bodies that could not be found in any textual field of their raw archive, so `raw_ref` cannot reliably retrieve the source used for analysis.

### Minimum safe remediation proposal — pending review

1. Enforce `fetch_mode=full_text`: for every new URL, fetch and extract the article page regardless of RSS-description length. A source that intentionally trusts feed content must use a distinct feed-only mode.
2. If a full-text fetch fails and a feed summary is retained, set `fetch_status=partial`; it must never become `ok` by default.
3. Preserve the article response in the raw archive (with feed metadata in an envelope if needed), and bind raw-byte size/hash so the structured body can be verified against the archived source.
4. Make A1 build/snapshot preparation fail closed for `fetch_status !== ok`, missing raw archive, or an archive/body consistency failure. Store status plus raw hash/size in the no-body manifest.
5. Add regression tests for: long RSS descriptions in a `full_text` source; page-fetch failure with retained summary; raw archive fidelity after successful page fetch; and A1 build/snapshot rejection of partial, missing, or inconsistent source evidence.

## Remediation evidence — 2026-09-13

- `full_text` sources now fetch every **new** article URL rather than trusting RSS description length. A page-fetch failure retains the feed text only as `fetch_status=partial`; an emergency article-fetch kill cannot downgrade an already complete row.
- Raw storage is now a `content-raw-archive-v1` envelope. It retains the normalization input, source-item metadata, the article HTTP response when applicable, and the declared structured-body hash.
- The A1 builder excludes `partial`/missing-archive rows. Snapshot preparation requires `fetch_status=ok`, a readable current-format archive, one-pass normalized archive body equal to stored `body`, and a matching declared `content_hash`. The one-pass comparison is intentional: nested HTML entities make repeated normalization non-idempotent, and a direct re-hash of unnormalized markup would reject faithful input.
- New isolated production-path collection completed all 10 required sources with zero collection failures. The formal prototype candidate contains 100 globally deduplicated items: five topics × 20, each source × 10; 60 selected bodies derive from article pages and 40 from feeds. All 100 raw envelopes, source manifest, collection/build manifests, and the prototype-only owner decision are in the dedicated Object-Locked store. No source body is committed to Git.
- The 20-item, five-topic collection preflight is retained separately as immutable evidence only. It is intentionally not used to generate the 100-pair label worklist.

### Current limitation

The first A1 automatic quality run over the full 100-item input stopped at the configured 1,500,000 ms deadline for `t_code_agents`, before it could produce any auto metric. This is an execution-scale problem in the current one-topic/20-item A1 shape, not a passing quality result and not evidence for DCP or baseline comparison. A reduced per-topic projection can validate the source path, but must be reported only as non-comparable pipeline evidence until the full-quality run is made resumable or otherwise brought under its deadline.

### Replacement-data rule

After a reviewed fix, create a **new** isolated collection, quality input, snapshot ID, controlled upload, candidate/worklist, and label population. Do not alter, reuse as complete, or mix the existing Object-Locked snapshot and its in-progress human adjudications.

## Immediate handling

- Do not use this source pair to claim a complete, auditable original.
- Keep the current adjudication independent of any AI verdict and preserve its immutable pair hash.
- Do not alter the controlled snapshot or upload replacement artifacts until the independent analysis reports evidence and a reviewed remediation plan.

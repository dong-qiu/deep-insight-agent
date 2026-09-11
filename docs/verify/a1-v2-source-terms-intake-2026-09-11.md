# A1 v2 source-terms intake — 2026-09-11

> Status: `pending_owner_legal_review`; this is a factual intake, **not legal advice or a licence determination**.
> It does not change the candidate snapshot’s `pending_source_terms_review` status, authorize redistribution, or permit a `verified_v2` lock.

## Scope and handling boundary

This intake concerns only `a1-v2-candidate-20260910-8e23ecf` (100 internal A1 evaluation inputs). The candidate’s source-manifest/body hashes and Object-Lock retention continue to be the controlling evidence; this file contains no source bodies or excerpts.

- Intended use remains: internal A1 quality evaluation only; no redistribution.
- This review was performed on 2026-09-11. Current web terms cannot by themselves prove the terms that applied when content was collected, so a legal owner must record the applicable version/effective date before approving any source.
- An RSS/Atom endpoint being public is evidence of subscription availability, **not** a grant to store, reproduce, transform, or use full text in an evaluation corpus.
- No `approved` disposition is assigned below. A source must remain excluded from a promotable v2 lock unless the named owner records a positive, source-specific decision and retention limit in the controlled evidence store.

## Observed sources and required decisions

| source ID | official collection route | observed terms/licence evidence | provisional intake disposition | owner decision required |
| --- | --- | --- | --- | --- |
| `src_simonwillison` | `https://simonwillison.net/atom/everything/` | The site documents Atom subscriptions, but this pass did not verify a page granting a reusable-content licence. | `terms_not_verified` | Confirm content rights and retention for full-text page fetches. |
| `src_aider` | `https://aider.chat/feed.xml` | The located contributor agreement concerns submitted software contributions, not publication content in the feed. | `terms_not_verified` | Obtain a content-specific licence/permission or replace the source. |
| `src_trailofbits` | `https://blog.trailofbits.com/feed/` | No site-wide terms granting reuse of blog full text were verified in this pass; individual Trail of Bits reports may carry their own restrictions and cannot be generalized to the blog. | `terms_not_verified` | Verify blog-specific permission and retention. |
| `src_anquanke` | `https://api.anquanke.com/data/v1/rss` | No authoritative, content-specific service/rights terms were verified in this pass. | `terms_not_verified` | Chinese-law/terms review, including RSS-to-page full-text fetch. |
| `src_semianalysis` | `https://newsletter.semianalysis.com/feed` | SemiAnalysis [terms](https://semianalysis.com/terms-and-conditions/) state that no licence is granted absent specific content or mandatory law, restrict copying/use without permission, and separately describe conditions for quotation/public reference. | `restricted_hold` | Legal owner must decide whether any internal full-text retention is permitted; otherwise replace/remove this source. |
| `src_techcrunch_ai` | `https://techcrunch.com/category/artificial-intelligence/feed/` | TechCrunch [Terms of Service](https://techcrunch.com/terms-of-service/) describe materials as for personal, non-commercial use and prohibit unapproved copying, reproduction, distribution and derivative use. | `restricted_hold` | Obtain permission or replace/remove; do not infer that an RSS feed authorizes the stored full-text corpus. |
| `src_openai_codex_releases` | `https://github.com/openai/codex/releases.atom` | The [openai/codex repository](https://github.com/openai/codex) declares Apache-2.0; GitHub’s [terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) state that repository-specific licences govern additional rights. | `licence_scope_verify` | Confirm the exact release/tag, repository licence/NOTICE and that release-page text in the snapshot is within scope; retain required notices. |
| `src_cursor_changelog` | `https://cursor.com/changelog/rss.xml` | Cursor’s current [Terms of Service](https://cursor.com/terms-of-service) prohibit harvesting, scraping or extracting data from the Service and reserve ungranted rights. | `restricted_hold` | Obtain written permission or replace/remove this source; the official RSS route does not override the observed restriction without owner confirmation. |
| `src_embracethered` | `https://embracethered.com/blog/index.xml` | No content-specific licence or terms page was verified in this pass. | `terms_not_verified` | Confirm author/site permission and retention for full-text page fetches. |
| `src_simonwillison_promptinj` | `https://simonwillison.net/tags/prompt-injection.atom` | Same publisher and unresolved content-rights question as `src_simonwillison`; a topic-specific feed is not a separate permission. | `terms_not_verified` | Reuse the final source-specific decision for `src_simonwillison` only if it explicitly covers this feed and fetched pages. |

## Gate outcome and next action

`license_and_retention.status` remains `pending_source_terms_review`. The following are prohibited until every in-scope source has a documented decision:

1. Creating `verified_v2` or a promotable `controlled_snapshot_v2` dataset lock.
2. Treating any A1/liveness run over this candidate as comparable baseline, DCP, or publication evidence.
3. Exporting/re-distributing candidate bodies, labels derived from bodies, or terms captures outside the authorized controlled store.

For each row, the data/legal owner must add: reviewed URL, observed/effective date, exact applicable licence or written permission, whether internal corpus storage and model evaluation are allowed, retention/deletion instruction, required attribution/notice, and reviewer identity. Any negative or unresolved decision requires a rebuilt candidate snapshot and new hashes; existing Object-Locked evidence must not be silently edited or relabelled.

The required controlled sign-off fields, including the hard check that permitted retention reaches the candidate's Object-Lock date, are supplied in [the owner-decision template](./a1-v2-source-terms-owner-decision-template.md). That template is intentionally blank and does not alter this intake's `pending_owner_legal_review` status.

## External evidence used for the intake

- [SemiAnalysis Terms and Conditions](https://semianalysis.com/terms-and-conditions/)
- [TechCrunch Terms of Service](https://techcrunch.com/terms-of-service/)
- [Cursor Terms of Service](https://cursor.com/terms-of-service)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [OpenAI Codex repository licence notice](https://github.com/openai/codex/blob/main/docs/license.md)
- [Simon Willison site/about and Atom subscription information](https://simonwillison.net/about/)
- [Aider contributor agreement (not a feed-content licence)](https://aider.chat/docs/legal/contributor-agreement.html)

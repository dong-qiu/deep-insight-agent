# A1 v2 source-terms owner precheck — 2026-09-20

> Status: **formal-path precheck retained for later; deferred by ADR-0030.** This is not legal advice,
> permission evidence, a source-specific owner decision, or input to a `verified_v2` lock. It
> contains no source bodies, terms captures, credentials, contacts, or controlled-storage URIs.

## Fixed candidate facts

| field | prefilled value | owner / recorder action |
| --- | --- | --- |
| candidate snapshot | `a1-v2-platform-expanded-140-20260913` | Confirm this is the snapshot under review. |
| source-manifest SHA-256 | `8f7bde7465fc7ad04a160b8b8308f1ab7cc2f6bd40a4bc591f1f6850f553f1c3` | Compare against the controlled manifest. |
| Object-Lock retention | `2026-12-12T15:50:49.815Z` | Confirm the controlled S3 `RetainUntilDate` and require every approved row to cover it. |
| intended use | Internal full-text A1 evaluation and controlled consistency review only; no redistribution, training, or production publication | Confirm the decision does not broaden this scope. |
| current overall disposition | `blocked` | Replace only after all ten source rows are approved and independently recorded. |

## Pre-filled source worksheet

The “AI precheck” is deliberately conservative. It is based only on the factual intake dated
2026-09-11; it does not infer a licence from a public RSS/Atom endpoint. `needs_permission` and
`unresolved` are workflow states, not legal conclusions.

| source ID | exact collection route | existing factual intake | AI precheck | fields the owner must supply before approval |
| --- | --- | --- | --- | --- |
| `src_simonwillison` | `https://simonwillison.net/atom/everything/` | Atom availability observed; no reusable-content licence verified | `unresolved` | Terms/permission evidence ID + SHA-256, applicable date, storage/model-evaluation permission, retention, notices. |
| `src_aider` | `https://aider.chat/feed.xml` | Contributor agreement found, but it does not license feed content | `unresolved` | Content-specific permission or licence; all required decision fields. |
| `src_trailofbits` | `https://blog.trailofbits.com/feed/` | No blog-wide full-text reuse permission verified | `unresolved` | Blog/page-specific permission or licence; all required decision fields. |
| `src_anquanke` | `https://api.anquanke.com/data/v1/rss` | No authoritative content-specific terms verified | `unresolved` | Applicable terms/permission, including page-fetch and retention review; all required decision fields. |
| `src_semianalysis` | `https://newsletter.semianalysis.com/feed` | Intake observed restrictive terms and no licence absent specific content or mandatory law | `needs_permission` | Written/source-specific permission that explicitly covers storage, model evaluation, retention and notices; otherwise replace. |
| `src_techcrunch_ai` | `https://techcrunch.com/category/artificial-intelligence/feed/` | Intake observed restrictions on unapproved copying/reproduction/derivative use | `needs_permission` | Written/source-specific permission covering the intended use and retention; otherwise replace. |
| `src_openai_codex_releases` | `https://github.com/openai/codex/releases.atom` | Repository Apache-2.0 licence observed; release-page prose scope not yet verified | `unresolved` | Exact release/tag and licence/NOTICE scope confirmation for archived release-page text; all required decision fields. |
| `src_cursor_changelog` | `https://cursor.com/changelog/rss.xml` | Intake observed terms prohibiting harvesting, scraping or extracting Service data | `needs_permission` | Written/source-specific permission covering storage, model evaluation and retention; otherwise replace. |
| `src_embracethered` | `https://embracethered.com/blog/index.xml` | No content-specific licence or terms verified | `unresolved` | Author/site permission or licence; all required decision fields. |
| `src_simonwillison_promptinj` | `https://simonwillison.net/tags/prompt-injection.atom` | Same publisher/rights question as `src_simonwillison` | `unresolved` | An approval for the primary Simon Willison route may be reused only if it explicitly covers this route and fetched pages. |

## Owner completion checklist

For every row above, the data/legal owner must add in the **controlled evidence record**, not this
repository worksheet:

1. An opaque terms/permission evidence ID and SHA-256, plus the terms version or observed/effective
   UTC date applicable to collection.
2. Explicit `yes`/`no` answers for full-page fetch + internal corpus storage and model evaluation
   of the stored full text.
3. A permitted-retention instant at or after `2026-12-12T15:50:49.815Z`, and any required
   attribution/NOTICE instruction.
4. `approved`, `denied`, `needs_permission`, or `unresolved`, with a controlled owner sign-off
   reference.

An independent recorder must then verify the snapshot/manifest hash, all evidence bindings, the
Object-Lock compatibility and that no source body or terms capture entered Git. Only if every row
is `approved` may the controlled owner record have overall status `approved_all`; otherwise it
remains `blocked` and a replacement snapshot is required for any excluded source.

## Boundaries after this precheck

- ADR-0030 retains the existing internal, non-commercial prototype scope. This worksheet is not
  an active approval task while that scope remains active; it is frozen input for any future formal
  or external-use decision.
- Do not alter the frozen 100-pair blind worklist while terms review is unresolved.
- Do not treat the prototype AI-assisted labels (including its observed distribution) as human
  labels or use them to change the formal worklist.
- After a source-specific `approved_all` record exists, dispatch the already frozen worklist to
  two distinct human reviewers without AI labels or advice. If their final human receipt does not
  meet the actual label-distribution gate, create a new candidate/worklist rather than mutating
  the frozen one.

References: [factual terms intake](./a1-v2-source-terms-intake-2026-09-11.md),
[owner-decision template](./a1-v2-source-terms-owner-decision-template.md), and
[formal readiness audit](./a1-v2-formal-readiness-2026-09-19.md).

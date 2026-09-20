# A1 v2 source-terms owner decision — template

> Create one controlled evidence record from this template for the candidate snapshot before any `verified_v2` lock is made. This template records an owner decision; it is **not legal advice**, and filling it does not itself grant a licence.
>
> Do not put source bodies, terms-page copies, credentials, signed agreements, personal contact data, or full storage URIs in Git. Keep those in the controlled evidence store and reference them by opaque evidence ID and SHA-256 only.

## Record identity and scope

| field | required value |
| --- | --- |
| decision record ID | `A1-V2-TERMS-…` |
| candidate snapshot ID | `a1-v2-candidate-…` |
| candidate source-manifest SHA-256 | `<64 lowercase hex>` |
| decision UTC | `<ISO-8601 UTC>` |
| decision owner | `<data/legal owner role and controlled identity reference>` |
| independent recorder | `<role and controlled identity reference>` |
| terms evidence index | `<controlled evidence ID + SHA-256 for every source row>` |
| decision status | `approved_all / blocked` |

This record applies only to the named snapshot and exact routes below. It may not be reused for a later collection, a different URL pattern, another publisher, redistribution, training, or a changed model/provider arrangement without a new owner decision.

## Required per-source decisions

Every row must be completed. `approved` is valid only when **all** allowed-use columns are `yes`, the decision is source-specific, and the permitted retention covers the candidate Object-Lock date. Any `no`, `unknown`, `needs_permission`, or missing field makes the overall status `blocked`.

| source ID | exact collection route | terms / permission evidence ID + SHA-256 | terms version or observed/effective UTC | full-page fetch + internal corpus storage | model evaluation of stored full text | permitted retention through UTC (ISO-8601 instant) | attribution / notice instruction | decision (`approved / denied / needs_permission / unresolved`) | owner initials / controlled sign-off ref |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `src_simonwillison` | `https://simonwillison.net/atom/everything/` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_aider` | `https://aider.chat/feed.xml` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_trailofbits` | `https://blog.trailofbits.com/feed/` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_anquanke` | `https://api.anquanke.com/data/v1/rss` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_semianalysis` | `https://newsletter.semianalysis.com/feed` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_techcrunch_ai` | `https://techcrunch.com/category/artificial-intelligence/feed/` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_openai_codex_releases` | `https://github.com/openai/codex/releases.atom` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_cursor_changelog` | `https://cursor.com/changelog/rss.xml` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_embracethered` | `https://embracethered.com/blog/index.xml` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |
| `src_simonwillison_promptinj` | `https://simonwillison.net/tags/prompt-injection.atom` | `<…>` | `<…>` | `yes/no` | `yes/no` | `<…>` | `<…>` | `<…>` | `<…>` |

## Object-Lock and retention compatibility

Before a v2 lock is made, obtain the exact S3 `RetainUntilDate` UTC instant from the controlled
candidate evidence and put that same instant in both `object_lock_retain_until` and the owner
decision's `permitted_retention_until`. For the current formal candidate
`a1-v2-platform-expanded-140-20260913`, that instant is **2026-12-12T15:50:49.815Z** (see
`a1-v2-platform-expanded-candidate-2026-09-14.md`). A later candidate must use its own recorded
instant rather than reusing this value. For every approved row, permitted retention must explicitly
cover the applicable instant; otherwise the candidate is ineligible even if its future use would
otherwise be allowed.

| check | result | evidence / explanation |
| --- | --- | --- |
| every approved source permits storage through the applicable `object_lock_retain_until` instant | `pass/fail` | `<…>` |
| every approved source permits the intended model-evaluation use through the applicable `object_lock_retain_until` instant | `pass/fail` | `<…>` |
| required attribution/notice is recorded in the controlled runner or evidence store | `pass/fail` | `<…>` |
| no decision relies on public RSS availability as a permission grant | `pass/fail` | `<…>` |
| no source body or terms capture appears in the repository record | `pass/fail` | `<…>` |

If any check fails, set `decision status=blocked`; do **not** edit, relabel, delete, or shorten the existing Object-Locked candidate. Produce a replacement plan and, after collecting only approved inputs with a compatible retention policy, create a new snapshot ID and fresh source/body hashes.

## Negative cases that must remain blocked

1. A publisher offers an RSS/Atom feed but grants no full-text storage or model-evaluation permission.
2. A source grants quotation/public-reference rights but not internal retention of the fetched full text.
3. A repository code licence is present but the snapshot contains release-page prose whose scope has not been confirmed.
4. Permission allows 30 days while the immutable candidate remains retained beyond that period.
5. A decision covers one Simon Willison feed but does not expressly cover the topic-specific feed and its fetched pages.
6. Terms are visible today but there is no evidence of the version/effective date applicable at collection time.

Each case above is a hard stop for `verified_v2`, comparable baseline/DCP claims, automatic full A1 promotion, and downstream human review receipt.

## Owner conclusion

| conclusion | required next action |
| --- | --- |
| `approved_all` | Attach this controlled decision record to the source manifest, then begin the 100-pair label-set construction. |
| `blocked` | For every non-approved source, either obtain permission or select an approved replacement; then build a new candidate snapshot and repeat this decision record. |

| role | controlled sign-off reference | UTC |
| --- | --- | --- |
| data/legal owner | `<…>` | `<…>` |
| independent recorder | `<…>` | `<…>` |

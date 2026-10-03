# Next root-directory glob adapter

Scoped npm override for `@next/eslint-plugin-next@16.3.8` only. Its installed
`dist/utils/get-root-dirs.js` calls `fast-glob.globSync(pattern, { onlyDirectories: true })`;
no other plugin file imports fast-glob. This adapter is not a complete fast-glob API.

GHSA-vfj7-8cjw-p6xm affects braces <=3.0.3 and had no patched npm release when
checked on 2026-10-03. The dependency chain was Next ESLint -> fast-glob ->
micromatch -> braces. Replace that actual implementation with pinned
tinyglobby 0.2.17 (fdir/picomatch; no braces), not an audit ignore or package rename
around vulnerable code. Next/ESLint versions and rule configuration stay unchanged.

Compatibility adjustments: disable tinyglobby's default recursive directory
expansion, preserve absolute-vs-relative input paths, and remove trailing slashes except filesystem root. Reject unexpected
caller options and bound pattern length/brace depth before glob parsing. Normal
root strings, wildcard/brace patterns, arrays handled by the real Next caller,
absolute/Windows-normalized paths, missing roots and lint violations are tested.
Literal symlink roots are supported via stat. Discovery globs encountering symlinks
fail explicitly: tinyglobby omits such directory entries and cannot silently narrow
lint coverage. Configure explicit literal roots instead; this is not full glob API compatibility.

Sources: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm ;
https://github.com/SuperchupuDev/tinyglobby ;
https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides

Exit: check upstream at least every 30 days. When a compatible official Next
plugin drops the vulnerable chain, remove this override/vendor artifact in a
reviewed PR after the same root-discovery/lint/audit/clean-install/build/Docker
checks. Any change to the pinned Next plugin/caller requires explicit compatibility
review; do not broaden this shim into a generic glob library.

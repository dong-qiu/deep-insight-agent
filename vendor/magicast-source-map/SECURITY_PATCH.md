# magicast 0.5.5 source-map dependency repair

This package preserves the official magicast 0.5.5 public API, declarations,
recast 0.24.0 and remaining distribution bytes. The upstream MIT LICENSE is
included. It removes the ten bundled source-map-js 1.2.1 modules and imports the
official source-map-js **1.2.2** package instead. No source-map implementation is
renamed or hidden here. The application still calls this package as `magicast`.

Why a package override is necessary: magicast 0.5.5 declares source-map-js as a
dependency but also ships its complete old implementation inline. Updating the
lockfile cannot replace that implementation. Its public `generateCode` accepts
`inputSourceMap` and reaches the old consumer; an invalid offset is accepted.
magicast 0.5.4 also inlines 1.2.1; 0.5.5 remains the latest registry release at
the 2026-10-06 investigation. This dev/coverage dependency executes locally and
in CI. We have not established a production attacker-controlled map path.

Sources: [advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
[source-map-js release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2),
[magicast upstream metadata](https://github.com/unjs/magicast/blob/v0.5.5/package.json),
[official tarball](https://registry.npmjs.org/magicast/-/magicast-0.5.5.tgz).

Reproduce with Node 24.19.0 into a **new** directory:

```sh
node ops/vendor-magicast-source-map.mjs /tmp/magicast-source-map-reproduction
```

The maintenance command checks the fixed official tgz SHA512 before reading any
member, requires all ten source-map module boundaries, removes their entire
implementation and emits per-file upstream/patched SHA256 values in
`PROVENANCE.json`. Only the builders chunk and package metadata change; seven
other distribution files and LICENSE remain byte-identical. This README is
local documentation and is not generated. The committed files, rather than a
network operation or node_modules patch, are installed by `npm ci` and Docker.

The root override applies only to coverage-v8's magicast dependency; the local
dev dependency anchors the file location for reliable npm hoisting. Tests guard
coverage-v8 5.0.1 and its `^0.5.4` magicast contract so future parent upgrades
require a fresh review. At least every 30 days check for an official release that
removes the old inline implementation or rebuilds it with a safe version. Then
remove the local dev anchor/override/vendor in a separate PR, recheck **actual
distribution bytes**, clean install, all-dependency audit, public API security
tests, coverage, typecheck/lint, C5 build/HTTP/D4 and full Docker CI. A new
upstream integrity or changed boundary must fail reproduction and receive a
fresh review. Reverting to the original package or lock restores known vulnerable
code and is not a security-safe rollback.

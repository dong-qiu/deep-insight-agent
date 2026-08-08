# Security patch provenance

This vendored artifact is built from the private maintained mirror
`dong-qiu/image-size-security` at tag `v2.0.3` / commit
`daf93f3`. It is based on upstream `image-size` `v2.0.2`
(`032c3347b86f09a2e16449e17537cf5e1009520c`), including upstream
`8994131c7c3ee8da1699e04700c95e0e683a0c68` for zero-length ISO boxes.

The mirror adds rejection of a zero-length ICNS image entry. Keep this artifact
only until an upstream release includes the complete remediation; then remove
the override and vendor directory together after the production audit passes.

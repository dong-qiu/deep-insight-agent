// Test-only identity adapter. All released app bundles and CLI entrypoints remain original.
export * from './shared-in-image.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from './shared-in-image.mjs';
import { identityFor } from './pair-contracts.mjs';
export function bundleIdentity() {
  const identity = identityFor(process.env.A2_PAIR_ROLE);
  assert.equal(process.env.GIT_SHA, identity.revision); assert.equal(process.env.INSIGHT_IMAGE_DIGEST, identity.manifest_digest);
  assert.equal(JSON.parse(readFileSync('/app/build-info.json')).git_sha, identity.revision);
  const entries = [];
  function visit(path) {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else entries.push([path, hash(readFileSync(path))]);
  }
  for (const path of ['/app/server.js', '/app/build-info.json', '/app/.next/server', '/app/ops/run-provenance-migrations.mjs', '/app/ops/record-deployment.mjs', '/app/config/defaults.yaml']) visit(path);
  return { revision: identity.revision, manifest: identity.manifest_digest, sha256: hash(JSON.stringify(entries)), files: entries.length };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
export const sharedHashes = Object.freeze({
  'fixture.mjs': '1fed538732e5d9138e93ec35a765cf8319f71c9f552a013f81b0f8ba3cded7cd',
  'http-probe.mjs': '8bef829d815eacded43c612ed442e8e3f8c3f9a4b56688deb47e8fbcc45318ba',
  'in-image.mjs': 'c2bee36ca6a7fe1c962c733b9caa4b9ced9bbf1ab31ceb76e476a9416c8dad0c',
  'contracts.mjs': '33c3f842172755e29015135f64d498a0a7d4fbf7afb6f343d6c80336cca3195a',
  'failure-probe.mjs': 'c65f919dd90c69afff4f7d478c9c84e17906f516b186ccd64376a549ebecd3e4',
});
export function adaptImport(bytes, expected) {
  assert.equal(hash(bytes), expected, 'shared harness changed; re-review required');
  const text = bytes.toString('utf8'), from = 'from "./in-image.mjs"';
  assert.equal(text.split(from).length, 2, 'exactly one identity adapter import');
  return text.replace(from, 'from "./pair-in-image.mjs"');
}
export function prepareHarness(root, directory) {
  const bindings = [];
  for (const [name, expected] of Object.entries(sharedHashes)) {
    const bytes = readFileSync(join(root, 'ops/a2-business-matrix', name)); assert.equal(hash(bytes), expected);
    const target = name === 'in-image.mjs' ? 'shared-in-image.mjs' : name;
    const out = ['fixture.mjs', 'http-probe.mjs', 'failure-probe.mjs'].includes(name) ? adaptImport(bytes, expected) : bytes;
    writeFileSync(join(directory, target), out, { mode: 0o644 }); bindings.push({ file: target, original_sha256: expected, adapted_sha256: hash(out) });
  }
  for (const name of ['pair-in-image.mjs', 'pair-probe.mjs', 'consistent-copy.mjs', 'copy-probe.mjs']) {
    const bytes = readFileSync(new URL(`./${name}`, import.meta.url)); writeFileSync(join(directory, name), bytes, { mode: 0o644 }); bindings.push({ file: name, sha256: hash(bytes) });
  }
  // Container contracts import shared assertions via a sibling path. Flatten only this test import.
  const ownContracts = readFileSync(new URL('./contracts.mjs', import.meta.url), 'utf8');
  const from = "from '../a2-business-matrix/contracts.mjs'"; assert.equal(ownContracts.split(from).length, 2);
  const pairContracts = ownContracts.replace(from, "from './contracts.mjs'");
  writeFileSync(join(directory, 'pair-contracts.mjs'), pairContracts, { mode: 0o644 });
  bindings.push({ file: 'pair-contracts.mjs', original_sha256: hash(ownContracts), adapted_sha256: hash(pairContracts) });
  const native = readFileSync(join(root, 'ops/sharp-security.node-test.mjs'));
  assert.equal(hash(native), '90b7102feb4311a358a22e57e49d7475930a5245b53b2bb694591878b981c414');
  const nativeText = native.toString(), rootLine = 'const root = fileURLToPath(new URL("../", import.meta.url));';
  assert.equal(nativeText.split(rootLine).length, 2);
  const nativeOut = nativeText.replace(rootLine, 'const root = "/app/";'); writeFileSync(join(directory, 'native.node-test.mjs'), nativeOut, { mode: 0o644 });
  bindings.push({ file: 'native.node-test.mjs', original_sha256: hash(native), adapted_sha256: hash(nativeOut) });
  return bindings;
}

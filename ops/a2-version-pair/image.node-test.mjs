import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { runPair } from './run.mjs';
const enabled = process.env.GITHUB_ACTIONS === 'true' || process.env.A2_VERSION_PAIR_IMAGE_TEST === '1';
test('exact81dac77 to exacta5253da: unique no-model isolated runtime and cross-version business pair', {
  skip: !enabled ? 'Local Docker pair not executed; final acceptance needs actual immutable Linux CI images' : false, timeout: 900000,
}, async () => {
  assert.equal(process.platform, 'linux'); execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'version'], { env: { PATH: process.env.PATH }, stdio: 'pipe' });
  const value = await runPair(); assert.equal(value.result, 'pass'); assert.equal(value.stages.length, 2); assert.equal(value.native.length, 2); assert.equal(value.failures.length, 2);
  assert.equal(value.safe_rollback, null); assert.equal(value.deployment_permitted, false); assert.equal(value.rollback_permitted, false);
  console.log(`A2_VERSION_PAIR_JSON=${JSON.stringify(value)}`);
});

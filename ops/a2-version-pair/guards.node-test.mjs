import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pair, imageFor, identityFor, assertResearchDescriptor, assertContainer, assertStopped, assertRecordTransition, assertPreserved, assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady } from './contracts.mjs';
import { sharedHashes, adaptImport, prepareHarness } from './harness.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)), hash = value => createHash('sha256').update(value).digest('hex');
test('only two immutable research identities; real deployment policy unchanged', () => {
  for (const role of ['release', 'candidate']) { assertResearchDescriptor(role, pair[role]); for (const key of ['revision', 'manifest_digest', 'index_digest', 'config_digest', 'compose_sha256']) assert.throws(() => assertResearchDescriptor(role, { ...pair[role], [key]: 'wrong' })); }
  assert.throws(() => identityFor('old-vulnerable')); assert.throws(() => identityFor('latest')); assert.throws(() => identityFor('__proto__'));
  const policy = JSON.parse(readFileSync(join(root, 'ops/aws/security-release-policy.json'))); assert.equal(policy.revision, '4477412a3e2b1cb2764fb4357f2284e73952af67'); assert.equal(policy.deployment.status, 'blocked'); assert.equal(policy.deployment.safe_rollback, null);
});
const binding = { identity: pair.candidate, owner: 'isolated-test-owner', volume: 'synthetic-volume', harness: '/synthetic/harness' };
function inspect() {
  const identity = pair.candidate, env = ['PROVENANCE_SCHEMA_REQUIRED=1', 'PROVENANCE_DEPLOYMENT_REQUIRED=1', `GIT_SHA=${identity.revision}`, `INSIGHT_IMAGE_DIGEST=${identity.manifest_digest}`, 'HOSTNAME=127.0.0.1', 'STALENESS_ALERT_HOURS=1000000'];
  return { Id: 'synthetic-id', Image: identity.config_digest, State: { Running: false, Status: 'exited' },
    Config: { Image: imageFor(identity), Cmd: ['node', 'server.js'], Entrypoint: ['docker-entrypoint.sh'], User: 'app', Env: env, Labels: { 'org.opencontainers.image.revision': identity.revision, 'org.insight-agent.a2-business-owner': binding.owner } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Privileged: false, PortBindings: {} },
    Mounts: [{ Type: 'volume', Destination: '/data', Name: binding.volume, RW: true }, { Type: 'bind', Destination: '/matrix', Source: binding.harness, RW: false }] };
}
const check = value => assertContainer(value, { ...binding, envKeys: inspect().Config.Env.map(x => x.split('=', 1)[0]) });
test('original isolated candidate identity accepted and env never serialized', () => { const x = check(inspect()); assert.equal(x.revision, pair.candidate.revision); assert.ok(!('env' in x)); });
for (const [name, mutate] of [
  ['wrong config', x => { x.Image = pair.release.config_digest; }], ['wrong revision', x => { x.Config.Labels['org.opencontainers.image.revision'] = pair.release.revision; }],
  ['mutable tag', x => { x.Config.Image = `${pair.candidate.repository}:latest`; }], ['app bundle replacement', x => { x.Mounts.push({ Type: 'bind', Destination: '/app', Source: '/local', RW: false }); }],
  ['network', x => { x.HostConfig.NetworkMode = 'bridge'; }], ['root', x => { x.Config.User = '0'; }], ['writable rootfs', x => { x.HostConfig.ReadonlyRootfs = false; }],
  ['public port', x => { x.HostConfig.PortBindings = { 3000: [{}] }; }], ['entrypoint', x => { x.Config.Entrypoint = []; }],
  ['ambient secret', x => { x.Config.Env.push('AWS_SECRET_ACCESS_KEY=synthetic'); }], ['deployment bypass', x => { x.Config.Env.push('PROVENANCE_DEPLOYMENT_WRITER=1'); }],
]) test(`refuse ${name}`, () => { const x = inspect(); mutate(x); assert.throws(() => check(x)); });
test('unknown or running release terminal state refuses candidate continuation', () => {
  assertStopped(inspect(), binding.owner);
  for (const State of [{ Running: true, Status: 'running' }, { Running: false, Status: 'dead' }, {}, { Running: false, Status: 'restarting' }]) assert.throws(() => assertStopped({ ...inspect(), State }, binding.owner));
  assert.throws(() => assertStopped(inspect(), 'different-owner'));
});
const old = { id: 'old', git_sha: pair.release.revision, image_digest: pair.release.manifest_digest, deployed_at: 'synthetic-first', actor: 'release' };
const added = { id: 'new', git_sha: pair.candidate.revision, image_digest: pair.candidate.manifest_digest, deployed_at: 'synthetic-second', actor: 'a2-synthetic-version-pair' };
test('old deployment fields exact and only one candidate record appended', () => {
  assertRecordTransition([old], [added, old], pair.candidate);
  for (const rows of [[old], [added], [old, { ...added, image_digest: pair.release.manifest_digest }], [{ ...old, deployed_at: 'changed' }, added], [old, added, { ...added, id: 'extra' }]]) assert.throws(() => assertRecordTransition([old], rows, pair.candidate));
});
test('cross-version business data loss and altered ledger fail preservation', () => {
  const before = { deployments: [old], ledger: [48], topics: ['old', 'long'], reports: ['r'], runs: [], model_attempts: [], dispatch: [] };
  assertPreserved(before, { ...before, deployments: [old, added] });
  for (const patch of [{ topics: ['old'] }, { ledger: [47] }, { reports: [] }, { dispatch: ['unexpected'] }, { model_attempts: ['model'] }]) assert.throws(() => assertPreserved(before, { ...before, ...patch }));
});
test('harness exact hash and single import adaptation; fixture/model semantics unchanged', () => {
  const bytes = readFileSync(join(root, 'ops/a2-business-matrix/fixture.mjs'));
  assert.equal(adaptImport(bytes, sharedHashes['fixture.mjs']).replace('from "./pair-in-image.mjs"', 'from "./in-image.mjs"'), bytes.toString());
  assert.throws(() => adaptImport(Buffer.concat([bytes, Buffer.from('changed')]), sharedHashes['fixture.mjs']));
  const missing = Buffer.from('no import'); assert.throws(() => adaptImport(missing, hash(missing)));
  const duplicate = Buffer.from('from "./in-image.mjs" from "./in-image.mjs"'); assert.throws(() => adaptImport(duplicate, hash(duplicate)));
  const directory = mkdtempSync(join(tmpdir(), 'a2-harness-guard-'));
  try { const evidence = prepareHarness(root, directory); assert.equal(evidence.length, 9); assert.ok(readFileSync(join(directory, 'pair-contracts.mjs'), 'utf8').includes("from './contracts.mjs'")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
test('inherited true HTTP writer/white-list/health guards retained', () => {
  assert.throws(() => assertWriter({ origin: 'SQL' })); assert.throws(() => assertVisible(['good', 'blocked'], ['good'])); assert.throws(() => assertStatus(200, 403));
  assert.throws(() => assertBusinessReady({ status: 200, body: { status: 'ok', data: { stale: false, staleDailyTopicCount: 0 } } }, { status: 500 }));
  for (const path of ['/api/cron', '/api/internal/generation-dispatch', '/api/topics/t/brief', '/api/reports/r/followup', 'https://example.test/api/reports']) assert.throws(() => assertHttpPath('POST', path));
});

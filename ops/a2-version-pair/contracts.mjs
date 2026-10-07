import assert from 'node:assert/strict';
import { assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady } from '../a2-business-matrix/contracts.mjs';
export { assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady };
export const repository = 'ghcr.io/dong-qiu/deep-insight-agent';
const descriptor = (revision, index_digest, manifest_digest, config_digest) => Object.freeze({
  schema_version: 'security-release-identity-v1', repository, platform: 'linux/amd64', revision,
  index_digest, manifest_digest, config_digest, compose_sha256: '984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd',
  deployment: Object.freeze({ status: 'blocked', safe_rollback: null }),
});
// Research descriptors passed only to preflight's test seam. Never write the deployment policy.
export const pair = Object.freeze({
  release: descriptor('81dac77cd27f82d7b554694bf0a12cd82cd0920b', 'sha256:1f4cdaa37e32db7eb5efd45aa77fec2777c62dc994f0d3ab3212e7753c9f8498', 'sha256:ea30cf753ba58ecabcd8462b2c6390f60aa2c124c6bf8a6aeef594b91927c255', 'sha256:3fd96d0701643b764e6d9beddd3d858718255902fc13079fd90ab7d01d0aacaa'),
  candidate: descriptor('a5253da8a4e9c40f8098235d6976e5a7b7f6eb71', 'sha256:5e180404edc7d7e0dbfddec11eb9d0251e2492acb6ca10e9160f767893630761', 'sha256:73f49e69b6247a57d362554ab34d839817ce2c38158ee9414881c904274b9d48', 'sha256:aecad7580aa87133e1ef43307cfd60e0e41feaa48ff787d7056d9f15dec16642'),
});
export const imageFor = identity => `${repository}@${identity.manifest_digest}`;
export function identityFor(role) { assert.ok(Object.hasOwn(pair, role), 'unknown pair role'); return pair[role]; }
export function assertResearchDescriptor(role, value) { assert.deepEqual(value, identityFor(role)); }
export function assertStopped(value, owner) {
  assert.equal(value.Config.Labels['org.insight-agent.a2-business-owner'], owner);
  assert.equal(value.State.Running, false); assert.equal(value.State.Status, 'exited');
}
export function assertContainer(value, { identity, owner, volume, harness, envKeys }) {
  assert.ok(Object.values(pair).includes(identity));
  assert.equal(value.Image, identity.config_digest); assert.equal(value.Config.Image, imageFor(identity));
  assert.equal(value.Config.Labels['org.opencontainers.image.revision'], identity.revision);
  assert.equal(value.Config.Labels['org.insight-agent.a2-business-owner'], owner);
  assert.equal(value.HostConfig.NetworkMode, 'none'); assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.ok(value.HostConfig.CapDrop.includes('ALL')); assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(value.HostConfig.Privileged, false); assert.deepEqual(value.HostConfig.PortBindings ?? {}, {});
  assert.ok(['app', '1001', '1001:1001'].includes(value.Config.User));
  assert.deepEqual(value.Config.Cmd, ['node', 'server.js']); assert.deepEqual(value.Config.Entrypoint, ['docker-entrypoint.sh']);
  assert.deepEqual(value.Mounts.map(m => [m.Type, m.Destination, m.Type === 'volume' ? m.Name : m.Source, m.RW]).sort(),
    [['bind', '/matrix', harness, false], ['volume', '/data', volume, true]].sort());
  const keys = value.Config.Env.map(x => x.split('=', 1)[0]);
  assert.deepEqual([...new Set(keys)].sort(), [...envKeys].sort());
  assert.ok(!keys.some(k => /^(?:AWS_|LLM_API_KEY|ANTHROPIC_API_KEY|ALERT_|SMTP_|DISPATCH_WORKER_SECRET|PROVENANCE_DEPLOYMENT_WRITER)/.test(k)));
  for (const [key, expected] of Object.entries({ PROVENANCE_SCHEMA_REQUIRED: '1', PROVENANCE_DEPLOYMENT_REQUIRED: '1', GIT_SHA: identity.revision,
    INSIGHT_IMAGE_DIGEST: identity.manifest_digest, HOSTNAME: '127.0.0.1', STALENESS_ALERT_HOURS: '1000000' })) assert.ok(value.Config.Env.includes(`${key}=${expected}`));
  return { id: value.Id, image: value.Image, manifest: identity.manifest_digest, revision: identity.revision, network: 'none', rootfs_readonly: true,
    mounts: value.Mounts.map(m => ({ type: m.Type, destination: m.Destination, rw: m.RW, ...(m.Name ? { name: m.Name } : {}) })) };
}
export function assertRecordTransition(before, after, identity) {
  assert.ok(Object.values(pair).includes(identity), 'only frozen candidate record identity');
  assert.equal(after.length, before.length + 1, 'exactly one candidate record appended');
  for (const old of before) assert.deepEqual(after.find(x => x.id === old.id), old, 'old record fields must remain exact');
  const added = after.filter(x => !before.some(old => old.id === x.id)); assert.equal(added.length, 1);
  assert.equal(added[0].git_sha, identity.revision); assert.equal(added[0].image_digest, identity.manifest_digest);
  assert.equal(added[0].actor, 'a2-synthetic-version-pair'); return added[0].id;
}
export function assertPreserved(before, after) {
  const { deployments: oldRecords, ...oldState } = before, { deployments: newRecords, ...newState } = after;
  assert.ok(oldRecords && newRecords); assert.deepEqual(newState, oldState, 'cross-version business state must remain exact');
}

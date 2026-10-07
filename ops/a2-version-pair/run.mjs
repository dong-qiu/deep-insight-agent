import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from '../aws/security-release-gate.mjs';
import { pair, imageFor, assertContainer, assertStopped } from './contracts.mjs';
import { prepareHarness } from './harness.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)), hostEnv = { PATH: process.env.PATH };
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
function docker(args, timeout = 60000, success = true) {
  const r = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { env: hostEnv, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.signal, null, 'unknown Docker client terminal state');
  if (success) assert.equal(r.status, 0, `isolated Docker ${args[0]} failed; status=${r.status}`);
  return { text: r.stdout.trim(), status: r.status };
}
export function sourceApi(directory, identity) {
  assert.ok(Object.values(pair).includes(identity), "source API only accepts the frozen pair");
  const source = join(directory, identity.revision); mkdirSync(source);
  const archive = execFileSync('git', ['archive', identity.revision], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', source], { input: archive });
  for (const file of ['package.json', 'package-lock.json']) assert.equal(hash(readFileSync(join(source, file))), hash(readFileSync(join(root, file))));
  execFileSync('ln', ['-s', join(root, 'node_modules'), join(source, 'node_modules')]);
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'ops/source-map-security.node-test.mjs'], {
    cwd: source, env: { PATH: process.env.PATH, HOME: source, NODE_ENV: 'test', DATA_DIR: source, DB_PATH: join(source, 'unused.db') }, timeout: 90000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  assert.match(output, /# pass 7/);
  return { revision: identity.revision, source_archive_sha256: hash(archive), source_map_magicast_api: '7 pass', layer: 'specified-source-installed-API-not-published-builder-execution' };
}
export async function runPair() {
  assert.notEqual(pair.release.manifest_digest, pair.candidate.manifest_digest);
  execFileSync('git', ['merge-base', '--is-ancestor', pair.candidate.revision, pair.release.revision], { cwd: root });
  assert.equal(git(['diff', '--name-only', pair.candidate.revision, pair.release.revision, '--', 'src', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml']), '');
  const directory = mkdtempSync(join(tmpdir(), 'a2-version-pair-')), harness = join(directory, 'harness'); mkdirSync(harness, { mode: 0o755 });
  const owner = `a2-pair-${randomBytes(10).toString('hex')}`, label = 'org.insight-agent.a2-business-owner', volumes = [], containers = [], transient = [];
  const event = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)) : null;
  const evidence = { schema_version: 'a2-version-pair-v1', started_at: new Date().toISOString(), owner,
    tool: { base: git(['merge-base', 'HEAD', 'origin/main']), head: event?.pull_request?.head?.sha ?? git(['rev-parse', 'HEAD']), tested: git(['rev-parse', 'HEAD']), run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    research_pair: pair, identity: {}, sources: [], native: [], stages: [], failures: [], safe_rollback: null, deployment_permitted: false, rollback_permitted: false,
    production_compatibility: 'unverified', real_model_quality: 'not-executed-budget-zero', resolves_common_payload_startup_fault: false };
  let serial = 0;
  function volumeFor(name) { const value = `${owner}-${name}`; docker(['volume', 'create', '--label', `${label}=${owner}`, value]); volumes.push(value); return value; }
  const synthetic = { AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_EMAIL: 'admin@a2.example.test', ADMIN_PASSWORD: randomBytes(24).toString('hex'), A2_VIEWER_PASSWORD: randomBytes(24).toString('hex') };
  const envPaths = {}, envKeys = {};
  function baseArgs(role, volume) { return ['--pull=never', '--platform', 'linux/amd64', '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '2', '--tmpfs', '/tmp:rw,mode=1777', '--env-file', envPaths[role], '--label', `${label}=${owner}`, '--mount', `type=volume,src=${volume},dst=/data`, '--mount', `type=bind,src=${harness},dst=/matrix,readonly`]; }
  function oneShot(role, volume, command, extra = [], success = true) {
    const name = `${owner}-oneshot-${++serial}`; transient.push(name);
    return docker(['run', '--rm', '--name', name, ...baseArgs(role, volume), ...extra, imageFor(pair[role]), ...command], 120000, success);
  }
  function app(role, volume, name) {
    const id = docker(['create', '--name', `${owner}-${name}`, ...baseArgs(role, volume), imageFor(pair[role])]).text; containers.push(id);
    const inspect = () => assertContainer(JSON.parse(docker(['inspect', id]).text)[0], { identity: pair[role], owner, volume, harness, envKeys: envKeys[role] });
    const start = inspect(); docker(['start', id]); return { id, start, inspect,
      probe: (script, ...args) => JSON.parse(docker(['exec', id, 'node', `/matrix/${script}`, ...args], 120000).text),
      stop: () => { docker(['stop', '--time', '10', id]); const raw = JSON.parse(docker(['inspect', id]).text)[0]; assertStopped(raw, owner); return { id, stopped: true }; } };
  }
  try {
    evidence.harness = prepareHarness(root, harness);
    for (const [role, descriptor] of Object.entries(pair)) {
      evidence.sources.push(sourceApi(directory, descriptor));
      const identity = await preflight({ policy: descriptor, request: { image_tag: `sha-${descriptor.revision}`, approved_index_digest: descriptor.index_digest, approved_manifest_digest: descriptor.manifest_digest, approved_config_digest: descriptor.config_digest },
        run: (command, args, options) => {
          assert.equal(command, 'docker'); const r = spawnSync(command, args, { ...options, env: { ...hostEnv, DOCKER_HOST: 'unix:///var/run/docker.sock', INSIGHT_IMAGE: imageFor(descriptor), GIT_SHA: descriptor.revision, INSIGHT_IMAGE_DIGEST: descriptor.manifest_digest }, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
          assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, 'research preflight failed'); return r.stdout;
        } });
      evidence.identity[role] = { ...identity, scope: 'research-identity-only-never-deployment-policy-approval' };
      const env = { ...synthetic, PROVENANCE_SCHEMA_REQUIRED: '1', PROVENANCE_DEPLOYMENT_REQUIRED: '1', GIT_SHA: descriptor.revision, INSIGHT_IMAGE_DIGEST: descriptor.manifest_digest, HOSTNAME: '127.0.0.1', STALENESS_ALERT_HOURS: '1000000', DEPLOY_ACTOR: 'a2-synthetic-version-pair', A2_PAIR_ROLE: role };
      envPaths[role] = join(directory, `${role}.env`); writeFileSync(envPaths[role], Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
      const info = JSON.parse(docker(['image', 'inspect', imageFor(descriptor)]).text)[0]; envKeys[role] = [...new Set([...info.Config.Env.map(x => x.split('=', 1)[0]), ...Object.keys(env)])];
    }
    const volume = volumeFor('business');
    oneShot('release', volume, ['node', '-e', "require('node:fs').chownSync('/data',1001,1001)"], ['--user', '0', '--cap-add=CHOWN']);
    oneShot('release', volume, ['node', '/app/ops/run-provenance-migrations.mjs']); oneShot('release', volume, ['node', '/app/ops/record-deployment.mjs']);
    evidence.native.push(JSON.parse(oneShot('release', volume, ['node', '/matrix/pair-probe.mjs', 'native']).text));
    const release = app('release', volume, 'release'), ready = release.probe('http-probe.mjs', 'ready'), fixture = release.probe('fixture.mjs'), matrix = release.probe('http-probe.mjs', 'matrix');
    docker(['restart', '--time', '10', release.id]); const restart = release.probe('http-probe.mjs', 'restart');
    const saved = release.probe('pair-probe.mjs', 'save-release'), stopped = release.stop();
    evidence.stages.push({ role: 'release', container: release.start, end: release.inspect(), ready, fixture, matrix, restart, saved, stopped });
    // No candidate one-shot or server may consume the same data until exact release terminal state is known.
    assertStopped(JSON.parse(docker(['inspect', release.id]).text)[0], owner);
    const beforeRecord = JSON.parse(oneShot('candidate', volume, ['node', '/matrix/pair-probe.mjs', 'snapshot']).text);
    oneShot('candidate', volume, ['node', '/app/ops/run-provenance-migrations.mjs']);
    const afterMigration = JSON.parse(oneShot('candidate', volume, ['node', '/matrix/pair-probe.mjs', 'snapshot']).text); assert.deepEqual(afterMigration, beforeRecord);
    const invalid = oneShot('candidate', volume, ['node', '/app/ops/record-deployment.mjs'], ['--env', 'INSIGHT_IMAGE_DIGEST='], false); assert.notEqual(invalid.status, 0);
    assert.deepEqual(JSON.parse(oneShot('candidate', volume, ['node', '/matrix/pair-probe.mjs', 'snapshot']).text), beforeRecord);
    oneShot('candidate', volume, ['node', '/app/ops/record-deployment.mjs']);
    evidence.native.push(JSON.parse(oneShot('candidate', volume, ['node', '/matrix/pair-probe.mjs', 'native']).text));
    const candidate = app('candidate', volume, 'candidate'), cross = candidate.probe('pair-probe.mjs', 'candidate');
    docker(['restart', '--time', '10', candidate.id]); const candidateRestart = candidate.probe('pair-probe.mjs', 'restart');
    const finalSnapshot = candidate.probe('pair-probe.mjs', 'save-final');
    const candidateStopped = candidate.stop(); evidence.stages.push({ role: 'candidate', container: candidate.start, end: candidate.inspect(), cross, restart: candidateRestart, final_snapshot: finalSnapshot, stopped: candidateStopped });
    for (const kind of ['checksum', 'record']) {
      const fault = volumeFor(`fault-${kind}`);
      // SQLite backup includes committed WAL after either graceful or forced exit; both exact Web owners must already be stopped.
      assertStopped(JSON.parse(docker(['inspect', release.id]).text)[0], owner); assertStopped(JSON.parse(docker(['inspect', candidate.id]).text)[0], owner);
      oneShot('candidate', fault, ['node', '-e', "require('node:fs').chownSync('/data',1001,1001)"], ['--user', '0', '--cap-add=CHOWN']);
      // Source SQL connection is readonly. This exclusive synthetic mount allows SQLite WAL/SHM coordination only.
      const copy = JSON.parse(oneShot('candidate', fault, ['node', '/matrix/copy-probe.mjs'], ['--mount', `type=volume,src=${volume},dst=/source`]).text);
      assert.equal(copy.state_sha256, finalSnapshot.state_sha256); assert.equal(copy.deployment_rows_sha256, finalSnapshot.deployment_rows_sha256);
      assert.deepEqual(copy.all_tables, finalSnapshot.table_hashes);
      const prepare = JSON.parse(oneShot('candidate', fault, ['node', '/matrix/failure-probe.mjs', 'prepare', kind]).text);
      const before = JSON.parse(oneShot('candidate', fault, ['node', '/matrix/pair-probe.mjs', 'snapshot']).text);
      if (kind === 'checksum') assert.notEqual(oneShot('candidate', fault, ['node', '/app/ops/run-provenance-migrations.mjs'], [], false).status, 0);
      const failing = app('candidate', fault, `fault-${kind}`), result = failing.probe('failure-probe.mjs', 'probe', kind);
      const after = failing.probe('pair-probe.mjs', 'snapshot'); assert.deepEqual(after, before);
      evidence.failures.push({ kind, copy, prepare, before, after, result, identity: failing.inspect(), stopped: failing.stop() });
    }
    evidence.finished_at = new Date().toISOString(); evidence.result = 'pass'; return evidence;
  } finally {
    for (const name of transient) {
      const r = docker(['inspect', name], 60000, false);
      if (r.status === 0) { const x = JSON.parse(r.text)[0]; assert.equal(x.Config.Labels[label], owner); docker(['rm', '--force', x.Id]); }
      else assert.equal(r.status, 1, 'unknown transient inspection');
    }
    for (const id of containers) { const x = JSON.parse(docker(['inspect', id]).text)[0]; assert.equal(x.Config.Labels[label], owner); docker(['rm', '--force', id]); }
    for (const volume of volumes) { const x = JSON.parse(docker(['volume', 'inspect', volume]).text)[0]; assert.equal(x.Labels[label], owner); docker(['volume', 'rm', volume]); }
    rmSync(directory, { recursive: true, force: true });
  }
}

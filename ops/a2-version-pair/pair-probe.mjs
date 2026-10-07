import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dbAt, snapshot, hash, bundleIdentity, topicId, reportIds, leadId, cases, expectedLeads, expectedInsights } from './pair-in-image.mjs';
import { identityFor, assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady, assertRecordTransition, assertPreserved } from './pair-contracts.mjs';
const phase = process.argv[2], identity = identityFor(process.env.A2_PAIR_ROLE), observations = [];
const db = dbAt(), records = () => db.prepare('SELECT * FROM deployment_record ORDER BY id').all(), state = () => snapshot(db);
const jsonFile = name => JSON.parse(readFileSync(`/data/${name}.json`));
function artifactHashes() { return reportIds.map(id => [id, hash(readFileSync(`/data/reports/${id}.md`))]); }
async function request(path, { method = 'GET', cookies, body, headers = {}, auth = false } = {}) {
  assertHttpPath(method, path);
  const res = await fetch(`http://127.0.0.1:3000${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { ...(cookies ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...headers }, body });
  if (cookies) for (const raw of res.headers.getSetCookie()) { const p = raw.split(';', 1)[0], n = p.indexOf('='); if (n > 0) cookies.set(p.slice(0, n), p.slice(n + 1)); }
  const text = await res.text(); observations.push({ method, path: path.split('?', 1)[0], status: res.status, ...(auth ? {} : { body_sha256: hash(text) }) });
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const json = (path, cookies, value, headers = {}) => request(path, { method: 'POST', cookies, body: JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } });
async function login(email, password) {
  const jar = new Map(), csrf = await request('/api/auth/csrf', { cookies: jar, auth: true }); assertStatus(csrf.status, 200);
  const result = await request('/api/auth/callback/credentials', { cookies: jar, method: 'POST', auth: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken: csrf.body.csrfToken, email, password }) });
  assertStatus(result.status, 302); assertStatus((await request('/api/reports', { cookies: jar })).status, 200); return jar;
}
async function ready() {
  for (let n = 0; n < 60; n++) { try { const r = await request('/api/health'); if (r.status === 200) { assertBusinessReady(r, { status: 200 }); return; } } catch { /* bounded startup */ } await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('business initialization did not become ready');
}
async function blockedNetwork() {
  const results = [];
  for (const [address, port] of [['1.1.1.1', 443], ['169.254.169.254', 80]]) {
    const code = await new Promise((resolve, reject) => {
      const socket = connect({ host: address, port }); socket.setTimeout(2000);
      socket.once('connect', () => { socket.destroy(); reject(new Error('network unexpectedly reachable')); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('network rejection not demonstrated')); });
      socket.once('error', err => { socket.destroy(); resolve(err.code); });
    }); assert.equal(code, 'ENETUNREACH'); results.push({ address, port, code });
  } return results;
}
async function readers(admin, viewer) {
  assertStatus((await request('/api/reports')).status, 401);
  assertStatus((await request('/api/reports', { cookies: new Map([['authjs.session-token', 'invalid-synthetic-cookie']]) })).status, 401);
  assertStatus((await request('/api/admin/users', { cookies: viewer })).status, 403);
  const before = state(); assertStatus((await json('/api/admin/topics', viewer, { id: 't_denied', name: 'denied' })).status, 403); assert.deepEqual(state(), before);
  assertBusinessReady(await request('/api/health'), await request('/api/admin/users', { cookies: admin }));
  for (const id of ['t_http_a1b2c3d4', 't_http_0123456789abcdef0123456789abcdef']) assert.ok((await request(`/topics/${id}`, { cookies: viewer })).text.includes(`A2 HTTP updated ${id}`));
  assertVisible((await request(`/api/leads?topic=${topicId}`, { cookies: viewer })).body.items.map(x => x.id), expectedLeads);
  const graph = await request(`/api/graph/drill?topic=${topicId}&a=Atlas`, { cookies: viewer }); assertStatus(graph.status, 200);
  assertVisible(graph.body.items.flatMap(x => x.occurrences.map(o => o.id)), expectedInsights);
  for (const mode of cases.filter(x => !['valid_old', 'valid_long'].includes(x))) assertStatus((await request(`/api/leads/${leadId(mode)}`, { cookies: viewer })).status, 404);
  for (const [n, id] of reportIds.entries()) { const r = await request(`/reports/${id}`, { cookies: viewer }); assertStatus(r.status, 200); assert.ok(r.text.includes(`A2_SNAPSHOT_BODY_${n}`)); }
}
let result;
if (phase === 'native') {
  const require = createRequire('/app/package.json'); assert.equal(require('source-map-js/package.json').version, '1.2.2');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '/matrix/native.node-test.mjs'], { cwd: '/app', env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 80000, maxBuffer: 128 * 1024 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /# pass 6/);
  result = { phase, bundle: bundleIdentity(), runtime_source_map: '1.2.2', native_six: 'pass' };
} else if (phase === 'save-release') {
  const value = { state: state(), deployment_rows: records(), report_hashes: artifactHashes(), bundle: bundleIdentity() };
  writeFileSync('/data/pair-release.json', JSON.stringify(value)); result = { phase, state_sha256: hash(JSON.stringify(value.state)), records_sha256: hash(JSON.stringify(value.deployment_rows)), bundle: value.bundle };
} else if (phase === 'candidate' || phase === 'restart') {
  await ready(); const network = await blockedNetwork(), bundle = bundleIdentity(), release = jsonFile('pair-release');
  const current = state();
  if (phase === 'candidate') { assertPreserved(release.state, current); assertRecordTransition(release.deployment_rows, records(), identity); }
  else { const before = jsonFile('pair-candidate'); assert.deepEqual(current, before.state); assert.deepEqual(records(), before.deployment_rows); assert.deepEqual(bundle, before.bundle); }
  assert.deepEqual(artifactHashes(), release.report_hashes);
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD), viewer = await login('viewer@a2.example.test', process.env.A2_VIEWER_PASSWORD);
  await readers(admin, viewer);
  let writer;
  if (phase === 'candidate') {
    const before = state(), path = `/api/leads/${leadId('valid_old')}`;
    const changed = await json(path, admin, { status: 'watching' }, { 'Idempotency-Key': 'a2-version-pair-candidate-write' }); assertStatus(changed.status, 200);
    const after = state(), trace = changed.body.trace_id; assert.ok(trace); assert.equal(after.traces.length, before.traces.length + 1);
    writer = { origin: 'http', entry: path, response_status: changed.status, requested_status: 'watching', trace_id: trace,
      persisted_status: db.prepare('SELECT status FROM tech_lead WHERE id=?').get(leadId('valid_old')).status,
      persisted_trace_id: db.prepare('SELECT id FROM generation_trace WHERE id=?').get(trace).id,
      events: after.events.filter(x => x.trace_id === trace).length, released_lease: after.leases.find(x => x.trace_id === trace).state === 'released' };
    assertWriter(writer); assert.equal(after.refs.filter(x => x.trace_id === trace).length, 3);
    const replay = await json(path, admin, { status: 'watching' }, { 'Idempotency-Key': 'a2-version-pair-candidate-write' });
    assertStatus(replay.status, 200); assert.equal(replay.body.trace_id, trace); assert.equal(replay.body.replayed, true); assert.deepEqual(state(), after);
    for (const key of ['ledger', 'deployments', 'topics', 'users', 'reports', 'effects', 'runs', 'model_attempts', 'dispatch']) assert.deepEqual(after[key], before[key]);
    writeFileSync('/data/pair-candidate.json', JSON.stringify({ state: after, deployment_rows: records(), bundle, writer }));
  } else writer = jsonFile('pair-candidate').writer;
  result = { phase, bundle, release_bundle: release.bundle, network, observations, writer, state_sha256: hash(JSON.stringify(state())),
    ledger_sha256: hash(JSON.stringify(state().ledger)), report_hashes: artifactHashes(), production_compatibility: 'unverified', permissions: false };
} else if (phase === 'snapshot') { result = { phase, state_sha256: hash(JSON.stringify(state())), deployment_rows_sha256: hash(JSON.stringify(records())) }; }
else throw new Error('unknown phase');
db.close(); console.log(JSON.stringify(result));

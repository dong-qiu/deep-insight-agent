import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { register } from 'tsx/esm/api';
import { initialize, openLedger } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';
import { openDrainLeaseSource, observeDrain } from './drain.mjs';

register();
const { openDb } = await import('../../src/lib/db/index.ts');
const { applyProvenanceMigrations } = await import('../../src/lib/db/provenance-migrations.ts');
const { insertTopic, insertSource } = await import('../../src/lib/db/repos.ts');
const { createDeepDiveTraceRequest, claimNextGenerationDispatch, createSourceCollectTrace, claimSourceCollectTrace } = await import('../../src/lib/db/provenance.ts');
const { runGenerationDispatchOnce } = await import('../../src/lib/agents/generation-dispatch.ts');

function fixture(t, { journalMode = 'WAL' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'insight-a3-drain-'))); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync('ed25519');
  const target = { region: 'isolated', instanceId: 'fixture-app', volumeId: 'fixture-data', dataPath: root, serviceSet: ['app'] };
  initialize(root, { target, approverId: 'fixture-reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  initializeWriters(root);
  const path = join(root, 'fixture-business.sqlite'); const db = openDb(path); chmodSync(path, 0o600);
  applyProvenanceMigrations(db);
  insertTopic(db, { id: 'topic_a', name: 'Topic A', keywords: [], language: 'en', brief_schedule: 'daily', enabled: true, archetype: 'deep_vertical', facets: [] });
  insertSource(db, { id: 'synthetic_source', name: 'Synthetic Source', type: 'rss', endpoint: 'https://fixture.invalid/feed', topic_ids: ['topic_a'], fetch_interval: 3600, enabled: true });
  // Close the actual migration/seed connection; readonly observation opens an already-built fixture.
  db.pragma('wal_checkpoint(TRUNCATE)'); if (journalMode === 'DELETE') db.pragma('journal_mode=DELETE'); db.close();
  const source = openDrainLeaseSource(root, path); const writers = openWriters(root); const ledger = openLedger(root);
  t.after(() => { source.close(); writers.close(); ledger.close(); rmSync(root, { recursive: true }); });
  const request = { operationId: 'op-drain', ownerId: 'controller-one', kind: 'backup', target, executionIdentity: 'fixture-controller-one' };
  const mutate = fn => { const d = openDb(path, { bootstrap: false }); try { return fn(d); } finally { d.close(); } };
  const accept = () => mutate(d => createDeepDiveTraceRequest(d, { topicId: 'topic_a', idempotencyKeyHash: 'a'.repeat(64), planning: true }));
  const facts = () => mutate(d => ['generation_dispatch', 'generation_lease', 'run'].map(table => d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return { root, path, db, source, writers, ledger, request, mutate, accept, facts };
}
function blocked(sample) {
  assert.equal(sample.drain_ready, false); assert.equal(sample.writer_quiescence, false);
  assert.equal(sample.production_permitted, false); assert.equal(sample.process_termination, 'unknown');
}
function opts(f, extra = {}) { return { root: f.root, request: f.request, leaseSource: f.source, deadlineAt: Date.now() + 500, pollEveryMs: 5, ...extra }; }

test('real queued and claimed independent epochs are observations; business facts remain unchanged', t => {
  const f = fixture(t); f.accept(); let before = f.facts(); let sample = f.source.sample(Date.now());
  assert.equal(sample.queued, 1); assert.equal(sample.unknown, 0); blocked(sample); assert.deepEqual(f.facts(), before);
  f.mutate(d => { claimNextGenerationDispatch(d); d.exec('UPDATE generation_lease SET fencing_epoch=9'); });
  before = f.facts(); sample = f.source.sample(Date.now()); assert.equal(sample.claimedCurrent, 1); assert.equal(sample.unknown, 0); blocked(sample);
  assert.deepEqual(f.facts(), before);
  f.mutate(d => { d.exec("UPDATE generation_dispatch SET lease_expires_at='2000-01-01T00:00:00.000Z'; UPDATE generation_lease SET expires_at='2000-01-01T00:00:00.000Z'"); });
  before = f.facts(); sample = f.source.sample(Date.now()); assert.equal(sample.claimedExpired, 1); blocked(sample); assert.deepEqual(f.facts(), before);
});

test('real source-collect active leases without dispatch cannot disappear through a JOIN', t => {
  const f = fixture(t);
  const accepted = f.mutate(d => createSourceCollectTrace(d, { sourceId: 'synthetic_source' }));
  assert.equal(accepted.kind, 'accepted'); let sample = f.source.sample(Date.now()); assert.ok(sample.unknown > 0); blocked(sample);
  f.mutate(d => claimSourceCollectTrace(d, accepted.traceId));
  f.accept(); sample = f.source.sample(Date.now()); assert.equal(sample.queued, 1); assert.ok(sample.unknown > 0); blocked(sample);
  assert.equal(f.mutate(d => d.prepare('SELECT count(*) AS n FROM generation_dispatch d JOIN generation_lease l ON l.trace_id=d.trace_id').get()).n, 1);
});

test('owner/expiry/epoch/state and missing/ambiguous lease counterexamples remain unknown', t => {
  const f = fixture(t); f.accept(); f.mutate(d => claimNextGenerationDispatch(d));
  const faults = [
    "UPDATE generation_lease SET owner_token='other-owner'", "UPDATE generation_lease SET expires_at='2001-01-01T00:00:00.000Z'",
    'UPDATE generation_dispatch SET claim_epoch=-1', 'UPDATE generation_lease SET fencing_epoch=1.5',
    'UPDATE generation_dispatch SET claim_epoch=9007199254740992', "UPDATE generation_dispatch SET state='alien'",
    "UPDATE generation_lease SET state='alien'", "UPDATE generation_dispatch SET lease_expires_at='bad-time'",
    'DELETE FROM generation_lease',
    "INSERT INTO generation_lease SELECT 'duplicate-lease','another-key',scope_key,trace_id,state,owner_token,fencing_epoch,heartbeat_at,expires_at,created_at,released_at FROM generation_lease",
  ];
  const baseline = f.facts();
  for (const sql of faults) {
    f.mutate(d => d.exec(sql)); const before = f.facts(); const s = f.source.sample(Date.now());
    assert.ok(s.unknown > 0, sql); blocked(s); assert.deepEqual(f.facts(), before);
    f.mutate(d => d.transaction(() => {
      for (const [i, table] of ['generation_dispatch', 'generation_lease'].entries()) {
        d.exec(`DELETE FROM ${table}`);
        for (const row of baseline[i]) d.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      }
    })());
  }
});

test('finite unfinished writer timeout permanently holds; late local completion and restart cannot release', async t => {
  const f = fixture(t); f.accept(); f.mutate(d => claimNextGenerationDispatch(d));
  const task = f.writers.admit(f.writers.register('worker-one', 'generation-dispatch')); const before = f.facts();
  const result = await observeDrain(opts(f, { deadlineAt: Date.now() + 200 })); blocked(result);
  assert.equal(result.reason, 'writer_drain_timeout'); assert.equal(f.writers.inspect().admission, 'closed');
  assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held'); assert.deepEqual(f.facts(), before);
  f.writers.finish(task, 'done'); const replay = await observeDrain(opts(f)); blocked(replay); assert.equal(replay.reason, 'writer_drain_replay');
  assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held');
});

test('invalid inputs and unsafe source are rejected before close/acquire; empty/completed writers never ready', async t => {
  const f = fixture(t);
  for (const changes of [{ deadlineAt: Date.now() - 1 }, { deadlineAt: Date.now() + 120_000 }, { pollEveryMs: 0 }, { request: { ...f.request, target: { ...f.request.target, volumeId: 'fixture-other' } } }]) {
    await assert.rejects(observeDrain(opts(f, changes))); assert.equal(f.writers.inspect().admission, 'open'); assert.equal(f.ledger.inspect().active, null);
  }
  chmodSync(f.path, 0o644); await assert.rejects(observeDrain(opts(f)), /unsafe_drain_path/); chmodSync(f.path, 0o600);
  assert.equal(f.writers.inspect().admission, 'open'); assert.equal(f.ledger.inspect().active, null);
  const result = await observeDrain(opts(f)); blocked(result); assert.equal(result.reason, 'writer_drain_coverage_unknown');
});

test('cancellation preserves first fixed reason and only stops waiting, not business tasks', async t => {
  const f = fixture(t); const task = f.writers.admit(f.writers.register('worker-one', 'generation-dispatch'));
  const controller = new AbortController(); const pending = observeDrain(opts(f, { signal: controller.signal }));
  controller.abort({ reasonCode: 'cancelled' }); controller.abort({ reasonCode: 'task_deadline_exceeded' });
  const result = await pending; blocked(result); assert.equal(result.reason, 'cancelled');
  assert.equal(f.writers.inspect().tasks[0].outcome, null); f.writers.finish(task, 'failed');
  assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held');
});

test('first cancellation survives a later real source failure; failed observation returns no stale sample', async t => {
  const f = fixture(t); f.accept();
  f.writers.admit(f.writers.register('cancel-race-worker', 'generation-dispatch'));
  const before = f.facts(), controller = new AbortController();
  const pending = observeDrain(opts(f, { signal: controller.signal }));
  controller.abort({ reasonCode: 'cancelled' });
  f.source.close(); controller.abort({ reasonCode: 'task_deadline_exceeded' });
  const result = await pending; blocked(result);
  assert.equal(result.reason, 'cancelled'); assert.equal(result.sample, null);
  const op = f.ledger.inspect().operations[f.request.operationId];
  assert.equal(op.disposition, 'held'); assert.deepEqual(op.failures, ['cancelled']);
  assert.equal(f.writers.inspect().admission, 'closed'); assert.equal(f.writers.inspect().tasks[0].outcome, null);
  assert.deepEqual(f.facts(), before);
});

test('cancel and failed observation cannot hide old revision or foreign owner/fence at final hold', async t => {
  for (const change of ['revision', 'owner-fence']) {
    const f = fixture(t); f.accept();
    f.writers.admit(f.writers.register('cancel-owner-race-worker', 'generation-dispatch'));
    const before = f.facts(), controller = new AbortController();
    const pending = observeDrain(opts(f, { signal: controller.signal }));
    controller.abort({ reasonCode: 'cancelled' }); f.source.close();
    const op = f.ledger.inspect().operations[f.request.operationId];
    const token = { operationId: op.operationId, ownerId: op.ownerId, fence: op.fence, revision: op.revision,
      target: op.target, executionIdentity: op.executionIdentity };
    if (change === 'revision') f.ledger.hold(token, 'external_hold');
    else {
      f.ledger.complete(token);
      f.ledger.acquire({ ...f.request, operationId: 'op-foreign', ownerId: 'foreign-owner', executionIdentity: 'fixture-foreign-controller' });
    }
    const changed = f.ledger.inspect();
    await assert.rejects(pending, /drain_owner_revision_lost/);
    assert.deepEqual(f.ledger.inspect(), changed); assert.deepEqual(f.facts(), before);
    assert.equal(f.writers.inspect().admission, 'closed'); assert.equal(f.writers.inspect().tasks[0].outcome, null);
  }
});

test('foreign/fake/closed source and malformed request cannot mutate either maintenance sidecar', async t => {
  const f = fixture(t), other = fixture(t); const before = f.ledger.inspect();
  for (const extra of [{ leaseSource: other.source }, { leaseSource: { sample: () => ({ drain_ready: true }) } },
    { request: { ...f.request, extra: true } }, { request: { ...f.request, executionIdentity: 'production-controller' } },
    { pollEveryMs: 1001 }, { deadlineAt: Number.NaN }, { signal: {} }]) {
    await assert.rejects(observeDrain(opts(f, extra))); assert.equal(f.writers.inspect().admission, 'open'); assert.deepEqual(f.ledger.inspect(), before);
  }
  f.source.close(); await assert.rejects(observeDrain(opts(f)), /drain_source_unavailable/);
  assert.equal(f.writers.inspect().admission, 'open'); assert.deepEqual(f.ledger.inspect(), before);
});

test('pre-cancelled input does not close or acquire; first deadline reason remains fixed', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort({ reasonCode: 'task_deadline_exceeded' });
  const result = await observeDrain(opts(f, { signal: controller.signal })); blocked(result);
  assert.equal(result.reason, 'task_deadline_exceeded'); assert.equal(f.writers.inspect().admission, 'open'); assert.equal(f.ledger.inspect().active, null);
});

test('all existing operation phases are readonly replay; conflicting identity refuses without side effects', async t => {
  const f = fixture(t); let token = f.ledger.acquire(f.request);
  for (const phase of ['pre_submit', 'submission_unknown', 'held', 'released']) {
    if (phase === 'submission_unknown') token = f.ledger.beginSubmit(token, 'a'.repeat(64));
    if (phase === 'held') token = f.ledger.hold(token, 'fixture_hold');
    if (phase === 'released') {
      // Another actual operation exercises a legitimate pre_submit complete without signed takeover.
      const fresh = fixture(t); const active = fresh.ledger.acquire(fresh.request); fresh.ledger.complete(active);
      const before = fresh.ledger.inspect(); const result = await observeDrain(opts(fresh)); blocked(result);
      assert.equal(result.reason, 'writer_drain_replay'); assert.deepEqual(fresh.ledger.inspect(), before); assert.equal(fresh.writers.inspect().admission, 'open'); continue;
    }
    const before = f.ledger.inspect(); const result = await observeDrain(opts(f)); blocked(result);
    assert.equal(result.reason, 'writer_drain_replay'); assert.deepEqual(f.ledger.inspect(), before); assert.equal(f.writers.inspect().admission, 'open');
  }
  const before = f.ledger.inspect(); await assert.rejects(observeDrain(opts(f, { request: { ...f.request, ownerId: 'other-owner' } })), /maintenance_operation_conflict/);
  assert.deepEqual(f.ledger.inspect(), before); assert.equal(f.writers.inspect().admission, 'open');
});

test('close persists when acquire is busy; existing operation is never held by a foreign controller', async t => {
  const f = fixture(t); const token = f.ledger.acquire({ ...f.request, operationId: 'op-other' }); const before = f.ledger.inspect();
  await assert.rejects(observeDrain(opts(f)), /maintenance_busy/); assert.equal(f.writers.inspect().admission, 'closed');
  assert.deepEqual(f.ledger.inspect(), before); assert.equal(f.ledger.inspect().operations[token.operationId].disposition, 'active');
});

test('observation failure after acquire holds; concurrent revision cannot be overwritten', async t => {
  const f = fixture(t); f.writers.admit(f.writers.register('worker-one', 'generation-dispatch'));
  const pending = observeDrain(opts(f)); setImmediate(() => f.source.close());
  const result = await pending; blocked(result); assert.equal(result.reason, 'writer_drain_observation_failed'); assert.equal(result.sample, null);
  assert.deepEqual(f.ledger.inspect().operations['op-drain'].failures, ['writer_drain_observation_failed']);
  assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held');
  const other = fixture(t); other.writers.admit(other.writers.register('worker-one', 'generation-dispatch'));
  const second = observeDrain(opts(other));
  setImmediate(() => { const op = other.ledger.inspect().operations['op-drain']; other.ledger.hold({ operationId: op.operationId, ownerId: op.ownerId, fence: op.fence, revision: op.revision, target: op.target, executionIdentity: op.executionIdentity }, 'external_hold'); });
  await assert.rejects(second, /drain_owner_revision_lost/);
  assert.deepEqual(other.ledger.inspect().operations['op-drain'].failures, ['external_hold']);
});

test('wall-clock rollback cannot extend the bounded monotonic deadline and timers/listeners are cleared', async t => {
  const f = fixture(t); f.writers.admit(f.writers.register('worker-one', 'generation-dispatch'));
  const controller = new AbortController(), listeners = new Set(); const signal = controller.signal;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (kind, listener, options) => { if (kind === 'abort') listeners.add(listener); return add(kind, listener, options); };
  signal.removeEventListener = (kind, listener, options) => { listeners.delete(listener); return remove(kind, listener, options); };
  const now = Date.now, start = performance.now(); const pending = observeDrain(opts(f, { deadlineAt: Date.now() + 200, signal }));
  Date.now = () => now() - 3_600_000;
  try { const result = await pending; blocked(result); assert.equal(result.reason, 'writer_drain_timeout'); assert.ok(performance.now() - start < 1000); assert.equal(listeners.size, 0); }
  finally { Date.now = now; }
});

test('path replacement, hardlink, symlink, marker mutation and unsafe sidecar refuse before source SQL', t => {
  const f = fixture(t);
  assert.throws(() => openDrainLeaseSource(f.root, ':memory:'), /drain_business_scope_mismatch/);
  const link = join(f.root, 'hardlink.sqlite'); linkSync(f.path, link); assert.throws(() => f.source.sample(Date.now()), /unsafe_drain_path/); rmSync(link);
  const journal = `${f.path}-journal`; writeFileSync(journal, 'synthetic unsafe sidecar', { mode: 0o644 });
  chmodSync(journal, 0o644);
  assert.throws(() => f.source.sample(Date.now()), /unsafe_drain_path/); assert.throws(() => openDrainLeaseSource(f.root, f.path), /unsafe_drain_path/); rmSync(journal);
  const saved = `${f.path}.saved`; renameSync(f.path, saved); copyFileSync(saved, f.path); chmodSync(f.path, 0o600);
  assert.throws(() => f.source.sample(Date.now()), /drain_business_file_replaced/); rmSync(f.path); symlinkSync(saved, f.path);
  assert.throws(() => f.source.sample(Date.now()), /unsafe_drain_path/); rmSync(f.path); renameSync(saved, f.path);
  writeFileSync(join(f.root, 'isolation.json'), '{}'); assert.throws(() => f.source.sample(Date.now()), /invalid_maintenance_record/);
});

const bytes = path => ({ size: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
test('actual SIGKILL hot journal unsafe permissions preserve original DB/journal on existing and new readonly handles', t => {
  const f = fixture(t, { journalMode: 'DELETE' });
  // Actual openDb configures WAL; close its seed connection and restore DELETE before opening this observer.
  f.source.close(); f.accept();
  const reset = spawnSync(process.execPath, ['--input-type=module', '-e', "import Database from 'better-sqlite3';const d=new Database(process.argv[1]);d.pragma('journal_mode=DELETE');d.close();", f.path], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe' });
  assert.equal(reset.status, 0, reset.stderr.toString());
  const source = openDrainLeaseSource(f.root, f.path); t.after(() => source.close());
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3'; const d=new Database(process.argv[1]);
    d.pragma('journal_mode=DELETE'); d.pragma('cache_size=1'); d.exec('BEGIN IMMEDIATE');
    d.exec("UPDATE generation_dispatch SET state='alien'");
    const insert=d.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES (?,'analyze','{}','running','2026-10-08T00:00:00.000Z')");
    for(let i=0;i<10000;i++) insert.run('crash-run-'+i); process.kill(process.pid,'SIGKILL');`, f.path], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe' });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString()); const journal = `${f.path}-journal`; assert.ok(statSync(journal).size > 512); chmodSync(journal, 0o644);
  const before = { database: bytes(f.path), journal: bytes(journal) };
  assert.throws(() => source.sample(Date.now()), /unsafe_drain_path/); assert.throws(() => openDrainLeaseSource(f.root, f.path), /unsafe_drain_path/);
  assert.deepEqual({ database: bytes(f.path), journal: bytes(journal) }, before); console.log('drain-hot-journal-original-preserved', JSON.stringify(before));
  // Legal readonly recovery may require a writer. It must fail closed rather than write to recover.
  chmodSync(journal, 0o600); assert.throws(() => source.sample(Date.now()), /readonly/); assert.deepEqual({ database: bytes(f.path), journal: bytes(journal) }, before);
});

test('missing actual business tables and incomplete S0 fail closed rather than initialize or repair', t => {
  const f = fixture(t); f.mutate(d => d.exec('DROP TABLE generation_dispatch'));
  assert.throws(() => f.source.sample(Date.now()), /no such table/); assert.throws(() => openDrainLeaseSource(f.root, f.path), /no such table/);
  const other = fixture(t); const native = spawnSync(process.execPath, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const d=new Database(process.argv[1]);d.pragma('user_version=999');d.close();", join(other.root, 'ledger.sqlite')], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe' });
  assert.equal(native.status, 0); assert.throws(() => other.source.sample(Date.now()), /invalid_maintenance_version/);
});

test('actual registered core dispatch stays in flight during drain and late failure never releases maintenance hold', async t => {
  const f = fixture(t); f.accept(); const db = openDb(f.path, { bootstrap: false }); t.after(() => db.close());
  const writerAdmission = f.writers.admissionFor(f.writers.register('actual-core-worker', 'generation-dispatch'));
  let release; const work = runGenerationDispatchOnce(db, async () => {
    await new Promise(resolve => { release = resolve; }); throw new Error('synthetic executor failure');
  }, { writerAdmission });
  const before = f.facts(); const result = await observeDrain(opts(f, { deadlineAt: Date.now() + 200 }));
  blocked(result); assert.equal(result.sample.claimedCurrent, 1); assert.equal(result.reason, 'writer_drain_timeout'); assert.deepEqual(f.facts(), before);
  const held = f.ledger.inspect(); release(); await assert.doesNotReject(work);
  assert.deepEqual(f.ledger.inspect(), held); assert.equal(f.writers.inspect().tasks[0].remote_subwork, 'unknown');
  assert.equal(f.writers.inspect().tasks[0].outcome, 'failed'); assert.equal(f.writers.inspect().admission, 'closed');
});

test('two caller-declared same-identity first acquire tokens are indistinguishable; only current CAS may hold', t => {
  const f = fixture(t), second = openLedger(f.root); t.after(() => second.close());
  assert.equal(f.ledger.inspect().active, null); assert.equal(second.inspect().active, null);
  const a = f.ledger.acquire(f.request), b = second.acquire(f.request); assert.deepEqual(a, b);
  const before = f.facts(); f.ledger.hold(a, 'winner_hold');
  assert.throws(() => second.hold(b, 'loser_hold'), /maintenance_revision_conflict/);
  assert.deepEqual(f.ledger.inspect().operations['op-drain'].failures, ['winner_hold']); assert.deepEqual(f.facts(), before);
});

test('separate controllers racing the real drain with same operation/owner cannot report unique or ready', async t => {
  const f = fixture(t); f.accept(); f.writers.admit(f.writers.register('worker-one', 'generation-dispatch')); const before = f.facts();
  const moduleUrl = new URL('./drain.mjs', import.meta.url).href, startPath = join(f.root, 'start-drain-race');
  const childCode = `import {existsSync} from 'node:fs';import {openDrainLeaseSource,observeDrain} from ${JSON.stringify(moduleUrl)};
    const root=process.argv[1],request=JSON.parse(process.argv[2]);console.log('READY');
    while(!existsSync(process.argv[3])) await new Promise(r=>setTimeout(r,1));
    let source;try{source=openDrainLeaseSource(root,root+'/fixture-business.sqlite');
      console.log(JSON.stringify(await observeDrain({root,request,leaseSource:source,deadlineAt:Date.now()+250,pollEveryMs:5})));
    }catch(e){console.log(JSON.stringify({error:e.code??e.message,drain_ready:false,writer_quiescence:false,production_permitted:false,process_termination:'unknown'}));}finally{source?.close();}`;
  const run = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, f.root, JSON.stringify(f.request), startPath], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY\n')) readyResolve(); }); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on('exit', code => resolve({ code, stderr, stdout })));
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); }); return { ready, done };
  };
  const one = run(), two = run(); await Promise.all([one.ready, two.ready]); writeFileSync(startPath, 'start', { mode: 0o600 });
  const outcomes = await Promise.all([one.done, two.done]);
  for (const outcome of outcomes) {
    assert.equal(outcome.code, 0, outcome.stderr); const last = JSON.parse(outcome.stdout.trim().split('\n').at(-1)); blocked(last);
    if (!last.error) assert.equal(last.controller_uniqueness, 'unknown');
  }
  assert.equal(f.writers.inspect().admission, 'closed'); assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held');
  assert.deepEqual(f.facts(), before); console.log('drain-race-blocked', JSON.stringify(outcomes.map(o => JSON.parse(o.stdout.trim().split('\n').at(-1))).map(o => ({ reason: o.reason ?? o.error, controller_uniqueness: o.controller_uniqueness ?? 'unknown', drain_ready: o.drain_ready }))));
});

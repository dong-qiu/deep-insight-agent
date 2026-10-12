import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
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

function fixture(t, { journalMode = 'WAL', retain = false } = {}) {
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
  t.after(() => { source.close(); writers.close(); ledger.close(); if (!retain) rmSync(root, { recursive: true }); });
  if (retain) t.diagnostic('retained own drain fixture ' + root);
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
  const reset = spawnSync(process.execPath, ['--input-type=module', '-e', "import Database from 'better-sqlite3';const d=new Database(process.argv[1]);d.pragma('journal_mode=DELETE');d.close();", f.path], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(reset.error, undefined);
  assert.equal(reset.status, 0, reset.stderr.toString());
  const source = openDrainLeaseSource(f.root, f.path); t.after(() => source.close());
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3'; const d=new Database(process.argv[1]);
    d.pragma('journal_mode=DELETE'); d.pragma('cache_size=1'); d.exec('BEGIN IMMEDIATE');
    d.exec("UPDATE generation_dispatch SET state='alien'");
    const insert=d.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES (?,'analyze','{}','running','2026-10-08T00:00:00.000Z')");
    for(let i=0;i<10000;i++) insert.run('crash-run-'+i); process.kill(process.pid,'SIGKILL');`, f.path], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(child.error, undefined);
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
  const other = fixture(t); const native = spawnSync(process.execPath, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const d=new Database(process.argv[1]);d.pragma('user_version=999');d.close();", join(other.root, 'ledger.sqlite')], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(native.error, undefined);
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

// Private test-process supervision only. Business timeouts and runtime remain unchanged.
function privateDrainChild(code, args = [], readyMs = 4000, preparation = null) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: preparation ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error, closed = false, readySettled = false, readySucceeded = false, readyResolve, readyReject, closeResult, exitStatus;
  let prepared = false, released = false, frames = 0, targetCalls = 0, lateAck = false, frameResolve;
  const frameObserved = new Promise(resolve => { frameResolve = resolve; });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const context = () => JSON.stringify({ pid: child.pid, stdout, stderr, error: error?.message });
  const settleReady = failure => {
    if (readySettled) return;
    readySettled = true; clearTimeout(timer);
    if (failure && preparation) error ??= failure;
    if (failure) readyReject(failure); else { readySucceeded = true; readyResolve(); }
  };
  const refuse = cause => { error ??= cause; settleReady(error); };
  const maybePrepared = () => { if (prepared && stdout.startsWith('READY\n') && !error) settleReady(); };
  if (preparation) child.on('message', message => {
    try {
      const binding = { ...preparation, pid: child.pid };
      if (message?.kind === 'drain-target-invoked-v1') {
        assert.ok(released && !error && !closed, 'target invocation without release');
        assert.deepEqual(message.binding, binding); assert.equal(message.callReturned, true);
        assert.deepEqual(Object.keys(message).sort(), ['binding', 'callReturned', 'kind']);
        assert.equal(++targetCalls, 1, 'duplicate target invocation'); return;
      }
      frames++;
      if (readySettled && !readySucceeded) { lateAck = true; throw new Error('late preparation ACK after refusal'); }
      assert.ok(!closed && !released && frames === 1, 'duplicate or late preparation frame');
      if (message?.kind === 'drain-preparation-failed-v1') {
        assert.deepEqual(message.binding, binding); assert.match(message.errorCode, /^[A-Za-z0-9_]{1,64}$/);
        assert.deepEqual(Object.keys(message).sort(), ['binding', 'errorCode', 'kind']);
        throw Object.assign(new Error('native drain preparation failed: ' + message.errorCode), { code: message.errorCode });
      }
      assert.deepEqual(Object.keys(message).sort(), ['ended', 'entries', 'kind']);
      assert.equal(message.kind, 'drain-prepared-sequence-v1'); assert.equal(message.ended, true);
      assert.ok(Array.isArray(message.entries) && message.entries.length === 1, 'exactly one finite preparation ACK');
      assert.deepEqual(message.entries[0], binding); prepared = true; maybePrepared();
    } catch (cause) { refuse(cause); }
    finally { frameResolve(); }
  });
  const timer = setTimeout(() => settleReady(new Error('drain private ready deadline: ' + context())), readyMs);
  // An early rejection must not escape while the parent is awaiting another child.
  ready.catch(() => {});
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.startsWith('READY\n')) { if (preparation) maybePrepared(); else settleReady(); }
    else if (stdout.includes('\n')) settleReady(new Error('invalid private ready: ' + context()));
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('error', cause => { error ??= cause; settleReady(cause); });
  child.stderr.on('error', cause => { error ??= cause; settleReady(cause); });
  child.on('error', cause => { error = cause; settleReady(cause); });
  child.on('exit', (exit, signal) => { exitStatus = { exit, signal }; const cause = new Error('child exited before private ready: ' + JSON.stringify(exitStatus) + context()); if (preparation && !released) refuse(cause); else settleReady(cause); });
  const close = new Promise(resolve => child.on('close', (exit, signal) => {
    closed = true; settleReady(new Error('child closed before private ready: ' + context()));
    closeResult = Object.freeze({ exit, signal, stdout, stderr, error }); resolve(closeResult);
  }));
  const wait = async ms => {
    let watchdog;
    try { return await Promise.race([close, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('drain private close deadline: ' + context())), ms); })]); }
    finally { clearTimeout(watchdog); }
  };
  return {
    ready, wait: (ms = 4000) => wait(ms),
    assertPrepared() { assert.ok(preparation && readySucceeded && prepared && frames === 1 && !error && !closed && !released, 'preparation not authorized'); },
    markReleased() { this.assertPrepared(); released = true; },
    async observeFrame() {
      let deadline;
      try { await Promise.race([frameObserved, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('preparation frame deadline')), 4000); })]); }
      finally { clearTimeout(deadline); }
    },
    emitLateAck() { return new Promise((resolve, reject) => child.send({ kind: 'emit-late-ack' }, cause => cause ? reject(cause) : resolve())); },
    snapshot: () => ({ pid: child.pid, ready: readySucceeded, closed, outputComplete: closed,
      ...(preparation ? { prepared, released, frames, targetCalls, lateAck, binding: preparation } : {}),
      ...(closeResult ?? { ...exitStatus, stdout, stderr, error }) }),
    async cleanup() {
      if (!closed) {
        child.kill('SIGCONT'); child.kill('SIGTERM');
        try { await wait(500); } catch {
          child.kill('SIGKILL');
          try { await wait(2000); } catch (cause) {
            // Unknown pipe closure is a failed test, not permission to hang or delete fixtures.
            child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); throw cause;
          }
        }
      }
      return close; // exitCode alone never confirms pipe closure.
    },
  };
}
async function finishDrainChildren(children, primary, t, extraCleanup = []) {
  const settled = await Promise.allSettled(children.map(child => child.cleanup()));
  const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason);
  for (const cleanup of extraCleanup) { try { await cleanup(); } catch (cause) { failures.push(cause); } }
  if (primary || failures.length) {
    try { t?.diagnostic(JSON.stringify(children.map((child, i) => ({
      ...child.snapshot(), ...(settled[i].status === 'rejected' ? { cleanupError: settled[i].reason.message } : {}),
    })))); } catch (cause) { failures.push(cause); }
  }
  if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures], 'private child cleanup/diagnostic unconfirmed; fixture retained', { cause: primary });
  if (primary) throw primary;
}
function parseDrainResult(outcome) {
  assert.ok(Object.isFrozen(outcome), 'complete close result required');
  assert.equal(outcome.error, undefined); assert.equal(outcome.signal, null);
  assert.equal(outcome.exit, 0, outcome.stderr);
  assert.ok(outcome.stdout.startsWith('READY\n'), 'exact private ready prefix required');
  // Parse the complete remainder: never skip duplicate ready or malformed lines.
  return JSON.parse(outcome.stdout.slice('READY\n'.length));
}

function preparedDrainChild(f, startPath, actor, mode = 'normal', readyMs = 4000) {
  assert.ok(['normal', 'early-exit', 'early-error', 'wrong-ack', 'missing-ack', 'duplicate-ack', 'late-ack'].includes(mode));
  const binding = { schema: 'drain-native-prepared-v1', actor, root: f.root, databasePath: f.path,
    operationId: f.request.operationId, ownerId: f.request.ownerId, kind: f.request.kind, executionIdentity: f.request.executionIdentity,
    targetSHA256: createHash('sha256').update(JSON.stringify(f.request.target)).digest('hex') };
  const moduleUrl = new URL('./drain.mjs', import.meta.url).href;
  const code = `import {existsSync} from 'node:fs';import {openDrainLeaseSource,observeDrain} from ${JSON.stringify(moduleUrl)};
    const root=process.argv[1],request=JSON.parse(process.argv[2]),go=process.argv[3],binding={...JSON.parse(process.argv[4]),pid:process.pid},mode=process.argv[5];
    const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
    let source,prepared=false,prefix=false,targetCalled=false,calledAt=null,settledAt=null;
    try{
      if(mode==='early-exit')process.exit(3);
      if(mode==='early-error')throw Object.assign(new Error('fixed preparation fault'),{code:'FIXTURE_PREPARE_FAILED'});
      source=openDrainLeaseSource(root,root+'/fixture-business.sqlite');prepared=true;
      const ack=mode==='wrong-ack'?{...binding,ownerId:'wrong-owner'}:binding;
      const frame={kind:'drain-prepared-sequence-v1',ended:true,entries:mode==='duplicate-ack'?[ack,ack]:[ack]};
      if(mode==='late-ack')process.on('message',command=>{if(command?.kind==='emit-late-ack')send(frame).catch(error=>{console.error(error.code??'late_send_failed');process.exitCode=1;});});
      if(!['missing-ack','late-ack'].includes(mode))await send(frame);
      console.log('READY');prefix=true;
      const until=performance.now()+4000;
      while(!existsSync(go)){if(performance.now()>=until)throw new Error('private release deadline');await new Promise(resolve=>setTimeout(resolve,1));}
      calledAt=process.hrtime.bigint().toString();const pending=observeDrain({root,request,leaseSource:source,deadlineAt:Date.now()+250,pollEveryMs:5}).then(
        value=>{settledAt=process.hrtime.bigint().toString();return value;},error=>{settledAt=process.hrtime.bigint().toString();throw error;});
      targetCalled=true;pending.catch(()=>{});
      await send({kind:'drain-target-invoked-v1',binding,callReturned:true});
      console.log(JSON.stringify({...await pending,privateTestCall:{calledAt,settledAt}}));
    }catch(error){
      if(!prepared)await send({kind:'drain-preparation-failed-v1',binding,errorCode:error.code??'FIXTURE_PREPARE_FAILED'});
      if(!prefix)console.log('READY');
      console.log(JSON.stringify({error:error.code??error.message,detail:error.stack,phase:prepared?'target_or_release':'source_initialization',targetCalled,
        privateTestCall:targetCalled?{calledAt,settledAt}:null,
        drain_ready:false,writer_quiescence:false,production_permitted:false,process_termination:'unknown'}));
    }finally{source?.close();if(process.connected)process.disconnect();}`;
  return privateDrainChild(code, [f.root, JSON.stringify(f.request), startPath, JSON.stringify(binding), mode], readyMs, binding);
}
function releasePrepared(children, startPath) {
  for (const child of children) child.assertPrepared();
  writeFileSync(startPath, 'start', { flag: 'wx', mode: 0o600 });
  for (const child of children) child.markReleased();
}
function concurrentDrainCalls(results) {
  assert.equal(results.length, 2);
  const intervals = results.map(result => {
    const call = result.privateTestCall; assert.ok(call, 'actual target call interval required');
    assert.match(call.calledAt, /^\d{1,24}$/); assert.match(call.settledAt, /^\d{1,24}$/);
    const start = BigInt(call.calledAt), end = BigInt(call.settledAt); assert.ok(end > start, 'nonempty native call interval');
    return { start, end };
  });
  // Same-host hrtime is a system monotonic clock. This proves measured function
  // interval overlap, not database lock ownership or any ready/commit authority.
  assert.ok(intervals[0].start < intervals[1].end && intervals[1].start < intervals[0].end, 'actual drain call intervals must overlap');
}
test('separate controllers racing the real drain with same operation/owner cannot report unique or ready', async t => {
  const f = fixture(t, { retain: true }); f.accept(); f.writers.admit(f.writers.register('worker-one', 'generation-dispatch')); const before = f.facts();
  const startPath = join(f.root, 'start-drain-race');
  const children = []; let primary;
  try {
    children.push(preparedDrainChild(f, startPath, 'actor-a')); await children[0].ready;
    children.push(preparedDrainChild(f, startPath, 'actor-b')); await children[1].ready;
    releasePrepared(children, startPath);
    const outcomes = await Promise.all(children.map(child => child.wait()));
    t.diagnostic('drain race close outputs ' + JSON.stringify({ fixture: f.root, outcomes, preparation: children.map(child => child.snapshot()) }));
    const parsed = outcomes.map(parseDrainResult);
    concurrentDrainCalls(parsed);
    for (const last of parsed) {
      blocked(last);
      if (!last.error) assert.equal(last.controller_uniqueness, 'unknown');
    }
    for (const child of children) { assert.equal(child.snapshot().prepared, true); assert.equal(child.snapshot().targetCalls, 1); }
    assert.equal(f.writers.inspect().admission, 'closed'); assert.equal(f.ledger.inspect().operations['op-drain'].disposition, 'held');
    assert.deepEqual(f.facts(), before); console.log('drain-race-blocked', JSON.stringify(parsed.map(o => ({ reason: o.reason ?? o.error, controller_uniqueness: o.controller_uniqueness ?? 'unknown', drain_ready: o.drain_ready }))));
  } catch (cause) { primary = cause; }
  finally { await finishDrainChildren(children, primary, t); }
});

test('native prepared drain: initializer SQLITE_BUSY remains a separate no-claim failure, one prepared peer is cleaned', async t => {
  const f = fixture(t, { retain: true }), startPath = join(f.root, 'native-preparation-go');
  const beforeLedger = f.ledger.inspect(), beforeWriters = f.writers.inspect(), beforeBusiness = f.facts();
  const first = preparedDrainChild(f, startPath, 'prepared-first'), children = [first];
  let locker, primary, outerFailure, diagnostics;
  try {
    await first.ready;
    locker = new Database(join(f.root, 'ledger.sqlite'), { fileMustExist: true, timeout: 0 }); locker.exec('BEGIN EXCLUSIVE');
    const second = preparedDrainChild(f, startPath, 'native-busy-second'); children.push(second);
    await assert.rejects(second.ready, error => { primary = error; return error.code === 'SQLITE_BUSY'; });
    const result = await second.wait(), payload = JSON.parse(result.stdout.slice('READY\n'.length));
    assert.equal(result.exit, 0); assert.equal(result.signal, null); assert.equal(payload.error, 'SQLITE_BUSY');
    assert.equal(payload.phase, 'source_initialization'); assert.equal(payload.targetCalled, false); blocked(payload);
    assert.throws(() => releasePrepared(children, startPath), /preparation not authorized/);
    assert.equal(existsSync(startPath), false);
    await assert.rejects(finishDrainChildren(children, primary, { diagnostic: value => { diagnostics = JSON.parse(value); } }), error => error === primary);
    for (const child of children) { assert.equal(child.snapshot().closed, true); assert.equal(child.snapshot().targetCalls, 0); assert.equal(child.snapshot().released, false); }
    assert.equal(diagnostics[0].prepared, true); assert.equal(diagnostics[1].prepared, false);
    t.diagnostic('native preparation SQLITE_BUSY: source-only/no-target/no-go; both physical closes observed');
  } catch (cause) { outerFailure = cause; }
  finally {
    await finishDrainChildren(children, outerFailure, t, [() => locker?.exec('ROLLBACK'), () => locker?.close()]);
  }
  assert.deepEqual(f.ledger.inspect(), beforeLedger); assert.deepEqual(f.writers.inspect(), beforeWriters); assert.deepEqual(f.facts(), beforeBusiness);
});
test('native prepared drain: wrong, missing, duplicate and late ACK never release or revive preparation', async t => {
  const f = fixture(t, { retain: true });
  for (const mode of ['wrong-ack', 'missing-ack', 'duplicate-ack', 'late-ack']) {
    const startPath = join(f.root, mode + '-go'), child = preparedDrainChild(f, startPath, mode, mode, ['missing-ack', 'late-ack'].includes(mode) ? 200 : 4000);
    let failure;
    try {
      let primary;
      await assert.rejects(child.ready, error => {
        primary = error;
        if (mode === 'wrong-ack') return error.code === 'ERR_ASSERTION' && error.message.includes('wrong-owner');
        if (mode === 'duplicate-ack') return error.code === 'ERR_ASSERTION' && error.message.includes('exactly one finite preparation ACK');
        return error.message.includes('drain private ready deadline');
      });
      if (mode === 'late-ack') { await child.emitLateAck(); await child.observeFrame(); assert.equal(child.snapshot().lateAck, true); assert.equal(child.snapshot().error, primary); }
      if (mode === 'duplicate-ack') assert.equal(child.snapshot().prepared, false);
      assert.throws(() => releasePrepared([child], startPath), /preparation not authorized/);
      assert.equal(existsSync(startPath), false); assert.equal(child.snapshot().targetCalls, 0);
    } catch (cause) { failure = cause; }
    finally { await finishDrainChildren([child], failure, t); }
    assert.equal(child.snapshot().closed, true); assert.equal(child.snapshot().outputComplete, true);
  }
});
test('native prepared drain: early error and exit cannot acquire a preparation grant', async t => {
  const f = fixture(t, { retain: true });
  for (const mode of ['early-error', 'early-exit']) {
    const go = join(f.root, mode + '-go'), child = preparedDrainChild(f, go, mode, mode);
    let failure;
    try {
      await assert.rejects(child.ready, mode === 'early-exit' ? /before private ready/ : /FIXTURE_PREPARE_FAILED/);
      assert.throws(() => releasePrepared([child], go), /preparation not authorized/);
      assert.equal(existsSync(go), false); assert.equal(child.snapshot().targetCalls, 0);
    } catch (cause) { failure = cause; }
    finally { await finishDrainChildren([child], failure, t); }
    assert.equal(child.snapshot().closed, true);
  }
});
test('prepared drain cleanup preserves primary then ordered cleanup and diagnostic secondaries', async () => {
  const primary = new Error('first preparation failure'), secondary = new Error('unconfirmed close'), rollback = new Error('rollback failure'), io = new Error('diagnostic failure');
  const child = { cleanup: async () => { throw secondary; }, snapshot: () => ({ closed: false, outputComplete: false }) };
  let closed = false;
  await assert.rejects(finishDrainChildren([child], primary, { diagnostic() { throw io; } }, [() => { throw rollback; }, () => { closed = true; }]),
    error => error instanceof AggregateError && error.cause === primary && error.errors[0] === primary && error.errors[1] === secondary && error.errors[2] === rollback && error.errors[3] === io);
  assert.equal(closed, true);
});
test('prepared drain overlap oracle rejects serial, missing and empty invocation intervals', () => {
  const result = (start, end) => ({ privateTestCall: { calledAt: start, settledAt: end } });
  concurrentDrainCalls([result('10', '30'), result('20', '40')]);
  assert.throws(() => concurrentDrainCalls([result('10', '20'), result('20', '30')]), /must overlap/);
  assert.throws(() => concurrentDrainCalls([result('10', '10'), result('10', '30')]), /nonempty/);
  assert.throws(() => concurrentDrainCalls([{}, result('10', '30')]), /interval required/);
});

test('private drain supervision rejects early exit, wrong ready and missing ready with confirmed cleanup', async () => {
  for (const [code, expected, readyMs] of [
    ['process.exit(3)', /before private ready/, 4000],
    ["console.log('WRONG');setInterval(()=>{},1000)", /invalid private ready/, 4000],
    ['setInterval(()=>{},1000)', /ready deadline/, 200],
  ]) {
    const child = privateDrainChild(code, [], readyMs);
    try { await assert.rejects(child.ready, expected); }
    finally { const closed = await child.cleanup(); assert.equal(closed.error, undefined); }
  }
});
test('private drain close watchdog fails a TERM-ignoring child and confirms KILL cleanup', async () => {
  const child = privateDrainChild("process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)");
  try { await child.ready; await assert.rejects(child.wait(50), /close deadline/); }
  finally { const closed = await child.cleanup(); assert.equal(closed.signal, 'SIGKILL'); }
});
test('private drain close captures complete large stdout and stderr; malformed output is not repaired', async () => {
  const child = privateDrainChild("console.log('READY');process.stdout.write(JSON.stringify({payload:'x'.repeat(262144)})+'\\n');process.stderr.write('y'.repeat(262144))");
  try {
    await child.ready; const closed = await child.wait(); assert.equal(closed.exit, 0); assert.equal(closed.error, undefined);
    assert.equal(parseDrainResult(closed).payload.length, 262144); assert.equal(closed.stderr.length, 262144);
    assert.ok(Object.isFrozen(closed));
  } finally { await child.cleanup(); }
  const bad = privateDrainChild("console.log('READY');console.log('{bad')");
  try { await bad.ready; const closed = await bad.wait(); assert.throws(() => parseDrainResult(closed), SyntaxError); }
  finally { await bad.cleanup(); }
});
test('real drain output parser rejects duplicate ready, malformed intermediate lines and multiple results after close', async () => {
  const result = JSON.stringify({ drain_ready: false, writer_quiescence: false, production_permitted: false, process_termination: 'unknown' });
  for (const remainder of ['READY\n' + result + '\n', '{bad\n' + result + '\n', result + '\n' + result + '\n', result + '\ntrailing-invalid\n']) {
    const child = privateDrainChild("console.log('READY');process.stdout.write(" + JSON.stringify(remainder) + ')');
    try { await child.ready; const closed = await child.wait(); assert.throws(() => parseDrainResult(closed), SyntaxError); }
    finally { await child.cleanup(); }
  }
});
test('failed drain preparation retains complete cleanup-close output and the original failure', async () => {
  const tail = 'diagnostic-close-tail\n', child = privateDrainChild("process.stderr.write('x'.repeat(262144)+" + JSON.stringify(tail) + ');process.exitCode=3;');
  try {
    await assert.rejects(child.ready, /before private ready/);
    let diagnostic;
    const primary = new Error('original private ready failure');
    await assert.rejects(finishDrainChildren([child], primary, { diagnostic: text => { diagnostic = JSON.parse(text); } }), error => error === primary);
    assert.equal(diagnostic[0].closed, true); assert.equal(diagnostic[0].outputComplete, true);
    assert.equal(diagnostic[0].exit, 3); assert.equal(diagnostic[0].stderr, 'x'.repeat(262144) + tail);
  } finally { await child.cleanup(); }
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { initialize } from './ledger.mjs';
import { initializeWriters, openWriters } from './writers.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'insight-a3-writers-'))); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync('ed25519');
  initialize(root, { target: { region: 'isolated', instanceId: 'fixture-app', volumeId: 'fixture-data', dataPath: root, serviceSet: ['app'] }, approverId: 'fixture-reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  initializeWriters(root);
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}
function opened(t, root) { const w = openWriters(root); t.after(() => w.close()); return w; }

test('registry requires registered generation; preserves unfinished records across restart', t => {
  const root = fixture(t); const w = openWriters(root);
  assert.throws(() => w.admit({ workerId: 'absent', generationToken: '00000000-0000-4000-8000-000000000000' }), /writer_owner_lost/);
  const worker = w.register('generation-one', 'generation-dispatch'); const task = w.admit(worker);
  w.close(); const restarted = opened(t, root);
  assert.throws(() => restarted.register('generation-one', 'generation-dispatch'), /writer_generation_exists/);
  const next = restarted.register('generation-two', 'generation-dispatch');
  assert.throws(() => restarted.finish({ ...task, generationToken: next.generationToken }, 'failed'), /writer_owner_lost/);
  const view = restarted.inspect();
  assert.equal(view.tasks[0].outcome, null); assert.equal(view.tasks[0].remote_subwork, 'unknown');
  assert.equal(view.writer_quiescence, false); assert.equal(view.production_permitted, false);
  assert.equal(view.coreCoverage, 'runGenerationDispatchOnce');
});

test('close is persistent, preserves admitted tasks and blocks both register and admit', t => {
  const root = fixture(t); const one = opened(t, root); const two = opened(t, root);
  const worker = one.register('generation-one', 'generation-dispatch'); const task = one.admit(worker);
  two.closeAdmission(); assert.throws(() => one.admit(worker), /writer_admission_closed/);
  assert.throws(() => one.register('generation-two', 'generation-dispatch'), /writer_admission_closed/);
  one.finish(task, 'failed'); one.finish(task, 'failed');
  assert.throws(() => one.finish(task, 'done'), /writer_completion_conflict/);
  const restarted = opened(t, root); assert.equal(restarted.inspect().admission, 'closed');
  assert.equal(restarted.inspect().tasks[0].outcome, 'failed');
  assert.equal(restarted.inspect().tasks[0].remote_subwork, 'unknown');
});

test('SQLite contention rejects immediately without losing admitted records', t => {
  const root = fixture(t); const w = opened(t, root);
  const worker = w.register('generation-one', 'generation-dispatch');
  const lock = new Database(join(root, 'writers.sqlite')); t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE'); assert.throws(() => w.admit(worker), /locked/); lock.exec('ROLLBACK');
  const task = w.admit(worker); assert.equal(w.inspect().tasks[0].taskId, task.taskId);
});

test('close/admit in separate processes never silently admits a task', async t => {
  const root = fixture(t); const w = opened(t, root); const worker = w.register('generation-one', 'generation-dispatch');
  const writerModuleUrl = new URL('./writers.mjs', import.meta.url).href;
  const run = action => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {openWriters} from ${JSON.stringify(writerModuleUrl)}; let w; try { w=openWriters(process.argv[1]); ${action} } catch(e) { console.log(e.code==='SQLITE_BUSY'?'busy':e.message); } finally { w?.close(); }`, root, JSON.stringify(worker)], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.on('exit', code => resolve({ code, out: out.trim(), err }));
  });
  const [close, admit] = await Promise.all([run('w.closeAdmission(); console.log("closed");'), run('console.log(JSON.stringify(w.admit(JSON.parse(process.argv[2]))));')]);
  assert.equal(close.code, 0, close.err); assert.equal(admit.code, 0, admit.err);
  assert.ok(close.out === 'closed' || close.out === 'busy');
  const snapshot = w.inspect();
  if (admit.out.startsWith('{')) assert.equal(snapshot.tasks[0].taskId, JSON.parse(admit.out).taskId);
  else assert.ok(['busy', 'writer_admission_closed'].includes(admit.out), admit.out);
  // If close lost the lock race, an explicit second close must persist it. No retry is built into admission.
  w.closeAdmission(); assert.throws(() => w.admit(worker), /writer_admission_closed/);
});

test('invalid registry, permissions and corrupt S0 cannot be used for new admission', t => {
  const root = fixture(t); const w = opened(t, root); const worker = w.register('generation-one', 'generation-dispatch');
  chmodSync(join(root, 'writers.sqlite'), 0o644); assert.throws(() => w.admit(worker), /unsafe_writer_path/);
  chmodSync(join(root, 'writers.sqlite'), 0o600);
  const ledger = new Database(join(root, 'ledger.sqlite')); ledger.pragma('user_version = 999'); ledger.close();
  assert.throws(() => w.admit(worker), /invalid_maintenance_version/);
});

test('wrong entry, unknown sidecar version and interrupted initialization fail closed', t => {
  const root = fixture(t); const w = opened(t, root);
  assert.throws(() => w.register('generation-one', 'anything'), /invalid_writer_record/);
  assert.throws(() => initializeWriters(root), /EEXIST/);
  const db = new Database(join(root, 'writers.sqlite')); db.pragma('user_version = 999'); db.close();
  assert.throws(() => w.inspect(), /invalid_writer_version/);
});


test('missing sidecar keeps its permanent marker and cannot be initialized again', t => {
  const root = fixture(t);
  unlinkSync(join(root, 'writers.sqlite'));
  assert.throws(() => openWriters(root), /ENOENT/);
  assert.throws(() => initializeWriters(root), /EEXIST/);
});

test('symlink sidecar is rejected by existing and new handles without repair', t => {
  const root = fixture(t); const w = opened(t, root);
  const sidecar = join(root, 'writers.sqlite');
  unlinkSync(sidecar); symlinkSync(join(root, 'ledger.sqlite'), sidecar);
  assert.throws(() => w.inspect(), /unsafe_writer_path/);
  assert.throws(() => openWriters(root), /unsafe_writer_path/);
});

test('unfinished initialization and changed marker remain unusable', t => {
  const root = fixture(t);
  const sidecar = join(root, 'writers.sqlite');
  // A zero-byte sidecar represents a crash before schema commit; marker is retained.
  writeFileSync(sidecar, '');
  assert.throws(() => openWriters(root), /invalid_writer_version/);
  assert.throws(() => initializeWriters(root), /EEXIST/);
  writeFileSync(join(root, 'writers-isolation.json'), '{}');
  assert.throws(() => openWriters(root), /writer_marker_changed/);
});

test('registration facts are append-only and closed admission has no SQL reopen path', t => {
  const root = fixture(t); const w = opened(t, root); const worker = w.register('generation-one', 'generation-dispatch');
  w.admit(worker); w.closeAdmission();
  const db = new Database(join(root, 'writers.sqlite')); t.after(() => db.close());
  assert.throws(() => db.exec('DELETE FROM tasks'), /writer_facts_append_only/);
  assert.throws(() => db.exec("UPDATE admission SET mode='open'"), /writer_admission_permanent/);
  assert.equal(w.inspect().admission, 'closed');
});


test('non-SQLite corruption is rejected without rebuilding the registry', t => {
  const root = fixture(t); writeFileSync(join(root, 'writers.sqlite'), 'not a sqlite database');
  assert.throws(() => openWriters(root), /not a database/);
  assert.throws(() => initializeWriters(root), /EEXIST/);
});


function hotJournal(root) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3'; import {randomUUID} from 'node:crypto';
    const db=new Database(process.argv[1]); db.pragma('cache_size=1'); db.exec('BEGIN IMMEDIATE');
    const ins=db.prepare('INSERT INTO workers VALUES (?,?,?)');
    for(let i=0;i<10000;i++) ins.run('crash-'+i,randomUUID(),'generation-dispatch');
    process.kill(process.pid,'SIGKILL');`, join(root, 'writers.sqlite')], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe' });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  assert.ok(readFileSync(join(root, 'writers.sqlite-journal')).length > 512);
}
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('unsafe real hot journal is rejected before recovery with DB/journal bytes preserved', t => {
  const root = fixture(t); hotJournal(root);
  const path = join(root, 'writers.sqlite'), journal = `${path}-journal`;
  chmodSync(journal, 0o644); const before = { db: sha256(path), journal: sha256(journal) };
  assert.throws(() => openWriters(root), /unsafe_writer_path/);
  assert.deepEqual({ db: sha256(path), journal: sha256(journal) }, before);
});

test('legal 0600 hot journal recovers closed admission and unknown unfinished tasks', t => {
  const root = fixture(t); const first = openWriters(root);
  const task = first.admit(first.register('generation-one', 'generation-dispatch')); first.closeAdmission(); first.close();
  hotJournal(root); assert.equal((readFileSync(join(root, 'writers.sqlite-journal'))).length > 512, true);
  const recovered = opened(t, root); const view = recovered.inspect();
  assert.equal(view.admission, 'closed'); assert.equal(view.workers.length, 1);
  assert.deepEqual(view.tasks, [{ taskId: task.taskId, workerId: task.workerId, outcome: null, remote_subwork: 'unknown' }]);
  assert.equal(view.writer_quiescence, false);
});

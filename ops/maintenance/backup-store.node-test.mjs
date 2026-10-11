import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initialize } from './ledger.mjs';
import { initializeBackupStore, openBackupStore } from './backup-store.mjs';

function fixture(t, initialized = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r2-k-store-')));
  t.after(() => rmSync(root, { recursive: true }));
  chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync('ed25519');
  const target = { region: 'isolated', instanceId: 'fixture-k', volumeId: 'fixture-volume', dataPath: root, serviceSet: ['app'] };
  initialize(root, { target, approverId: 'fixture-reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  writeFileSync(join(root, 'fixture-business.sqlite'), 'business is never SQLite-opened by K', { mode: 0o600 });
  const control = join(root, 'backup-attempt-v1'); mkdirSync(control, { mode: 0o700 });
  if (initialized) initializeBackupStore(root);
  const request = () => ({ schema: 'r2-backup-denial-request-v1', operationId: `op-${randomUUID()}`,
    requestId: randomUUID(), ownerId: 'owner', executionIdentity: 'fixture-kernel', target,
    fence: 1, revision: 1, windowMs: 1000, deadlineAt: Date.now() + 1000 });
  const dbPath = join(control, 'backup-attempts.sqlite');
  const open = () => { const store = openBackupStore(root); t.after(() => store.close()); return store; };
  const child = script => spawnSync(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(request())],
    { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  return { root, control, dbPath, request, open, child };
}
function bytes(control) {
  return Object.fromEntries(readdirSync(control).sort().map(name => [name, readFileSync(join(control, name)).toString('hex')]));
}

test('explicit initialization and confirmed denials never grant capability; clone and replay have no power', t => {
  const f = fixture(t), store = f.open(), request = f.request();
  const result = store.recordCoverageUnavailable(request);
  assert.equal(result.kind, 'denied'); assert.equal(result.code, 'backup_source_coverage_unavailable');
  assert.equal(result.publication, 'not_attempted'); assert.equal(result.positive_admission_ready, false);
  assert.deepEqual(Object.keys(store).sort(), ['close', 'inspect', 'recordCoverageUnavailable']);
  const view = store.inspect(); assert.equal(view.blocked, true); assert.equal(view.denials.length, 1);
  view.denials.length = 0; view.target.dataPath = '/not-the-original';
  assert.equal(store.inspect().denials.length, 1);
  const before = bytes(f.control);
  assert.throws(() => store.recordCoverageUnavailable(structuredClone(request)), /backup_operation_consumed/);
  assert.deepEqual(bytes(f.control), before);
  store.close();
  const reopened = f.open(); assert.equal(reopened.inspect().denials.length, 1);
  assert.throws(() => reopened.recordCoverageUnavailable(f.request()), /backup_target_unresolved/);
  assert.equal(reopened.inspect().denials.length, 1);
});

test('missing or nonempty initialization directory is not created or repaired', t => {
  const f = fixture(t, false); rmSync(f.control, { recursive: true });
  assert.throws(() => initializeBackupStore(f.root)); assert.equal(existsSync(f.control), false);
  mkdirSync(f.control, { mode: 0o700 }); writeFileSync(join(f.control, 'foreign'), 'preserve', { mode: 0o600 });
  const before = bytes(f.control); assert.throws(() => initializeBackupStore(f.root), /backup_already_initialized/);
  assert.deepEqual(bytes(f.control), before);
});

test('interrupted initialization leaves a permanent tombstone, not a retryable empty directory', t => {
  const f = fixture(t, false);
  const child = f.child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    fs.fsyncSync=()=>{throw new Error('test_init_sync_failed');}; syncBuiltinESMExports();
    const {initializeBackupStore}=await import('./ops/maintenance/backup-store.mjs');
    try{initializeBackupStore(process.argv[1]);process.exitCode=9;}catch{process.exitCode=0;}`);
  assert.equal(child.status, 0, child.stderr); assert.ok(existsSync(join(f.control, 'init.json')));
  const before = bytes(f.control);
  assert.throws(() => initializeBackupStore(f.root), /backup_already_initialized/);
  assert.throws(() => openBackupStore(f.root)); assert.deepEqual(bytes(f.control), before);
});

test('actual module syncs intent file and parent before reservation INSERT', t => {
  const f = fixture(t);
  const child = f.child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import Database from 'better-sqlite3'; import assert from 'node:assert/strict';
    const steps=[],sync=fs.fsyncSync,prepare=Database.prototype.prepare;
    fs.fsyncSync=(fd)=>{steps.push(fs.fstatSync(fd).isDirectory()?'directory':'file');return sync(fd);};
    syncBuiltinESMExports();
    Database.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO reservations'))steps.push('insert');return prepare.call(this,sql);};
    const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
    const s=openBackupStore(process.argv[1]),r=s.recordCoverageUnavailable(JSON.parse(process.argv[2]));
    assert.equal(r.kind,'denied'); assert.deepEqual(steps.slice(0,3),['file','directory','insert']);
    process.stdout.write(JSON.stringify(steps));`);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).slice(0, 3), ['file', 'directory', 'insert']);
});

for (const fault of ['missing-marker', 'missing-db', 'marker-only', 'partial-marker', 'empty-db', 'schema', 'version', 'mode', 'hardlink', 'symlink']) {
  test(`half-initialized/corrupt control fails closed without repair: ${fault}`, t => {
    const f = fixture(t);
    if (fault === 'missing-marker') rmSync(join(f.control, 'init.json'));
    if (fault === 'missing-db') rmSync(f.dbPath);
    if (fault === 'marker-only') { rmSync(f.dbPath); rmSync(join(f.control, 'physical.json')); }
    if (fault === 'partial-marker') writeFileSync(join(f.control, 'init.json'), '{half');
    if (fault === 'empty-db') writeFileSync(f.dbPath, '');
    if (fault === 'schema' || fault === 'version') {
      const db = new Database(f.dbPath); db.exec(fault === 'schema' ? 'DROP TRIGGER denials_no_delete' : 'PRAGMA user_version=9'); db.close();
    }
    if (fault === 'mode') chmodSync(f.dbPath, 0o644);
    if (fault === 'hardlink') linkSync(f.dbPath, join(f.control, 'other'));
    if (fault === 'symlink') { rmSync(f.dbPath); symlinkSync(join(f.control, 'init.json'), f.dbPath); }
    const before = bytes(f.control);
    assert.throws(() => openBackupStore(f.root)); assert.throws(() => initializeBackupStore(f.root));
    assert.deepEqual(bytes(f.control), before);
  });
}

test('physical replacement, wrong source permissions and noncanonical paths are rejected before SQL', t => {
  const f = fixture(t), store = f.open(), original = join(f.control, 'previous.sqlite');
  renameSync(f.dbPath, original); copyFileSync(original, f.dbPath); chmodSync(f.dbPath, 0o600);
  const before = bytes(f.control);
  assert.throws(() => store.inspect(), /backup_control_changed/);
  assert.throws(() => openBackupStore(f.root), /backup_control_changed/);
  assert.deepEqual(bytes(f.control), before);
  assert.throws(() => initializeBackupStore(f.root + '/.'), /noncanonical_backup_root/);
  chmodSync(join(f.root, 'fixture-business.sqlite'), 0o644);
  assert.throws(() => store.recordCoverageUnavailable(f.request()), /unsafe_backup_path/);
});

test('real hot journal is preserved before readonly open or recovery', t => {
  const f = fixture(t), store = f.open();
  const crashed = f.child(`
    import Database from 'better-sqlite3';
    const db=new Database(process.argv[1]+'/backup-attempt-v1/backup-attempts.sqlite');
    db.pragma('cache_size=1'); db.exec('BEGIN IMMEDIATE');
    const stmt=db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?)');
    for(let i=1;i<=1000;i++) stmt.run(i,'attempt'+i,'op'+i,'hash'+i,'x'.repeat(2048),'prev','hash');
    process.kill(process.pid,'SIGKILL');`);
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.ok(readFileSync(f.dbPath + '-journal').length > 512);
  const before = bytes(f.control);
  assert.throws(() => store.inspect(), /backup_control_sidecar_present/);
  assert.throws(() => openBackupStore(f.root), /backup_control_sidecar_present/);
  assert.deepEqual(bytes(f.control), before);
});

test('real reservation lock failure leaves a durable intent and restart/new operation stays blocked', t => {
  const f = fixture(t), store = f.open(), blocker = new Database(f.dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  let result;
  try { result = store.recordCoverageUnavailable(f.request()); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  assert.equal(result.kind, 'unknown'); assert.equal(result.controlReceipt, 'unknown');
  assert.ok(existsSync(join(f.control, `intent-${result.attemptId}.json`)));
  assert.equal(store.inspect().blocked, true);
  const reopened = f.open(), before = bytes(f.control);
  assert.equal(reopened.inspect().reservations.length, 0);
  assert.throws(() => reopened.recordCoverageUnavailable(f.request()), /backup_target_unresolved/);
  assert.deepEqual(bytes(f.control), before);
});

for (const action of ['throw', 'kill']) {
  test(`initial reservation COMMIT succeeds but ACK ${action} cannot create a completed denial`, t => {
    const f = fixture(t);
    const child = f.child(`
      import Database from 'better-sqlite3';
      const original=Database.prototype.transaction;
      Database.prototype.transaction=function(...args){
        const tx=original.apply(this,args), wrapped=(...values)=>tx(...values);
        wrapped.immediate=(...values)=>{const result=tx.immediate(...values);
          ${action === 'kill' ? "process.kill(process.pid,'SIGKILL');" : "throw new Error('test_lost_initial_ack');"}
          return result;}; return wrapped;};
      const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
      const store=openBackupStore(process.argv[1]);
      process.stdout.write(JSON.stringify(store.recordCoverageUnavailable(JSON.parse(process.argv[2]))));`);
    if (action === 'kill') assert.equal(child.signal, 'SIGKILL', child.stderr);
    else { assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).kind, 'unknown'); }
    const store = f.open(), view = store.inspect();
    assert.equal(view.reservations.length, 1); assert.equal(view.denials.length, 0); assert.equal(view.blocked, true);
    assert.throws(() => store.recordCoverageUnavailable(f.request()), /backup_target_unresolved/);
  });
}

for (const action of ['throw', 'kill']) {
  test(`final denial COMMIT ACK ${action} never releases the permanent one-shot barrier`, t => {
    const f = fixture(t);
    const child = f.child(`
      import Database from 'better-sqlite3';
      const original=Database.prototype.transaction; let commits=0;
      Database.prototype.transaction=function(...args){
        const tx=original.apply(this,args), wrapped=(...values)=>tx(...values);
        wrapped.immediate=(...values)=>{const result=tx.immediate(...values);
          if(++commits===2) {${action === 'kill' ? "process.kill(process.pid,'SIGKILL');" : "throw new Error('test_lost_final_ack');"}}
          return result;}; return wrapped;};
      const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
      const store=openBackupStore(process.argv[1]);
      process.stdout.write(JSON.stringify(store.recordCoverageUnavailable(JSON.parse(process.argv[2]))));`);
    if (action === 'kill') assert.equal(child.signal, 'SIGKILL', child.stderr);
    else { assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).kind, 'unknown'); }
    const store = f.open(), view = store.inspect();
    assert.equal(view.reservations.length, 1); assert.equal(view.denials.length, 1);
    assert.equal(view.unresolved.length, 0); assert.equal(view.blocked, true);
    assert.throws(() => store.recordCoverageUnavailable(f.request()), /backup_target_unresolved/);
  });
}

for (const failureAt of [1, 2]) {
  test(`intent ${failureAt === 1 ? 'file' : 'parent'} fsync failure prevents any reservation SQL`, t => {
    const f = fixture(t);
    const child = f.child(`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      let calls=0;const original=fs.fsyncSync;
      fs.fsyncSync=(...args)=>{if(++calls===${failureAt})throw new Error('test_fsync_failure');return original(...args);};
      syncBuiltinESMExports();
      const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
      const store=openBackupStore(process.argv[1]);
      process.stdout.write(JSON.stringify(store.recordCoverageUnavailable(JSON.parse(process.argv[2]))));`);
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).kind, 'unknown');
    const view = f.open().inspect(); assert.equal(view.reservations.length, 0); assert.equal(view.blocked, true);
  });
}

test('partial intent remains blocked/rejected and is not rewritten', t => {
  const f = fixture(t), path = join(f.control, `intent-${randomUUID()}.json`);
  writeFileSync(path, '{partial', { mode: 0o600 }); const before = bytes(f.control);
  assert.throws(() => openBackupStore(f.root)); assert.deepEqual(bytes(f.control), before);
});

test('same operation competes in real processes; no duplicate terminal fact or lost intent', async t => {
  const f = fixture(t), request = f.request();
  const script = `const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
    try {const s=openBackupStore(process.argv[1]); console.log(JSON.stringify(s.recordCoverageUnavailable(JSON.parse(process.argv[2]))));}
    catch(e){console.log(JSON.stringify({kind:'rejected',code:e.message}));}`;
  const children = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root, JSON.stringify(request)],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  }));
  const results = await Promise.all(children);
  assert.ok(results.filter(result => result.kind === 'denied').length <= 1);
  const view = f.open().inspect(); assert.ok(view.reservations.length <= 1); assert.ok(view.denials.length <= 1);
  const intentCount = readdirSync(f.control).filter(name => name.startsWith('intent-')).length;
  assert.equal(intentCount, view.denials.length + view.unresolved.length);
});

test('different operation finishing after stale empty precheck prevents a second reservation inside the lock', t => {
  const f = fixture(t);
  const child = f.child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict';
    const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');
    const store=openBackupStore(process.argv[1]),original=fs.openSync; let winner=null;
    fs.openSync=(path,flags,...args)=>{
      if(!winner && String(path).includes('/intent-') && (flags & fs.constants.O_CREAT)) {
        const request={...JSON.parse(process.argv[2]),operationId:'op-other-winner'};
        const result=spawnSync(process.execPath,['--input-type=module','-e',
          "const {openBackupStore}=await import('./ops/maintenance/backup-store.mjs');const s=openBackupStore(process.argv[1]);process.stdout.write(JSON.stringify(s.recordCoverageUnavailable(JSON.parse(process.argv[2]))));",
          process.argv[1],JSON.stringify(request)],{cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
        assert.equal(result.status,0,result.stderr); winner=JSON.parse(result.stdout);
        assert.equal(winner.kind,'denied');
      }
      return original(path,flags,...args);
    }; syncBuiltinESMExports();
    const lagging=store.recordCoverageUnavailable(JSON.parse(process.argv[2]));
    assert.equal(lagging.kind,'unknown');
    process.stdout.write(JSON.stringify({winner,lagging}));`);
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout); assert.equal(results.winner.kind, 'denied'); assert.equal(results.lagging.kind, 'unknown');
  const store = f.open(), view = store.inspect();
  assert.equal(view.reservations.length, 1); assert.equal(view.denials.length, 1);
  assert.equal(view.unresolved.length, 1); assert.equal(view.blocked, true);
  const before = bytes(f.control);
  assert.throws(() => store.recordCoverageUnavailable(f.request()), /backup_target_unresolved/);
  assert.deepEqual(bytes(f.control), before);
});

test('append-only schema and exact intent set detect mutation and missing intent', t => {
  const f = fixture(t), store = f.open(), result = store.recordCoverageUnavailable(f.request());
  const db = new Database(f.dbPath);
  for (const table of ['identity', 'reservations', 'denials']) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /backup_facts_append_only/);
  }
  db.close();
  const path = join(f.control, `intent-${result.attemptId}.json`); rmSync(path);
  assert.throws(() => store.inspect(), /backup_intent_missing_or_changed/);
  assert.throws(() => openBackupStore(f.root), /backup_intent_missing_or_changed/);
});

test('forged appended audit row is rejected, not treated as a new safe attempt', t => {
  const f = fixture(t), store = f.open();
  const db = new Database(f.dbPath);
  db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?)').run(1, 'forged', 'op-forged', 'bad', '{}', 'genesis', 'bad');
  db.close(); const before = bytes(f.control);
  assert.throws(() => store.inspect()); assert.throws(() => openBackupStore(f.root));
  assert.deepEqual(bytes(f.control), before);
});

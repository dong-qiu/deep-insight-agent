import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initialize } from './ledger.mjs';
import { initializeBackupStore, openBackupStore } from './backup-store.mjs';
import { createBackupEntry } from './backup-entry.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r2-k-entry-')));
  t.after(() => rmSync(root, { recursive: true })); chmodSync(root, 0o700);
  const { publicKey } = generateKeyPairSync('ed25519');
  const target = { region: 'isolated', instanceId: 'fixture-k', volumeId: 'fixture-volume', dataPath: root, serviceSet: ['app'] };
  initialize(root, { target, approverId: 'fixture-reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  writeFileSync(join(root, 'fixture-business.sqlite'), 'not a valid SQLite DB; must never be opened by the kernel', { mode: 0o600 });
  mkdirSync(join(root, 'backup-attempt-v1'), { mode: 0o700 }); initializeBackupStore(root);
  for (const name of ['reports', 'raw', 'backups']) {
    mkdirSync(join(root, name), { mode: 0o700 }); writeFileSync(join(root, name, 'keep.txt'), 'existing recovery material', { mode: 0o600 });
  }
  const input = () => ({ schema: 'r2-backup-input-v1', operationId: `op-${randomUUID()}`, requestId: randomUUID(),
    ownerId: 'owner', executionIdentity: 'fixture-kernel', target: structuredClone(target),
    DB_PATH: join(root, 'fixture-business.sqlite'), DATA_DIR: root,
    keep: 3, includeRaw: true, windowMs: 1000, deadlineAt: Date.now() + 1000 });
  return { root, target, input };
}
function tree(root) {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name,
    entry.isDirectory() ? tree(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString('hex')]));
}

test('missing coverage is a fixed denial with whole source/control tree unchanged', async t => {
  const f = fixture(t), before = tree(f.root), entry = createBackupEntry(f.root);
  assert.deepEqual(Object.keys(entry).sort(), ['close', 'prepare']);
  const result = await entry.prepare(f.input(), new AbortController().signal);
  assert.equal(result.code, 'backup_source_coverage_unavailable'); assert.equal(result.kind, 'denied');
  assert.equal(result.attemptId, null); assert.equal(result.publication, 'not_attempted');
  assert.equal(result.positive_admission_ready, false); assert.deepEqual(tree(f.root), before);
  entry.close(); assert.deepEqual(tree(f.root), before);
});

test('no network, business write-open, mkdir, copy, rename or deletion on the actual denied entry', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import Database from 'better-sqlite3'; import assert from 'node:assert/strict';
    for (const name of ['mkdirSync','copyFileSync','renameSync','rmSync','unlinkSync','rmdirSync','writeFileSync'])
      fs[name]=()=>{throw new Error('unexpected_business_effect:'+name);};
    const open=fs.openSync; fs.openSync=(path,flags,...args)=>{
      if(String(path).startsWith(process.argv[1]+'/')) assert.ok(flags===fs.constants.O_RDONLY+fs.constants.O_NOFOLLOW);
      return open(path,flags,...args);};
    syncBuiltinESMExports();
    const prepare=Database.prototype.prepare;
    Database.prototype.prepare=function(...args){assert.ok(!this.name.includes('fixture-business.sqlite'));assert.equal(this.readonly,true);return prepare.apply(this,args);};
    globalThis.fetch=()=>{throw new Error('unexpected_network');};
    const {createBackupEntry}=await import('./ops/maintenance/backup-entry.mjs');
    const result=await createBackupEntry(process.argv[1]).prepare(JSON.parse(process.argv[2]),new AbortController().signal);
    assert.equal(result.code,'backup_source_coverage_unavailable');`, f.root, JSON.stringify(f.input())],
  { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});

for (const change of [
  { ready: true }, { proof: { covered: true } }, { windowMs: Infinity }, { windowMs: 0 },
  { windowMs: 2147483648 }, { keep: -1 }, { includeRaw: 'yes' },
]) {
  test(`unknown/unbounded configuration rejected: ${JSON.stringify(change)}`, async t => {
    const f = fixture(t), before = tree(f.root), entry = createBackupEntry(f.root);
    assert.equal((await entry.prepare({ ...f.input(), ...change }, new AbortController().signal)).code, 'backup_input_invalid');
    assert.deepEqual(tree(f.root), before); entry.close();
  });
}

test('dataPath is a directory, DB_PATH is the fixed file and the full target must match', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), original = f.input();
  for (const change of [
    { DATA_DIR: original.DB_PATH }, { DB_PATH: f.root },
    { target: { ...original.target, dataPath: original.DB_PATH } },
    { target: { ...original.target, volumeId: 'fixture-other' } },
  ]) assert.equal((await entry.prepare({ ...original, ...change }, new AbortController().signal)).code, 'backup_target_mismatch');
  entry.close();
});

test('mutable input and clone cannot extend the captured deadline or original cancellation signal', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), input = f.input(), controller = new AbortController();
  const pending = entry.prepare(input, controller.signal);
  input.windowMs = 2147483647; input.deadlineAt = Number.MAX_SAFE_INTEGER; input.target.dataPath = '/elsewhere';
  controller.abort();
  assert.equal((await pending).code, 'backup_cancelled');
  const expired = f.input(); expired.deadlineAt = Date.now() - 1;
  const pendingExpired = entry.prepare(expired, new AbortController().signal);
  expired.deadlineAt = Number.MAX_SAFE_INTEGER;
  assert.equal((await pendingExpired).code, 'backup_deadline_exceeded');
  const clone = await entry.prepare(structuredClone(f.input()), new AbortController().signal);
  assert.equal(clone.code, 'backup_source_coverage_unavailable'); entry.close();
});

test('genuine queued abort and the native signal getter defeat fake or shadowed aborted values', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), controller = new AbortController();
  const pending = entry.prepare(f.input(), controller.signal); queueMicrotask(() => controller.abort());
  assert.equal((await pending).code, 'backup_cancelled');
  assert.equal((await entry.prepare(f.input(), { aborted: false })).code, 'backup_input_invalid');
  Object.defineProperty(controller.signal, 'aborted', { value: false });
  assert.equal((await entry.prepare(f.input(), controller.signal)).code, 'backup_cancelled'); entry.close();
});

test('monotonic original budget expires even with a later wall deadline', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), input = { ...f.input(), windowMs: 2, deadlineAt: Number.MAX_SAFE_INTEGER };
  const pending = entry.prepare(input, new AbortController().signal);
  const until = performance.now() + 5; while (performance.now() < until) { /* force expiration before the yield resolves */ }
  assert.equal((await pending).code, 'backup_deadline_exceeded'); entry.close();
});

test('earlier absolute deadline also limits monotonic budget when wall time rolls back', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), input = f.input();
  const originalNow = Date.now, start = originalNow();
  input.windowMs = 1000; input.deadlineAt = start + 10;
  let observations = 0;
  Date.now = () => ++observations <= 2 ? start : start - 10000;
  try {
    const pending = entry.prepare(input, new AbortController().signal);
    const until = performance.now() + 20; while (performance.now() < until) { /* real time exceeds the original absolute budget */ }
    assert.equal((await pending).code, 'backup_deadline_exceeded');
  } finally { Date.now = originalNow; entry.close(); }
});

test('source file replacement while yielded is not rebound, and close never repairs attempts', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root);
  const pending = entry.prepare(f.input(), new AbortController().signal);
  const path = join(f.root, 'fixture-business.sqlite'); renameSync(path, path + '.previous');
  writeFileSync(path, 'replacement', { mode: 0o600 });
  assert.equal((await pending).code, 'backup_control_unavailable'); entry.close();
  assert.throws(() => createBackupEntry(f.root), /backup_source_changed/);
});

test('source symlink, missing control and cancelled consumer cannot initialize or acquire', async t => {
  const f = fixture(t), entry = createBackupEntry(f.root), pending = entry.prepare(f.input(), new AbortController().signal);
  entry.close(); assert.equal((await pending).code, 'backup_entry_closed');
  const path = join(f.root, 'fixture-business.sqlite'); rmSync(path); symlinkSync(join(f.root, 'isolation.json'), path);
  assert.throws(() => createBackupEntry(f.root), /unsafe_backup_path/);
  rmSync(join(f.root, 'backup-attempt-v1'), { recursive: true });
  assert.throws(() => createBackupEntry(f.root));
});

test('unresolved fixed control intent remains a denial, never a new entry attempt', async t => {
  const f = fixture(t), store = openBackupStore(f.root), input = f.input();
  const request = Object.fromEntries(['operationId', 'requestId', 'ownerId', 'executionIdentity', 'target', 'windowMs', 'deadlineAt'].map(key => [key, input[key]]));
  const blocker = new Database(join(f.root, 'backup-attempt-v1', 'backup-attempts.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try { assert.equal(store.recordCoverageUnavailable({ ...request, schema: 'r2-backup-denial-request-v1', fence: 1, revision: 1 }).kind, 'unknown'); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  store.close();
  const before = tree(f.root), entry = createBackupEntry(f.root);
  assert.equal((await entry.prepare(f.input(), new AbortController().signal)).code, 'backup_target_unresolved');
  assert.deepEqual(tree(f.root), before); entry.close();
});

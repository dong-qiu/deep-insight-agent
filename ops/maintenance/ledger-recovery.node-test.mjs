import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initialize, openLedger } from './ledger.mjs';
import { bindingFor, canonical, DOMAIN, hash } from './contract.mjs';

const evidenceRoot = process.env.A3_LEDGER_PREFLIGHT_TEST_EVIDENCE;
const digest = path => ({ size: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'insight-a3-ledger-recovery-'))); chmodSync(root, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const target = { region: 'isolated', instanceId: 'fixture-app', volumeId: 'fixture-data', dataPath: root, serviceSet: ['app'] };
  initialize(root, { target, approverId: 'fixture-reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  const ledger = openLedger(root);
  const request = { operationId: 'op-recovery', ownerId: 'fixture-owner', kind: 'deploy', executionIdentity: 'fixture-executor', target };
  let token = ledger.acquire(request); token = ledger.beginSubmit(token, hash('fixture-command'));
  token = ledger.hold(token, 'unknown_remote_process');
  const before = ledger.inspect();
  t.after(() => { ledger.close(); rmSync(root, { recursive: true }); });
  return { root, ledger, request, token, before, privateKey };
}
function crash(root) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db=new Database(process.argv[1]); db.pragma('cache_size=1'); db.exec('BEGIN IMMEDIATE');
    const last=db.prepare('SELECT max(seq) AS seq FROM events').get().seq;
    const ins=db.prepare('INSERT INTO events VALUES (?,?,?,?)');
    // Deliberately uncommitted rows must be removed by normal engine recovery, never trusted as audit.
    for(let i=1;i<=10000;i++) ins.run(last+i,'uncommitted','uncommitted','x'.repeat(1024));
    process.kill(process.pid,'SIGKILL');`, join(root, 'ledger.sqlite')], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: 'pipe' });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  assert.ok(statSync(join(root, 'ledger.sqlite-journal')).size > 512);
}
function preserved(root, label) {
  const db = join(root, 'ledger.sqlite'), journal = `${db}-journal`;
  const bytes = { db: digest(db), journal: digest(journal) };
  if (evidenceRoot) {
    // Explicit caller-owned directory only; no ambient evidence search or overwrites.
    const destination = realpathSync(evidenceRoot); assert.equal(statSync(destination).mode & 0o777, 0o700);
    for (const [name, path] of [['db', db], ['journal', journal]]) {
      const archive = join(destination, `${label}-${name}.bin`); copyFileSync(path, archive, 1); chmodSync(archive, 0o600);
      assert.deepEqual(digest(archive), bytes[name]);
    }
    const record = join(destination, `${label}-before.json`); writeFileSync(record, JSON.stringify({ root, ...bytes }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return bytes;
}
function after(root) { return { db: digest(join(root, 'ledger.sqlite')), journal: digest(join(root, 'ledger.sqlite-journal')) }; }

test('existing handle refuses unsafe hot journal before every transaction and preserves original bytes', t => {
  const f = fixture(t); crash(f.root); chmodSync(join(f.root, 'ledger.sqlite-journal'), 0o644);
  const before = preserved(f.root, 'existing-unsafe');
  const op = f.before.operations[f.token.operationId]; const binding = bindingFor(op);
  const payload = { ...binding, schema: 'a3-authorization-v1', revision: f.token.revision,
    approverId: 'fixture-reviewer', action: 'takeover', reason: 'fixture takeover planned', processesStopped: false, evidenceHash: null };
  const signed = { payload, signature: sign(null, Buffer.from(DOMAIN + canonical(payload)), f.privateKey).toString('hex') };
  for (const action of [
    () => f.ledger.inspect(), () => f.ledger.acquire(f.request),
    () => f.ledger.hold(f.token, 'another_reason'), () => f.ledger.complete(f.token),
    () => f.ledger.beginSubmit(f.token, hash('another-command')),
    () => f.ledger.bindCommand(f.token, { ...binding, commandId: randomUUID() }),
    () => f.ledger.observe(f.token, { ...binding, commandId: randomUUID(), status: 'InProgress' }),
    () => f.ledger.cancel(f.token), () => f.ledger.authorize(signed),
  ]) {
    assert.throws(action, /unsafe_maintenance_path/);
    assert.deepEqual(after(f.root), before);
  }
});

test('new open refuses unsafe real hot journal before engine recovery and preserves original bytes', t => {
  const f = fixture(t); crash(f.root); chmodSync(join(f.root, 'ledger.sqlite-journal'), 0o644);
  const before = preserved(f.root, 'new-unsafe');
  assert.throws(() => openLedger(f.root), /unsafe_maintenance_path/); assert.deepEqual(after(f.root), before);
});

test('existing handle legal hot recovery preserves held unknown submission and audit facts', t => {
  const f = fixture(t); crash(f.root);
  assert.equal(statSync(join(f.root, 'ledger.sqlite-journal')).mode & 0o777, 0o600);
  assert.deepEqual(f.ledger.inspect(), f.before);
  assert.equal(f.ledger.inspect().operations[f.token.operationId].state, 'submission_unknown');
  assert.throws(() => f.ledger.complete(f.token), /maintenance_not_verified/);
});

test('new handle legal hot recovery preserves held unknown submission and audit facts', t => {
  const f = fixture(t); crash(f.root); const reopened = openLedger(f.root); t.after(() => reopened.close());
  assert.deepEqual(reopened.inspect(), f.before);
  assert.equal(reopened.inspect().production_permitted, false);
});

test('existing handle detects replaced DB path before transaction or new operation', t => {
  const f = fixture(t); const path = join(f.root, 'ledger.sqlite');
  const bytes = readFileSync(path); rmSync(path); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const before = digest(path); assert.throws(() => f.ledger.inspect(), /maintenance_file_replaced/);
  assert.deepEqual(digest(path), before);
});

test('existing handle rejects changed marker with DB bytes unchanged', t => {
  const f = fixture(t); const markerPath = join(f.root, 'isolation.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')); marker.approverId = 'different-approver';
  writeFileSync(markerPath, JSON.stringify(marker)); const before = digest(join(f.root, 'ledger.sqlite'));
  assert.throws(() => f.ledger.inspect(), /maintenance_marker_changed/); assert.deepEqual(digest(join(f.root, 'ledger.sqlite')), before);
});

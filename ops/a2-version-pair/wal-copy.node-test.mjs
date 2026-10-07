import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupSyntheticDatabase, tableHashes } from './consistent-copy.mjs';
test('SIGKILL leaves committed WAL: main-file copy loses rows, real synthetic backup preserves every field and record', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2-pair-wal-counterexample-')), source = join(directory, 'source.db');
  const child = spawn(process.execPath, ['-e', `
    const Database=require('better-sqlite3'); const db=new Database(process.env.SYNTHETIC_DB);
    db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
    db.exec('CREATE TABLE business(id TEXT PRIMARY KEY, kind TEXT, value TEXT); CREATE TABLE deployment_record(id TEXT PRIMARY KEY, git_sha TEXT, image_digest TEXT, deployed_at TEXT, actor TEXT)');
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const kind of ['trace','ref','user','topic']) db.prepare('INSERT INTO business VALUES (?,?,?)').run('new_'+kind,kind,'exact_'+kind);
    db.prepare('INSERT INTO deployment_record VALUES (?,?,?,?,?)').run('release','release-sha','release-digest','first','release-actor');
    db.prepare('INSERT INTO deployment_record VALUES (?,?,?,?,?)').run('candidate','candidate-sha','candidate-digest','second','candidate-actor');
    console.log('WAL_READY'); setInterval(()=>{},1000);
  `], { cwd: process.cwd(), env: { PATH: process.env.PATH, SYNTHETIC_DB: source }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('synthetic WAL preparation timed out')), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('WAL_READY')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(child.kill('SIGKILL'), true); assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.equal(existsSync(`${source}-wal`), true, 'counterexample requires real WAL');
    const mainOnly = join(directory, 'unsafe-main-only.db'); copyFileSync(source, mainOnly);
    const unsafe = new Database(mainOnly, { readonly: true });
    try { assert.equal(unsafe.prepare('SELECT count(*) n FROM business').get().n, 0); assert.equal(unsafe.prepare('SELECT count(*) n FROM deployment_record').get().n, 0); } finally { unsafe.close(); }
    const target = join(directory, 'consistent.db'), result = await backupSyntheticDatabase(Database, source, target);
    const copied = new Database(target, { readonly: true });
    try {
      assert.equal(copied.prepare('SELECT count(*) n FROM business').get().n, 4);
      assert.equal(copied.prepare('SELECT count(*) n FROM deployment_record').get().n, 2);
      assert.deepEqual(tableHashes(copied), result.source_tables);
    } finally { copied.close(); }
    await assert.rejects(() => backupSyntheticDatabase(Database, source, target), /overwrite/);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } rmSync(directory, { recursive: true, force: true }); }
});

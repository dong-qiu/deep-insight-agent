/** Isolated, caller-declared writer registration. No production adapter, drain-ready or resume. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { canonical, check, same } from './contract.mjs';
import { openLedger } from './ledger.mjs';

const APP_ID = 0x41335731;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const workerSchema = z.strictObject({ workerId: id, generationToken: z.uuid() });
const taskSchema = workerSchema.extend({ taskId: z.uuid() });
const entrySchema = z.literal('generation-dispatch');
const outcomeSchema = z.enum(['no_claim', 'done', 'failed', 'threw']);
const objects = {
  identity: 'CREATE TABLE identity (marker TEXT NOT NULL)',
  admission: "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('open','closed')))",
  workers: 'CREATE TABLE workers (worker_id TEXT PRIMARY KEY, generation_token TEXT UNIQUE NOT NULL, entry_point TEXT NOT NULL)',
  tasks: 'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(worker_id))',
  completions: 'CREATE TABLE completions (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), outcome TEXT NOT NULL)',
};
for (const table of ['identity', 'workers', 'tasks', 'completions']) {
  for (const action of ['UPDATE', 'DELETE']) objects[`${table}_no_${action.toLowerCase()}`] = `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'writer_facts_append_only'); END`;
}
objects.admission_no_delete = "CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT, 'writer_admission_permanent'); END";
objects.admission_no_reopen = "CREATE TRIGGER admission_no_reopen BEFORE UPDATE ON admission WHEN OLD.mode='closed' BEGIN SELECT RAISE(ABORT, 'writer_admission_permanent'); END";

function parse(schema, raw) { const value = schema.safeParse(raw); check(value.success, 'invalid_writer_record'); return value.data; }
function safe(path, directory = false) {
  const info = lstatSync(path);
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || info.nlink === 1), 'unsafe_writer_path');
  return info;
}
function journalCheck(path) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { safe(`${path}${suffix}`); check(suffix === '-journal', 'unexpected_writer_sidecar'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function rootCheck(root) { check(isAbsolute(root) && root === realpathSync(root), 'noncanonical_writer_root'); safe(root, true); }
function ledgerMarker(root) {
  const ledger = openLedger(root);
  try { return ledger.inspect().marker; } finally { ledger.close(); }
}
function syncDirectory(root) { const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

export function initializeWriters(root) {
  rootCheck(root); const marker = ledgerMarker(root);
  const markerPath = join(root, 'writers-isolation.json');
  const markerFd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(markerFd, canonical({ schema: 'a3-writers-isolation-v1', marker })); fsyncSync(markerFd); } finally { closeSync(markerFd); }
  syncDirectory(root);
  const path = join(root, 'writers.sqlite');
  // O_EXCL leaves a permanent incomplete file if initialization is interrupted.
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { check(fstatSync(fd).nlink === 1, 'unsafe_writer_path'); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(root);
  journalCheck(path);
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    db.transaction(() => {
      for (const sql of Object.values(objects)) db.exec(sql);
      db.pragma(`application_id = ${APP_ID}`); db.pragma('user_version = 1');
      db.prepare('INSERT INTO identity VALUES (?)').run(canonical(marker));
      db.prepare("INSERT INTO admission VALUES (1,'open')").run();
    }).immediate();
  } finally { db.close(); }
  syncDirectory(root);
}

export function openWriters(root) {
  rootCheck(root); const marker = ledgerMarker(root);
  const markerPath = join(root, 'writers-isolation.json');
  function markerCheck() {
    const info = safe(markerPath); check(info.size <= 16384, 'writer_marker_too_large');
    const fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); check(opened.dev === info.dev && opened.ino === info.ino, 'writer_marker_changed');
      check(readFileSync(fd, 'utf8') === canonical({ schema: 'a3-writers-isolation-v1', marker }), 'writer_marker_changed');
    } finally { closeSync(fd); }
  }
  markerCheck();
  const path = join(root, 'writers.sqlite'); const identity = safe(path);
  journalCheck(path); // Validate before SQLite is allowed to recover/remove a hot journal.
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  function pathCheck() {
    rootCheck(root); markerCheck(); const current = safe(path);
    check(current.dev === identity.dev && current.ino === identity.ino, 'writer_file_replaced');
    journalCheck(path);
  }
  function validate() {
    pathCheck();
    check(same(marker, ledgerMarker(root)), 'writer_marker_changed');
    check(db.pragma('application_id', { simple: true }) === APP_ID && db.pragma('user_version', { simple: true }) === 1, 'invalid_writer_version');
    check(db.pragma('journal_mode', { simple: true }) === 'delete' && db.pragma('foreign_keys', { simple: true }) === 1, 'invalid_writer_database');
    const actual = Object.fromEntries(db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(row => [row.name, row.sql]));
    check(same(actual, objects), 'invalid_writer_schema');
    const rows = db.prepare('SELECT marker FROM identity').all();
    check(rows.length === 1 && rows[0].marker === canonical(marker), 'writer_marker_changed');
    const gate = db.prepare('SELECT * FROM admission').all();
    check(gate.length === 1 && gate[0].id === 1 && ['open', 'closed'].includes(gate[0].mode), 'invalid_writer_admission');
    check(db.pragma('foreign_key_check').length === 0, 'invalid_writer_relationship');
    for (const row of db.prepare('SELECT * FROM workers').all()) {
      parse(workerSchema, { workerId: row.worker_id, generationToken: row.generation_token }); parse(entrySchema, row.entry_point);
    }
    for (const row of db.prepare('SELECT * FROM tasks').all()) parse(z.uuid(), row.task_id);
    for (const row of db.prepare('SELECT * FROM completions').all()) parse(outcomeSchema, row.outcome);
  }
  function transact(fn) {
    // BEGIN itself may recover a hot journal on a previously opened handle.
    // No SQLite operation is allowed before the filesystem preflight.
    pathCheck();
    return db.transaction(() => { validate(); return fn(); }).immediate();
  }
  try {
    db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    transact(() => undefined);
  } catch (error) { db.close(); throw error; }
  function openAdmission() { check(db.prepare('SELECT mode FROM admission WHERE id=1').get().mode === 'open', 'writer_admission_closed'); }
  function owned(raw) {
    const token = parse(workerSchema, raw);
    const worker = db.prepare('SELECT * FROM workers WHERE worker_id=? AND generation_token=?').get(token.workerId, token.generationToken);
    check(worker, 'writer_owner_lost'); return token;
  }
  function register(workerId, entryPoint) {
    parse(id, workerId); parse(entrySchema, entryPoint);
    return transact(() => {
      openAdmission(); check(!db.prepare('SELECT 1 FROM workers WHERE worker_id=?').get(workerId), 'writer_generation_exists');
      const token = { workerId, generationToken: randomUUID() };
      db.prepare('INSERT INTO workers VALUES (?,?,?)').run(workerId, token.generationToken, entryPoint); return token;
    });
  }
  function admit(rawWorker) {
    return transact(() => {
      const worker = owned(rawWorker); openAdmission();
      const token = { ...worker, taskId: randomUUID() };
      db.prepare('INSERT INTO tasks VALUES (?,?)').run(token.taskId, token.workerId); return token;
    });
  }
  function finish(rawTask, outcome) {
    const task = parse(taskSchema, rawTask); parse(outcomeSchema, outcome);
    return transact(() => {
      owned({ workerId: task.workerId, generationToken: task.generationToken });
      check(db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND worker_id=?').get(task.taskId, task.workerId), 'writer_owner_lost');
      const previous = db.prepare('SELECT outcome FROM completions WHERE task_id=?').get(task.taskId);
      if (previous) { check(previous.outcome === outcome, 'writer_completion_conflict'); return; }
      db.prepare('INSERT INTO completions VALUES (?,?)').run(task.taskId, outcome);
    });
  }
  function closeAdmission() {
    return transact(() => { db.prepare("UPDATE admission SET mode='closed' WHERE id=1 AND mode='open'").run(); });
  }
  function inspect() {
    return transact(() => ({
      schema: 'a3-writer-admission-v1', scope: 'isolated', entryPoint: 'generation-dispatch', coreCoverage: 'runGenerationDispatchOnce',
      marker: structuredClone(marker), admission: db.prepare('SELECT mode FROM admission WHERE id=1').get().mode,
      workers: db.prepare('SELECT worker_id AS workerId, entry_point AS entryPoint FROM workers ORDER BY rowid').all(),
      tasks: db.prepare('SELECT t.task_id AS taskId,t.worker_id AS workerId,c.outcome FROM tasks t LEFT JOIN completions c USING(task_id) ORDER BY t.rowid').all().map(row => ({ ...row, remote_subwork: 'unknown' })),
      writer_quiescence: false, production_permitted: false,
    }));
  }
  function admissionFor(worker) {
    transact(() => owned(worker));
    return { scope: 'isolated', entryPoint: 'generation-dispatch', admit: () => admit(worker), finish };
  }
  return { register, admit, finish, closeAdmission, admissionFor, inspect, close: () => db.close() };
}

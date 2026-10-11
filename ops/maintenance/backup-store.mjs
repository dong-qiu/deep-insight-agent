/** K only: append denied control facts. Never grants backup or writer permission. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { canonical, check, hash, markerSchema, parse, same, tokenSchema } from './contract.mjs';

const APP_ID = 0x52324b31;
const MAX_RECORD = 16384;
const directoryName = 'backup-attempt-v1';
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const sourceSchema = z.strictObject({
  root: z.string(), directory: identitySchema, markerFile: identitySchema,
  ledgerFile: identitySchema, businessFile: identitySchema, s0Marker: markerSchema,
});
const initSchema = z.strictObject({
  schema: z.literal('r2-backup-init-v1'), storeId: z.uuid(),
  source: sourceSchema, controlDirectory: identitySchema,
});
const physicalSchema = z.strictObject({
  schema: z.literal('r2-backup-physical-v1'), initHash: z.string().regex(/^[a-f0-9]{64}$/),
  initFile: identitySchema, database: identitySchema,
});
const requestSchema = tokenSchema.extend({
  schema: z.literal('r2-backup-denial-request-v1'), requestId: z.uuid(),
  windowMs: integer.min(1).max(2147483647), deadlineAt: integer.min(1),
});
const intentSchema = z.strictObject({
  schema: z.literal('r2-backup-intent-v1'), attemptId: z.uuid(),
  storeId: z.uuid(), initHash: z.string().regex(/^[a-f0-9]{64}$/), request: requestSchema,
});
const objects = Object.freeze({
  identity: 'CREATE TABLE identity (init_hash TEXT NOT NULL)',
  reservations: 'CREATE TABLE reservations (seq INTEGER PRIMARY KEY, attempt_id TEXT UNIQUE NOT NULL, operation_id TEXT UNIQUE NOT NULL, intent_hash TEXT UNIQUE NOT NULL, intent TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL)',
  denials: "CREATE TABLE denials (attempt_id TEXT PRIMARY KEY, reservation_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome='coverage_unavailable'))",
  identity_no_update: "CREATE TRIGGER identity_no_update BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
  identity_no_delete: "CREATE TRIGGER identity_no_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
  reservations_no_update: "CREATE TRIGGER reservations_no_update BEFORE UPDATE ON reservations BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
  reservations_no_delete: "CREATE TRIGGER reservations_no_delete BEFORE DELETE ON reservations BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
  denials_no_update: "CREATE TRIGGER denials_no_update BEFORE UPDATE ON denials BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
  denials_no_delete: "CREATE TRIGGER denials_no_delete BEFORE DELETE ON denials BEGIN SELECT RAISE(ABORT, 'backup_facts_append_only'); END",
});

function ordinary(path, directory = false) {
  const info = lstatSync(path, { bigint: true });
  check((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
    && info.uid === BigInt(process.getuid()) && (info.mode & 0o777n) === (directory ? 0o700n : 0o600n)
    && (directory || info.nlink === 1n), 'unsafe_backup_path');
  return { dev: String(info.dev), ino: String(info.ino) };
}
function directory(path) {
  check(typeof path === 'string' && isAbsolute(path) && realpathSync(path) === path, 'noncanonical_backup_root');
  return ordinary(path, true);
}
function readOrdinary(path) {
  const identity = ordinary(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd, { bigint: true });
    check(same(identity, { dev: String(info.dev), ino: String(info.ino) }) && info.nlink === 1n
      && info.uid === BigInt(process.getuid()) && (info.mode & 0o777n) === 0o600n
      && info.size <= BigInt(MAX_RECORD), 'unsafe_backup_path');
    const raw = readFileSync(fd);
    check(raw.length <= MAX_RECORD && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw), 'invalid_backup_record');
    check(same(identity, ordinary(path)), 'backup_path_changed');
    return { text: raw.toString('utf8'), identity };
  } finally { closeSync(fd); }
}
function readRecord(path, schema) {
  const raw = readOrdinary(path), value = parse(schema, JSON.parse(raw.text));
  check(canonical(value) === raw.text, 'invalid_backup_record');
  return { ...raw, value };
}
function source(root) {
  const rootIdentity = directory(root);
  const marker = readRecord(join(root, 'isolation.json'), markerSchema);
  check(marker.value.target.dataPath === root, 'backup_target_mismatch');
  return {
    root, directory: rootIdentity, markerFile: marker.identity,
    ledgerFile: ordinary(join(root, 'ledger.sqlite')),
    businessFile: ordinary(join(root, 'fixture-business.sqlite')), s0Marker: marker.value,
  };
}
function noSidecars(path) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { lstatSync(path + suffix); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Do not let SQLite recover/delete even a legal hot journal in this slice.
    throw new Error('backup_control_sidecar_present');
  }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createDurable(path, text, parent) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { if (text !== undefined) writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(parent);
}
function preflight(root, expected) {
  const currentSource = source(root), control = join(root, directoryName);
  const controlIdentity = directory(control);
  const init = readRecord(join(control, 'init.json'), initSchema);
  check(same(init.value.source, currentSource) && same(init.value.controlDirectory, controlIdentity), 'backup_source_changed');
  const physical = readRecord(join(control, 'physical.json'), physicalSchema);
  const path = join(control, 'backup-attempts.sqlite');
  check(physical.value.initHash === hash(init.text) && same(physical.value.initFile, init.identity)
    && same(physical.value.database, ordinary(path)), 'backup_control_changed');
  noSidecars(path);
  const binding = { init: init.value, physical: physical.value, physicalFile: physical.identity };
  if (expected) check(same(binding, expected), 'backup_control_changed');
  return { binding, control, path, initHash: hash(init.text) };
}

/** Explicit new, empty, caller-prepared control directory. No mkdir or repair. */
export function initializeBackupStore(root) {
  const captured = source(root), control = join(root, directoryName), controlDirectory = directory(control);
  check(readdirSync(control).length === 0, 'backup_already_initialized');
  const init = { schema: 'r2-backup-init-v1', storeId: randomUUID(), source: captured, controlDirectory };
  // The first exclusive, synced file is a permanent interrupted-init tombstone.
  createDurable(join(control, 'init.json'), canonical(init), control);
  const path = join(control, 'backup-attempts.sqlite');
  createDurable(path, undefined, control);
  const physical = { schema: 'r2-backup-physical-v1', initHash: hash(canonical(init)),
    initFile: ordinary(join(control, 'init.json')), database: ordinary(path) };
  createDurable(join(control, 'physical.json'), canonical(physical), control);
  preflight(root);
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('journal_mode=DELETE'); db.pragma('synchronous=FULL');
    db.transaction(() => {
      for (const sql of Object.values(objects)) db.exec(sql);
      db.pragma(`application_id=${APP_ID}`); db.pragma('user_version=1');
      db.prepare('INSERT INTO identity VALUES (?)').run(physical.initHash);
    }).immediate();
  } finally { db.close(); }
  syncDirectory(control);
}

function metadata(db, initHash) {
  check(db.pragma('journal_mode', { simple: true }) === 'delete'
    && db.pragma('application_id', { simple: true }) === APP_ID
    && db.pragma('user_version', { simple: true }) === 1, 'invalid_backup_version');
  const actual = Object.fromEntries(db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(row => [row.name, row.sql]));
  check(same(actual, objects), 'invalid_backup_schema');
  const rows = db.prepare('SELECT * FROM identity').all();
  check(rows.length === 1 && rows[0].init_hash === initHash, 'invalid_backup_identity');
}
function inventory(control, binding, initHash) {
  const entries = [];
  for (const name of readdirSync(control).sort()) {
    if (['init.json', 'physical.json', 'backup-attempts.sqlite'].includes(name)) continue;
    check(/^intent-[a-f0-9-]{36}\.json$/.test(name), 'unexpected_backup_control_file');
    const record = readRecord(join(control, name), intentSchema), intent = record.value;
    check(name === `intent-${intent.attemptId}.json` && intent.storeId === binding.init.storeId
      && intent.initHash === initHash && same(intent.request.target, binding.init.source.s0Marker.target), 'backup_intent_mismatch');
    entries.push({ intent, text: record.text, hash: hash(record.text) });
  }
  return entries;
}
function facts(db, control, binding, initHash) {
  metadata(db, initHash);
  const intents = inventory(control, binding, initHash);
  const rows = db.prepare('SELECT * FROM reservations ORDER BY seq').all();
  const denials = db.prepare('SELECT * FROM denials').all();
  let previous = 'genesis';
  const confirmed = [];
  for (const [index, row] of rows.entries()) {
    const intent = parse(intentSchema, JSON.parse(row.intent));
    check(canonical(intent) === row.intent && row.seq === index + 1 && row.attempt_id === intent.attemptId
      && row.operation_id === intent.request.operationId && row.intent_hash === hash(row.intent)
      && row.previous_hash === previous
      && row.hash === hash(`${previous}\n${row.intent}\nreserved`), 'backup_audit_corrupt');
    const file = intents.find(item => item.intent.attemptId === row.attempt_id);
    check(file && file.text === row.intent, 'backup_intent_missing_or_changed');
    const denial = denials.find(item => item.attempt_id === row.attempt_id);
    if (denial) {
      check(denial.reservation_hash === row.hash && denial.outcome === 'coverage_unavailable', 'backup_audit_corrupt');
      confirmed.push(row.attempt_id);
    }
    previous = row.hash;
  }
  check(denials.every(item => rows.some(row => row.attempt_id === item.attempt_id)), 'backup_audit_corrupt');
  const unresolved = intents.filter(item => !confirmed.includes(item.intent.attemptId)).map(item => item.intent.attemptId);
  return { schema: 'r2-backup-denial-facts-v1', positive_admission_ready: false, production_permitted: false,
    // K is deliberately one-shot. Even a confirmed DENIAL is not a release.
    // No new operation can erase an ACK uncertainty or infer future permission.
    target: binding.init.source.s0Marker.target, blocked: intents.length > 0, unresolved,
    reservations: rows.map(row => ({ attemptId: row.attempt_id, operationId: row.operation_id })),
    denials: rows.filter(row => confirmed.includes(row.attempt_id)).map(row => ({ attemptId: row.attempt_id,
      operationId: row.operation_id, outcome: 'coverage_unavailable', publication: 'not_attempted' })) };
}
function result(attemptId, unknown = false) {
  return Object.freeze({ kind: unknown ? 'unknown' : 'denied', attemptId,
    code: unknown ? 'backup_reservation_unknown' : 'backup_source_coverage_unavailable',
    publication: 'not_attempted', controlReceipt: unknown ? 'unknown' : 'confirmed',
    durability: 'not_applicable', positive_admission_ready: false });
}

/** A protocol fact kernel, NOT an admission producer; no public grant or resume. */
export function openBackupStore(root) {
  const captured = preflight(root).binding;
  let closed = false, uncertain = false;
  function physical() {
    check(!closed, 'backup_store_closed');
    return preflight(root, captured);
  }
  function inspect() {
    const p = physical();
    const db = new Database(p.path, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const view = db.transaction(() => facts(db, p.control, captured, p.initHash))();
      physical(); // Do not return a diagnostic for a replaced path.
      uncertain ||= view.blocked;
      return structuredClone({ ...view, blocked: view.blocked || uncertain });
    } finally { db.close(); }
  }
  function recordCoverageUnavailable(raw) {
    const request = parse(requestSchema, raw);
    check(same(request.target, captured.init.source.s0Marker.target), 'backup_target_mismatch');
    const before = inspect();
    check(!before.reservations.some(item => item.operationId === request.operationId), 'backup_operation_consumed');
    check(!before.blocked, 'backup_target_unresolved');
    const p = physical(), attemptId = randomUUID();
    const intent = { schema: 'r2-backup-intent-v1', attemptId, storeId: captured.init.storeId, initHash: p.initHash, request };
    const text = canonical(intent);
    // After this point any failure retains an intent/barrier; never delete or retry.
    try {
      createDurable(join(p.control, `intent-${attemptId}.json`), text, p.control);
      physical();
      const db = new Database(p.path, { fileMustExist: true, timeout: 0 });
      try {
        db.pragma('synchronous=FULL');
        physical();
        db.transaction(() => {
          const view = facts(db, p.control, captured, p.initHash);
          check(view.reservations.length === 0 && view.unresolved.length === 1
            && view.unresolved[0] === attemptId, 'backup_target_unresolved');
          check(!view.reservations.some(item => item.operationId === request.operationId), 'backup_operation_consumed');
          const last = db.prepare('SELECT seq,hash FROM reservations ORDER BY seq DESC LIMIT 1').get();
          const previous = last?.hash ?? 'genesis';
          db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?)').run((last?.seq ?? 0) + 1,
            attemptId, request.operationId, hash(text), text, previous,
            hash(`${previous}\n${text}\nreserved`));
        }).immediate();
        // Only a returned reservation COMMIT permits the fixed denied outcome.
        // Lost initial ACK must not infer completion from the reservation row.
        physical();
        db.transaction(() => {
          facts(db, p.control, captured, p.initHash);
          const row = db.prepare('SELECT hash FROM reservations WHERE attempt_id=?').get(attemptId);
          check(row, 'backup_reservation_unconfirmed');
          db.prepare('INSERT INTO denials VALUES (?,?,?)').run(attemptId, row.hash, 'coverage_unavailable');
        }).immediate();
      } finally { db.close(); }
      const after = inspect();
      check(after.unresolved.length === 0 && after.denials.some(item => item.attemptId === attemptId), 'backup_reservation_unconfirmed');
      return result(attemptId);
    } catch {
      uncertain = true;
      return result(attemptId, true);
    }
  }
  // Validate initial schema/facts, but never mutate or repair them.
  inspect();
  return Object.freeze({ inspect, recordCoverageUnavailable, close() { closed = true; } });
}

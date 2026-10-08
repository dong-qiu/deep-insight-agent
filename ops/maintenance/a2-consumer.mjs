/** Fixed isolated consumer. Byte binding is never authentication or execution permission. */
import Database from 'better-sqlite3';
import { z } from 'zod';
import { constants, lstatSync, fstatSync, openSync, readSync, closeSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessA2 } from '../aws/a2-rollback-contract.mjs';
import { canonical, same, hash, markerSchema, tokenSchema, bindingSchema, tokenFor, bindingFor } from './contract.mjs';
import { openLedger } from './ledger.mjs';
import { openWriters } from './writers.mjs';
import { openDrainLeaseSource } from './drain.mjs';

const MiB = 1024 * 1024;
const roles = {
  schema: ['schema.txt', MiB], migrations: ['migrations.json', 256 * 1024],
  configuration: ['configuration.json', 65536], data_sample: ['data-sample.json', MiB], compose: ['compose.yml', 65536],
  identity: ['receipt-identity.json', 65536], security: ['receipt-security.json', 65536],
  isolated_compatibility: ['receipt-isolated-compatibility.json', 65536],
  production_compatibility: ['receipt-production-compatibility.json', 65536], approval: ['receipt-approval.json', 65536],
};
const clauses = {
  identity: ['isolated-runner', ['actual_pull', 'compose_binding']],
  security: ['isolated-runner', ['native_six', 'builder_source_map_magicast', 'runtime_source_map', 'auth_reader_contract']],
  isolated_compatibility: ['synthetic', ['pre_release', 'target_new_data', 'post_migration', 'rollback_read_update', 'no_data_loss']],
  production_compatibility: ['current-production', ['schema', 'configuration', 'backup_hash_integrity', 'capacity', 'no_data_loss']],
  approval: ['scoped-authorization', ['operator', 'oncall', 'reviewer', 'approver', 'continuous_stop_accepted']],
};
const optional = new Set(['production_compatibility', 'approval']);
const digest = z.string().regex(/^[a-f0-9]{64}$/).refine(x => !/^0+$/.test(x));
const text = z.string().min(1).max(512).refine(x => x.trim().length > 0);
const identitySchema = z.strictObject({ repository: text, revision: z.string().regex(/^[a-f0-9]{40}$/), platform: z.literal('linux/amd64'),
  index_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), manifest_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  config_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), compose_sha256: digest });
const contextSchema = z.strictObject({ operation_id: text, maintenance_holder: text, operator: text,
  schema_sha256: digest, migrations_sha256: digest, configuration_sha256: digest, data_sample_sha256: digest, release: identitySchema });
const claimBindingSchema = contextSchema.extend({ rollback: identitySchema });
const claimSchemas = Object.fromEntries(Object.entries(clauses).map(([role, [scope, checks]]) => [role, z.strictObject({
  scope: z.literal(scope), result: z.enum(['pass', 'fail', 'not-run']), issued_at: z.string().max(32), expires_at: z.string().max(32),
  binding: claimBindingSchema, checks: z.strictObject(Object.fromEntries(checks.map(k => [k, z.boolean()]))), receipt_sha256: digest,
})]));
const descriptorSchema = z.strictObject({ size: z.number().int().min(1).max(4 * MiB), sha256: digest });
const envelopeSchema = z.strictObject({ schema_version: z.literal('a2-a3-isolated-consumer-v1'),
  a2: z.strictObject({ schema_version: z.literal('a2-a3-handoff-v1'),
    phase: z.enum(['before-writer-stop', 'writers-stopped', 'backup', 'migration', 'deployment-record', 'readiness', 'rollback-readiness']),
    context: contextSchema, rollback: identitySchema,
    evidence: z.strictObject(Object.fromEntries(Object.entries(claimSchemas).map(([k, v]) => [k, optional.has(k) ? v.optional() : v]))),
  }),
  a3: z.strictObject({ token: tokenSchema, binding: bindingSchema }),
  artifacts: z.strictObject(Object.fromEntries(Object.keys(roles).map(k => [k, optional.has(k) ? descriptorSchema.optional() : descriptorSchema]))),
});
const hold = Object.freeze({ deployment_permitted: false, rollback_permitted: false, production_permitted: false,
  database_restore_permitted: false, inverse_migration_permitted: false, drain_ready: false, writer_quiescence: false,
  approved_safe_rollback: null, observation_atomic: false, controller_uniqueness: 'unknown', process_termination: 'unknown',
  all_writer_coverage: false, commands_executed: false });
class ConsumerError extends Error { constructor(code) { super(code); this.code = code; } }
const require = (condition, code) => { if (!condition) throw new ConsumerError(code); };
const parsed = (schema, value) => { const r = schema.safeParse(value); require(r.success, 'invalid_consumer_input'); return r.data; };
const json = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ConsumerError('invalid_artifact_json'); } };
function stamp(s) { return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }; }
function safe(path, directory = false, cap = Infinity) {
  const s = lstatSync(path);
  require((directory ? s.isDirectory() : s.isFile()) && !s.isSymbolicLink() && s.uid === process.getuid()
    && (s.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory || s.nlink === 1), 'unsafe_consumer_path');
  require(s.size <= cap, 'fixture_capacity_exceeded'); return s;
}
function rootCheck(root) { require(isAbsolute(root) && root === realpathSync(root), 'noncanonical_consumer_root'); safe(root, true); }
/** Reads at most cap+1, checking the limit DURING consumption, including growing files/pipes. */
function chunks(fd, cap, batch) {
  const pieces = []; let total = 0;
  for (;;) {
    const remaining = Math.min(cap - total, batch ? batch.remaining : cap - total);
    const piece = Buffer.alloc(Math.min(8192, remaining + 1));
    const n = readSync(fd, piece, 0, piece.length, null);
    if (!n) break;
    require(n <= remaining, 'artifact_capacity_exceeded');
    total += n; if (batch) batch.remaining -= n;
    pieces.push(piece.subarray(0, n));
  }
  const bytes = Buffer.concat(pieces, total);
  require(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), 'invalid_artifact_utf8'); return bytes;
}
function fileBytes(path, cap, batch) {
  const before = safe(path, false, cap), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    require(opened.isFile() && opened.uid === process.getuid() && (opened.mode & 0o777) === 0o600 && opened.nlink === 1
      && same(stamp(opened), stamp(before)), 'artifact_changed');
    const bytes = chunks(fd, cap, batch);
    require(bytes.length === before.size && same(stamp(fstatSync(fd)), stamp(before))
      && same(stamp(safe(path, false, cap)), stamp(before)), 'artifact_changed');
    return { bytes, stamp: stamp(before) };
  } finally { closeSync(fd); }
}
function physical(root) {
  rootCheck(root);
  const directory = safe(root, true), out = { root: { dev: directory.dev, ino: directory.ino } };
  for (const [name, cap] of [['ledger.sqlite', 16 * MiB], ['writers.sqlite', 16 * MiB], ['fixture-business.sqlite', 64 * MiB]]) {
    const path = join(root, name); out[name] = stamp(safe(path, false, cap));
    require(realpathSync(path) === path, 'noncanonical_consumer_database');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { out[name + suffix] = stamp(safe(path + suffix, false, cap));
        require(name === 'fixture-business.sqlite' || suffix === '-journal', 'unexpected_consumer_sidecar');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return out;
}
// All SQL identifiers below are private constants, never supplied by JSON or environment.
function rowLimit(db, table, limit, where = '') {
  require(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} ${where} LIMIT ${limit + 1})`).get().n <= limit, 'fixture_capacity_exceeded');
}
function columnGate(db, table, columns, where = '') {
  for (const [column, cap, nullable = false, integer = false, nonempty = false] of columns) {
    const invalid = integer ? `(typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991)`
      : `(typeof(${column})!='text' OR length(CAST(${column} AS BLOB))>${cap}${nonempty ? ` OR length(CAST(${column} AS BLOB))=0` : ''})`;
    require(!db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${where ? `(${where}) AND ` : ''}${nullable ? `${column} IS NOT NULL AND ` : ''}${invalid}) AS bad`).get().bad, 'fixture_column_invalid');
  }
}
function textBytes(db, table, columns, where = '') {
  const term = columns.map(k => `coalesce(length(CAST(${k} AS BLOB)),0)`).join('+');
  return db.prepare(`SELECT coalesce(sum(${term}),0) AS n FROM ${table} ${where ? `WHERE ${where}` : ''}`).get().n;
}
function count(db, table, where = '') { return db.prepare(`SELECT count(*) AS n FROM ${table} ${where ? `WHERE ${where}` : ''}`).get().n; }
function schemaGate(db, registry = false) {
  const where = 'sql IS NOT NULL'; rowLimit(db, 'sqlite_master', registry ? 32 : 1024, 'WHERE ' + where);
  columnGate(db, 'sqlite_master', [['type', 512], ['name', 512], ['tbl_name', 512], ['sql', 65536]], where);
  const n = count(db, 'sqlite_master', where), bytes = textBytes(db, 'sqlite_master', ['type', 'name', 'tbl_name', 'sql'], where);
  require(registry ? textBytes(db, 'sqlite_master', ['sql'], where) <= 256 * 1024 : 6 * bytes + n * 1024 + 256 <= MiB, 'fixture_capacity_exceeded');
}
function registryGate(db, kind) {
  schemaGate(db, true);
  if (kind === 'ledger') {
    rowLimit(db, 'events', 512);
    columnGate(db, 'events', [['seq', 0, false, true], ['previous_hash', 64], ['hash', 64], ['snapshot', 65536]]);
    require(textBytes(db, 'events', ['snapshot']) <= 4 * MiB, 'fixture_capacity_exceeded');
  } else {
    const tables = {
      identity: [['marker', 16384]], admission: [['id', 0, false, true], ['mode', 6]],
      workers: [['worker_id', 128], ['generation_token', 36], ['entry_point', 128]],
      tasks: [['task_id', 36], ['worker_id', 128]], completions: [['task_id', 36], ['outcome', 32]],
    };
    for (const [table, columns] of Object.entries(tables)) { rowLimit(db, table, ['identity', 'admission'].includes(table) ? 1 : 1024); columnGate(db, table, columns); }
  }
}
const dColumns = ['id', 'trace_id', 'state', 'owner_token', 'claim_epoch', 'lease_expires_at'];
const lColumns = ['id', 'trace_id', 'state', 'owner_token', 'fencing_epoch', 'expires_at', 'active_key', 'scope_key'];
function businessFacts(db, marker) {
  schemaGate(db);
  rowLimit(db, 'schema_migration', 1024);
  columnGate(db, 'schema_migration', [['version', 512, false, false, true], ['checksum', 64, false, false, true]]);
  const mCount = count(db, 'schema_migration'), mBytes = textBytes(db, 'schema_migration', ['version', 'checksum']);
  require(mBytes * 6 + mCount * 256 + 256 <= 256 * 1024, 'fixture_capacity_exceeded');
  let total = 256;
  for (const [table, columns, epoch] of [['generation_dispatch', dColumns, 'claim_epoch'], ['generation_lease', lColumns, 'fencing_epoch']]) {
    rowLimit(db, table, 1024);
    columnGate(db, table, columns.map(k => [k, 512, ['owner_token', 'lease_expires_at', 'expires_at'].includes(k), k === epoch]));
    total += textBytes(db, table, columns.filter(k => k !== epoch)) * 6 + count(db, table) * 1024;
  }
  require(total <= MiB, 'fixture_capacity_exceeded');
  // Low projection admission above precedes EVERY complete column allocation in this snapshot.
  const migrations = db.prepare('SELECT version,checksum FROM schema_migration ORDER BY version LIMIT 1025').all();
  require(new Set(migrations.map(r => r.version)).size === migrations.length && migrations.every(r => /^[a-f0-9]{64}$/.test(r.checksum)), 'invalid_migration_sample');
  const result = {
    schema: { schema_version: 'a2-isolated-schema-sample-v1', scope: 'synthetic', objects: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name LIMIT 1025').all() },
    migrations: { schema_version: 'a2-isolated-migrations-sample-v1', scope: 'synthetic', migrations },
    data_sample: { schema_version: 'a2-isolated-dispatch-lease-sample-v1', scope: 'synthetic', initId: marker.initId, target: marker.target,
      dispatches: db.prepare(`SELECT ${dColumns} FROM generation_dispatch ORDER BY id LIMIT 1025`).all(),
      leases: db.prepare(`SELECT ${lColumns} FROM generation_lease ORDER BY id LIMIT 1025`).all() },
  };
  for (const k of ['schema', 'migrations', 'data_sample']) require(Buffer.byteLength(canonical(result[k])) <= roles[k][1], 'fixture_capacity_exceeded');
  return result;
}
/** Fixed private metadata gate before old readers, whose other-connection full snapshot limitation remains. */
function fixturePreflight(root) {
  const before = physical(root);
  const markerFile = fileBytes(join(root, 'isolation.json'), 16384), marker = parsed(markerSchema, json(markerFile.bytes));
  const writerFile = fileBytes(join(root, 'writers-isolation.json'), 16384);
  require(writerFile.bytes.toString('utf8') === canonical({ schema: 'a3-writers-isolation-v1', marker }) && marker.target.dataPath === root, 'fixture_marker_mismatch');
  let facts;
  for (const [name, kind] of [['ledger.sqlite', 'ledger'], ['writers.sqlite', 'writers'], ['fixture-business.sqlite', 'business']]) {
    physical(root); // Hot-journal physical gate BEFORE constructor, BEGIN, pragma or any SQL.
    const path = join(root, name), db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      db.transaction(() => {
        require(same(physical(root), before), 'fixture_changed');
        const list = db.prepare('PRAGMA database_list').all();
        require(list.length === 1 && list[0].name === 'main' && list[0].file === path && db.readonly, 'fixture_database_scope_mismatch');
        if (kind === 'business') facts = businessFacts(db, marker); else registryGate(db, kind);
      })();
    } finally { db.close(); }
  }
  require(same(physical(root), before), 'fixture_changed');
  return { marker, markerStamp: markerFile.stamp, writerStamp: writerFile.stamp, physical: before, facts };
}
function utc(value) { const n = Date.parse(value); require(Number.isFinite(n) && new Date(n).toISOString() === value, 'invalid_receipt_time'); return n; }
function artifactsRead(artifactRoot, input, facts, now) {
  rootCheck(artifactRoot); const directory = safe(artifactRoot, true), rootIdentity = { dev: directory.dev, ino: directory.ino }; const batch = { remaining: 4 * MiB }, summaries = {}, files = [], absent = [];
  for (const [role, [name, cap]] of Object.entries(roles)) {
    const descriptor = input.artifacts[role], evidence = input.a2.evidence[role];
    if (!descriptor) { require(optional.has(role) && !evidence, 'missing_artifact');
      try { lstatSync(join(artifactRoot, name)); throw new ConsumerError('receipt_presence_mismatch'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      absent.push(join(artifactRoot, name));
      summaries[role] = { missing: true, bytes_bound: false, authenticated: false }; continue; }
    if (optional.has(role)) require(evidence !== undefined, 'receipt_presence_mismatch');
    const path = join(artifactRoot, name), file = fileBytes(path, cap, batch), actualHash = hash(file.bytes);
    require(file.bytes.length === descriptor.size && actualHash === descriptor.sha256, 'artifact_byte_mismatch');
    if (['schema', 'migrations', 'data_sample', 'configuration'].includes(role)) require(actualHash === input.a2.context[role + '_sha256'], 'artifact_context_mismatch');
    if (['schema', 'migrations', 'data_sample'].includes(role)) require(file.bytes.toString('utf8') === canonical(facts[role]), 'artifact_native_mismatch');
    if (role === 'configuration') {
      const config = json(file.bytes);
      parsed(z.strictObject({ schema_version: z.literal('a2-isolated-configuration-v1'), scope: z.literal('synthetic'), values: z.record(z.string().max(128), z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()])) }), config);
    }
    if (role === 'compose') require(actualHash === input.a2.context.release.compose_sha256, 'compose_byte_mismatch');
    if (Object.hasOwn(clauses, role)) {
      const receipt = parsed(z.strictObject({ schema_version: z.literal('a2-owner-private-receipt-declaration-v1'), kind: z.literal(role), claim: claimSchemas[role].omit({ receipt_sha256: true }) }), json(file.bytes));
      const { receipt_sha256, ...claim } = evidence;
      require(actualHash === receipt_sha256 && same(receipt.claim, claim), 'receipt_claim_mismatch');
      require(same(claim.binding, { ...input.a2.context, rollback: input.a2.rollback }), 'receipt_binding_mismatch');
      const issued = utc(claim.issued_at), expiry = utc(claim.expires_at);
      require(issued <= now && now < expiry && issued < expiry, 'receipt_not_current');
    }
    summaries[role] = { size: file.bytes.length, sha256: actualHash, missing: false, bytes_bound: true, authenticated: false };
    files.push({ path, stamp: file.stamp, cap });
  }
  return { summaries, files, absent, rootIdentity };
}
function owned(state, view, input, marker) {
  const token = input.a3.token, op = state.operations[token.operationId];
  require(input.a2.context.operation_id === token.operationId && input.a2.context.maintenance_holder === token.ownerId, 'a2_a3_mapping_mismatch');
  require(state.active === token.operationId && op && op.disposition !== 'released' && same(tokenFor(op), token)
    && same(bindingFor(op), input.a3.binding), 'a3_token_binding_mismatch');
  require(same(state.marker, marker) && same(view.marker, marker) && same(token.target, marker.target), 'a3_marker_mismatch');
  require(input.a2.phase !== 'before-writer-stop' || view.admission === 'open', 'a3_admission_phase_mismatch'); return op;
}

export function consumeA2Isolated({ root, artifactRoot, input: raw, now = Date.now() }) {
  let a2 = null, ledger, writers, source, result, failure;
  try {
    require(Number.isSafeInteger(now) && now >= 0, 'invalid_consumer_time');
    const input = parsed(envelopeSchema, raw);
    const policy = JSON.parse(readFileSync(new URL('../aws/security-release-policy.json', import.meta.url), 'utf8'));
    a2 = assessA2(input.a2, policy, now); // Actual unchanged documentary assessment; never substitutes for #435 preflight.
    const identity = Object.fromEntries(Object.keys(identitySchema.shape).map(k => [k, policy[k]]));
    require(same(input.a2.context.release, identity) && same(input.a2.rollback, identity), 'fixed_policy_identity_mismatch');
    rootCheck(artifactRoot); require(root !== artifactRoot, 'artifact_root_scope_mismatch');
    const initial = fixturePreflight(root);
    ledger = openLedger(root); fixturePreflight(root); const state = ledger.inspect();
    fixturePreflight(root); writers = openWriters(root); fixturePreflight(root); const view = writers.inspect();
    const op = owned(state, view, input, initial.marker);
    const artifacts = artifactsRead(artifactRoot, input, initial.facts, now);
    fixturePreflight(root); source = openDrainLeaseSource(root, join(root, 'fixture-business.sqlite'));
    fixturePreflight(root); const sample = source.sample(now);
    require(same(sample.source.marker, initial.marker), 'a3_lease_marker_mismatch');
    fixturePreflight(root); const lastState = ledger.inspect(); fixturePreflight(root); const lastView = writers.inspect();
    owned(lastState, lastView, input, initial.marker);
    const final = fixturePreflight(root);
    require(same(initial, final) && same(state, lastState) && same(view, lastView), 'fixture_changed');
    rootCheck(artifactRoot); const artifactDirectory = safe(artifactRoot, true);
    require(same({ dev: artifactDirectory.dev, ino: artifactDirectory.ino }, artifacts.rootIdentity), 'artifact_root_changed');
    for (const file of artifacts.files) require(same(stamp(safe(file.path, false, file.cap)), file.stamp), 'artifact_changed');
    // Absence is also a fixed-role observation: a late file/directory/link cannot retain a missing result.
    for (const path of artifacts.absent) {
      try { lstatSync(path); throw new ConsumerError('optional_artifact_appeared'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    result = { schema_version: 'a2-a3-isolated-consumer-result-v1', isolated_consumer_integrated: true, ...hold,
      binding_sha256: hash(canonical({ a2: input.a2.context, a3: input.a3 })), a2,
      modules: ['assessA2:a2-diagnostic-v1', 'openLedger:a3-ledger-v1', 'openWriters:a3-writer-admission-v1', 'openDrainLeaseSource:a3-drain-observation-v1'],
      engineering_fixture_scope: 'synthetic-current-code-only', policy_identity_scope: 'frozen447-byte-declaration-only',
      inherited_reader_capacity_atomic: false, phase_verified: false,
      a3: { state: op.state, disposition: op.disposition, admission: view.admission,
        queued: sample.queued, claimedCurrent: sample.claimedCurrent, claimedExpired: sample.claimedExpired, unknown: sample.unknown,
        registered_tasks: view.tasks.length, remote_subwork: 'unknown' }, artifacts: artifacts.summaries,
      blockers: [...a2.blockers, 'all_writer_coverage_unknown', 'ssm_termination_unknown', 'cross_connection_observation_not_atomic'],
    };
  } catch (error) { failure = error instanceof ConsumerError ? error.code : 'isolated_observation_failed'; }
  finally {
    for (const handle of [source, writers, ledger]) { try { handle?.close(); } catch { failure = 'consumer_cleanup_failed'; } }
  }
  if (failure) return { schema_version: 'a2-a3-isolated-consumer-result-v1', isolated_consumer_integrated: false, ...hold,
    a2, reason: failure, blockers: [...(a2?.blockers ?? []), failure] };
  return result;
}
export function main(args = process.argv.slice(2)) {
  let result;
  try {
    require(args.length === 3 && args[2] === 'consume-isolated', 'invalid_consumer_arguments');
    result = consumeA2Isolated({ root: args[0], artifactRoot: args[1], input: json(chunks(0, 16384)), now: Date.now() });
  } catch (error) {
    result = { schema_version: 'a2-a3-isolated-consumer-result-v1', isolated_consumer_integrated: false, ...hold,
      reason: error instanceof ConsumerError ? error.code : 'isolated_observation_failed' };
  }
  console.log(JSON.stringify(result)); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { main(); process.exitCode = 1; }

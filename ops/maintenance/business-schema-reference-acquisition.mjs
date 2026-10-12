/** One hosted source-bound acquisition, never a qualifier, consumer or golden verifier. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ database: 64 * 1024 * 1024, descriptor: 1024 * 1024, diagnostic: 2 * 1024 * 1024, childMs: 120000 });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedSources = Object.freeze({
  'src/lib/db/connection.ts': '2a745a12a4cc198ce3560ef78ccb810c669ac724109a8f0c7fea89b5ae8bd751',
  'src/lib/db/legacy-bootstrap.ts': '8cfc080429a8eddad439294594008ce4366f1e4bea22eccf48529614cd5de0ec',
  'src/lib/db/migration-runner.ts': 'f468ca2f622e4a8d0a5e7182807f2169de654493354bdec746b4f7da71af53be',
  'src/lib/db/provenance-facts.ts': 'a9d72a32944012f5945ccd73f7647630ad8e44615c82bf88cb406244cc6a902e',
  'src/lib/db/podcast-transcript-migrations.ts': '01f5b37f4f27f241597c1f144e693be949e060bcdb6dfbd2ad8b906d0d332d89',
  'src/lib/db/schema.ts': '8b83a8fc65c38c0267a0e0d45c9f2648b057205ea225dc3fa505fdd6b977e840',
  'src/lib/db/migration-definitions.ts': '05e411380c333df9975914c3e1916467acb1180270de741cf3d0a19de23afc07',
  'src/lib/db/integrity-anchors.ts': '879f5c7948a22556fb516b39934126a005d9ca7521deca9df1bbc33e3084e060',
  'src/lib/db/redaction.ts': '186ff0ce0e02ce217668287f941c60468ae97702f199a9598a96ff88fb3fe3af',
  'package-lock.json': '63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2'
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quoted = name => '"' + name.replaceAll('"', '""') + '"';
const textOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function sourceIdentity() {
  return Object.entries(expectedSources).map(([path, expected]) => {
    const bytes = readFileSync(join(repo, path));
    assert.equal(sha(bytes), expected, 'reference_source_drift:' + path);
    return { path, bytes: bytes.length, sha256: expected };
  });
}
function identity(path, directory = false) {
  const st = lstatSync(path);
  assert.equal(st.isSymbolicLink(), false, 'reference_symlink');
  assert.ok(directory ? st.isDirectory() : st.isFile(), 'reference_file_kind');
  assert.equal(st.uid, process.getuid(), 'reference_uid');
  assert.equal(st.mode & 0o777, directory ? 0o700 : 0o600, 'reference_mode');
  if (!directory) assert.equal(st.nlink, 1, 'reference_hardlink');
  assert.equal(realpathSync(path), path, 'reference_realpath');
  return { path, dev: String(st.dev), ino: String(st.ino), uid: st.uid, mode: st.mode & 0o777 };
}
function filesWithinBudget(root, target) {
  const allowed = [target, target + '-wal', target + '-shm', target + '-journal'];
  assert.ok(readdirSync(root).every(n => allowed.includes(join(root, n))), 'reference_extra_file');
  let bytes = 0;
  for (const p of allowed) if (existsSync(p)) {
    const st = lstatSync(p);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid() && st.nlink === 1, 'reference_sidecar_identity');
    chmodSync(p, 0o600); bytes += st.size;
  }
  assert.ok(bytes <= LIMITS.database, 'reference_database_budget');
  return bytes;
}
function errorRecord(error) {
  return { name: error instanceof Error ? error.name.slice(0,256) : 'unknown', code: typeof error?.code === 'string' ? error.code.slice(0,256) : null,
    message: String(error instanceof Error ? error.message : error).slice(0, 4096) };
}

export async function acquireBusinessReference(root) {
  const result = { schema: 'business-schema-reference-acquisition-v1', status: 'PARTIAL', qualification: false,
    expected_native_descriptor_sha256: null, base: '366be0e902520b392a1fee7422160ce0159b1637', effects: [], secondary: [] };
  let db, rootIdentity, targetIdentity, rootValidated = false;
  const target = join(root, 'd2-business.sqlite');
  try {
    assert.equal(process.platform, 'linux', 'reference_hosted_linux_required');
    assert.equal(process.env.CI, 'true', 'reference_hosted_ci_required');
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'reference_hosted_actions_required');
    assert.equal(process.env.NODE_ENV, 'test', 'reference_nonproduction_required');
    assert.equal(dirname(root), realpathSync(tmpdir()), 'reference_tmp_parent');
    assert.ok(basename(root).startsWith('business-reference-'), 'reference_root_prefix');
    rootIdentity = identity(root, true);
    assert.deepEqual(readdirSync(root), [], 'reference_root_not_empty');
    rootValidated = true;
    process.umask(0o077);
    result.setupUmask = '0077';
    result.sources = sourceIdentity();
    const [{ openConnection }, { bootstrapLegacySchema }, { applyProvenanceMigrations }, { initializeProvenanceMeta }, { MIGRATIONS }] = await Promise.all([
      import('../../src/lib/db/connection.ts'), import('../../src/lib/db/legacy-bootstrap.ts'),
      import('../../src/lib/db/migration-runner.ts'), import('../../src/lib/db/provenance-facts.ts'),
      import('../../src/lib/db/migration-definitions.ts')
    ]);
    assert.equal(MIGRATIONS.length, 48, 'reference_migration_count');
    assert.equal(MIGRATIONS.at(-1).version, '20261004_48_model_usage_attempt', 'reference_latest_migration');
    const mark = phase => result.effects.push({ phase, observedAt: new Date().toISOString(), databaseBytes: filesWithinBudget(root, target) });
    assert.equal(existsSync(target), false, 'reference_target_exists');
    db = openConnection(target); mark('connection_returned');
    assert.ok(db.open && !db.inTransaction && db.name === target, 'reference_original_handle');
    targetIdentity = identity(target); result.originalHandle = { databasePath: db.name, openBefore: db.open, root: rootIdentity, target: targetIdentity };
    bootstrapLegacySchema(db, true); mark('bootstrap_returned');
    applyProvenanceMigrations(db); mark('migrations_returned');
    initializeProvenanceMeta(db); mark('meta_returned');
    assert.equal(db.inTransaction, false, 'reference_outer_transaction');
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(checkpoint.length, 1, 'reference_checkpoint_shape');
    assert.equal(checkpoint[0].busy, 0, 'reference_checkpoint_busy');
    assert.equal(checkpoint[0].log, checkpoint[0].checkpointed, 'reference_checkpoint_incomplete');
    assert.equal(db.pragma('journal_mode = DELETE', { simple: true }), 'delete', 'reference_delete_conversion');
    mark('checkpoint_delete_returned');
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(target + suffix), false, 'reference_sidecar_remains');
    const catalog = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name,tbl_name').all();
    const tableList = db.pragma('table_list').sort((a,b) => textOrder(a.schema,b.schema) || textOrder(a.name,b.name));
    const pragmas = Object.fromEntries(['application_id','user_version','synchronous','busy_timeout','foreign_keys','journal_mode'].map(name => [name, db.pragma(name, { simple: true })]));
    const integrity = db.pragma('integrity_check');
    assert.deepEqual(integrity, [{ integrity_check: 'ok' }], 'reference_integrity');
    const tables = catalog.filter(r => r.type === 'table').map(r => ({ name: r.name,
      columns: db.pragma('table_xinfo(' + quoted(r.name) + ')'),
      foreignKeys: db.pragma('foreign_key_list(' + quoted(r.name) + ')'),
      indices: db.pragma('index_list(' + quoted(r.name) + ')') }));
    const indices = catalog.filter(r => r.type === 'index').map(r => ({ name: r.name, columns: db.pragma('index_xinfo(' + quoted(r.name) + ')') }));
    const ledger = db.prepare('SELECT version,checksum,applied_at FROM schema_migration ORDER BY version').all();
    const expectedLedger = MIGRATIONS.map(m => ({ version: m.version, checksum: sha(m.sql) })).sort((a, b) => textOrder(a.version, b.version));
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })), expectedLedger, 'reference_ledger_source_mismatch');
    for (const name of ['run', 'generation_trace', 'generation_dispatch', 'generation_lease', 'model_usage_attempt', 'provenance_meta', 'schema_migration'])
      assert.ok(tables.some(t => t.name === name), 'reference_required_table:' + name);
    const usage = tables.find(t => t.name === 'model_usage_attempt');
    for (const name of ['attempt_id','logical_call_id','attempt_number','run_id','trace_id','role','provider','model','started_at'])
      assert.ok(usage.columns.some(c => c.name === name), 'reference_usage_identity:' + name);
    assert.equal(usage.columns.find(c => c.name === 'trace_id').notnull, 0, 'reference_nullable_trace');
    assert.equal(db.pragma('foreign_key_check').length, 0, 'reference_foreign_keys');
    const databases = db.pragma('database_list'); assert.deepEqual(databases.map(d => ({ name: d.name, file: d.file })), [{ name: 'main', file: target }]);
    const stable = { normalization: 'business-native-observation-v1',
      exclusions: ['catalog.rootpage', 'ledger.applied_at', 'runtime/physical paths/timestamps'],
      catalog: catalog.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql })),
      tables: tables.map(t => ({ ...t, foreignKeys: [...t.foreignKeys].sort((a,b) => a.id-b.id || a.seq-b.seq), indices: [...t.indices].sort((a,b) => textOrder(a.name, b.name)) })),
      indices, tableList, pragmas, integrity, ledger: expectedLedger };
    result.raw = { catalog, tables, indices, tableList, pragmas, integrity, ledger, databases, checkpoint, meta: db.prepare('SELECT * FROM provenance_meta ORDER BY meta_key').all() };
    result.stable = stable; result.observed_native_descriptor_sha256 = sha(JSON.stringify(stable));
    result.semanticExpectations = { source: 'immutable source manifest plus MIGRATIONS SQL; not independent accepted native golden', expectedLedger,
      nullableTracePreserved: true, businessRelationQualified: false, golden: 'UNKNOWN' };
    result.runtime = { node: process.version, versions: process.versions, sqlite: db.prepare('SELECT sqlite_version() version').get().version,
      platform: process.platform, arch: process.arch, pid: process.pid,
      run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, tested: process.env.GITHUB_SHA ?? null,
      loader: { execArgv: process.execArgv, tsxEntry: import.meta.resolve('tsx'), cacheDisabled: process.env.TSX_DISABLE_CACHE === '1',
        lockedVersions: Object.fromEntries(['tsx','better-sqlite3','@aws-sdk/client-s3'].map(name => [name, JSON.parse(readFileSync(join(repo,'package-lock.json'))).packages['node_modules/'+name]?.version ?? null])) },
      foreignKeys: db.pragma('foreign_keys', { simple: true }), journal: db.pragma('journal_mode', { simple: true }) };
    assert.deepEqual(identity(root, true), rootIdentity); assert.deepEqual(identity(target), targetIdentity);
    assert.deepEqual(sourceIdentity(), result.sources); mark('descriptor_acquired'); result.status = 'ACQUIRED';
  } catch (error) { result.primary = errorRecord(error); }
  finally {
    if (db?.open) { try { db.close(); } catch (error) { result.secondary.push(errorRecord(error)); } }
    result.databaseClose = { existed: !!db, openAfter: db?.open ?? null };
    if (rootValidated) {
      try { result.residualFiles = readdirSync(root).map(name => { const s = lstatSync(join(root,name)); return {name,size:s.size,uid:s.uid,mode:s.mode&0o777,symlink:s.isSymbolicLink()}; }); }
      catch (error) { result.secondary.push(errorRecord(error)); }
    }
    if (db?.open || result.secondary.length) result.status = 'PARTIAL';
  }
  let bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > LIMITS.descriptor) bytes = Buffer.from(JSON.stringify({ schema: result.schema, status: 'PARTIAL', qualification: false,
    complete: false, primary: result.primary ?? null, secondary: result.secondary,
    budgetDiagnostic: { code: 'reference_descriptor_budget', bytes: bytes.length, omittedDescriptorSHA256: sha(bytes) },
    effects: result.effects, sources: result.sources, databaseClose: result.databaseClose, residualFiles: result.residualFiles }));
  return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('reference_fixed_argv');
  const bytes = await acquireBusinessReference(process.argv[2]);
  process.stdout.write(bytes);
  if (JSON.parse(bytes).status !== 'ACQUIRED') process.exitCode = 1;
}

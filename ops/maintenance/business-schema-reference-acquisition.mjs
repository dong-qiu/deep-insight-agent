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
  return { path, dev: String(st.dev), ino: String(st.ino), uid: st.uid, mode: st.mode & 0o777, nlink: st.nlink };
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

function assertNamespaceRows(databases, target) {
  assert.ok(Array.isArray(databases) && databases.length >= 1 && databases.length <= 2, 'reference_namespace_count');
  const names = new Set(), sequences = new Set();
  for (const row of databases) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'reference_namespace_row');
    assert.deepEqual(Object.keys(row).sort(), ['file','name','seq'], 'reference_namespace_fields');
    assert.ok(Number.isSafeInteger(row.seq) && row.seq >= 0 && !sequences.has(row.seq), 'reference_namespace_sequence');
    assert.ok((row.name === 'main' || row.name === 'temp') && !names.has(row.name), 'reference_namespace_name');
    assert.equal(row.file, row.name === 'main' ? target : '', 'reference_namespace_file');
    names.add(row.name); sequences.add(row.seq);
  }
  assert.ok(names.has('main'), 'reference_main_absent');
  return names.has('temp');
}

/** Test-private fixed observation predicate; no SQL, capability or qualification is granted. */
export function assertReferenceNamespace({ databases, tableList, tempCatalog }, target) {
  const hasTemp = assertNamespaceRows(databases, target);
  assert.ok(Array.isArray(tableList), 'reference_table_list_shape');
  for (const row of tableList) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row) && (row.schema === 'main' || row.schema === 'temp'), 'reference_table_list_schema');
    assert.ok(typeof row.name === 'string' && row.name.length > 0 && ['table','view','shadow','virtual'].includes(row.type), 'reference_table_list_identity');
    assert.ok(Number.isSafeInteger(row.ncol) && row.ncol >= 0 && [0,1].includes(row.wr) && [0,1].includes(row.strict), 'reference_table_list_flags');
  }
  assert.ok(tableList.some(row => row.schema === 'main'), 'reference_main_table_list_absent');
  const tempRows = tableList.filter(row => row.schema === 'temp');
  if (hasTemp) {
    assert.ok(Array.isArray(tempCatalog) && tempCatalog.length === 0, 'reference_temp_objects');
    assert.deepEqual(tempRows, [{ schema: 'temp', name: 'sqlite_temp_schema', type: 'table', ncol: 5, wr: 0, strict: 0 }], 'reference_builtin_temp_representation');
  } else {
    assert.deepEqual(tempRows, [], 'reference_unlisted_temp');
    assert.equal(tempCatalog, null, 'reference_unlisted_temp_catalog');
  }
  return { builtinTemp: hasTemp ? 'verified-empty-v1' : 'not-present', qualification: false };
}

export async function acquireBusinessReference(root) {
  const result = { schema: 'business-schema-reference-acquisition-v1', status: 'PARTIAL', qualification: false,
    expected_native_descriptor_sha256: null, base: '366be0e902520b392a1fee7422160ce0159b1637', effects: [], secondary: [], raw: { namespaceSnapshots: [] } };
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
    const checkpoint = result.raw.checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(checkpoint.length, 1, 'reference_checkpoint_shape');
    assert.equal(checkpoint[0].busy, 0, 'reference_checkpoint_busy');
    assert.equal(checkpoint[0].log, checkpoint[0].checkpointed, 'reference_checkpoint_incomplete');
    result.raw.journalConversion = db.pragma('journal_mode = DELETE', { simple: true });
    assert.equal(result.raw.journalConversion, 'delete', 'reference_delete_conversion');
    mark('checkpoint_delete_returned');
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(target + suffix), false, 'reference_sidecar_remains');
    result.runtime = { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch, pid: process.pid,
      run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, tested: process.env.GITHUB_SHA ?? null };
    result.raw.sqliteVersion = db.prepare('SELECT sqlite_version() version').get();
    result.runtime.sqlite = result.raw.sqliteVersion.version;
    result.raw.sqliteSourceId = db.prepare('SELECT sqlite_source_id() source_id').get();
    result.runtime.sqliteSourceId = result.raw.sqliteSourceId.source_id;
    result.raw.resources = { scope: 'owned-root-only', allTempDiskHeapQualification: 'UNKNOWN' };
    result.raw.resources.tempStore = db.pragma('temp_store', { simple: true });
    result.raw.resources.compileOptions = db.pragma('compile_options');
    result.runtime.loader = { execArgv: process.execArgv, cacheDisabled: process.env.TSX_DISABLE_CACHE === '1' };
    result.runtime.loader.tsxEntry = import.meta.resolve('tsx');
    const lock = JSON.parse(readFileSync(join(repo,'package-lock.json')));
    result.runtime.loader.lockedVersions = {};
    for (const name of ['tsx','better-sqlite3','@aws-sdk/client-s3']) result.runtime.loader.lockedVersions[name] = lock.packages['node_modules/'+name]?.version ?? null;
    const inspect = phase => {
      assert.ok(db.open && !db.inTransaction && db.name === target, 'reference_original_handle');
      assert.deepEqual(identity(root, true), rootIdentity); assert.deepEqual(identity(target), targetIdentity);
      const snapshot = { phase }; result.raw.namespaceSnapshots.push(snapshot);
      snapshot.before = db.pragma('database_list'); assertNamespaceRows(snapshot.before, target);
      snapshot.tableList = db.pragma('table_list');
      snapshot.after = db.pragma('database_list');
      const hasTemp = assertNamespaceRows(snapshot.after, target);
      snapshot.tempCatalog = hasTemp ? db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM temp.sqlite_schema ORDER BY type,name,tbl_name').all() : null;
      result.raw.databases = snapshot.after; result.raw.tableList = snapshot.tableList; result.raw.tempCatalog = snapshot.tempCatalog;
      snapshot.verdict = assertReferenceNamespace({ databases: snapshot.after, tableList: snapshot.tableList, tempCatalog: snapshot.tempCatalog }, target);
    };
    inspect('before_business_descriptor');
    const catalog = result.raw.catalog = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name').all();
    const pragmas = result.raw.pragmas = {};
    for (const name of ['application_id','user_version','synchronous','busy_timeout','foreign_keys','journal_mode']) pragmas[name] = db.pragma('main.' + name, { simple: true });
    const integrity = result.raw.integrity = db.pragma('main.integrity_check');
    assert.deepEqual(integrity, [{ integrity_check: 'ok' }], 'reference_integrity');
    inspect('after_integrity');
    const tables = result.raw.tables = [];
    for (const row of catalog.filter(r => r.type === 'table')) {
      const table = { name: row.name }; tables.push(table);
      table.columns = db.pragma('main.table_xinfo(' + quoted(row.name) + ')');
      table.foreignKeys = db.pragma('main.foreign_key_list(' + quoted(row.name) + ')');
      table.indices = db.pragma('main.index_list(' + quoted(row.name) + ')');
    }
    const indices = result.raw.indices = [];
    for (const row of catalog.filter(r => r.type === 'index')) {
      const index = { name: row.name }; indices.push(index); index.columns = db.pragma('main.index_xinfo(' + quoted(row.name) + ')');
    }
    const ledger = result.raw.ledger = db.prepare('SELECT version,checksum,applied_at FROM main.schema_migration ORDER BY version').all();
    const expectedLedger = MIGRATIONS.map(m => ({ version: m.version, checksum: sha(m.sql) })).sort((a, b) => textOrder(a.version, b.version));
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })), expectedLedger, 'reference_ledger_source_mismatch');
    for (const name of ['run', 'generation_trace', 'generation_dispatch', 'generation_lease', 'model_usage_attempt', 'provenance_meta', 'schema_migration'])
      assert.ok(tables.some(t => t.name === name), 'reference_required_table:' + name);
    const usage = tables.find(t => t.name === 'model_usage_attempt');
    for (const name of ['attempt_id','logical_call_id','attempt_number','run_id','trace_id','role','provider','model','started_at'])
      assert.ok(usage.columns.some(c => c.name === name), 'reference_usage_identity:' + name);
    assert.equal(usage.columns.find(c => c.name === 'trace_id').notnull, 0, 'reference_nullable_trace');
    result.raw.foreignKeyCheck = db.pragma('main.foreign_key_check');
    assert.equal(result.raw.foreignKeyCheck.length, 0, 'reference_foreign_keys');
    result.raw.meta = db.prepare('SELECT * FROM main.provenance_meta ORDER BY meta_key').all();
    inspect('before_complete');
    const tableList = result.raw.tableList.filter(r => r.schema === 'main').sort((a,b) => textOrder(a.name,b.name));
    const stable = { normalization: 'business-main-native-observation-v2',
      exclusions: ['catalog.rootpage', 'ledger.applied_at', 'runtime/physical paths/timestamps', 'recognized builtin temp metadata: raw remains complete'],
      catalog: catalog.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql })),
      tables: tables.map(t => ({ ...t, foreignKeys: [...t.foreignKeys].sort((a,b) => a.id-b.id || a.seq-b.seq), indices: [...t.indices].sort((a,b) => textOrder(a.name, b.name)) })),
      indices, tableList, pragmas, integrity, ledger: expectedLedger };
    result.stable = stable; result.observed_native_descriptor_sha256 = sha(JSON.stringify(stable));
    result.semanticExpectations = { source: 'immutable source manifest plus MIGRATIONS SQL; not independent accepted native golden', expectedLedger,
      nullableTracePreserved: true, businessRelationQualified: false, golden: 'UNKNOWN' };
    result.runtime.foreignKeys = pragmas.foreign_keys; result.runtime.journal = pragmas.journal_mode;
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

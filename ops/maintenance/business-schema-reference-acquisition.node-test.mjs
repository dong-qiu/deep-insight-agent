import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LIMITS, assertReferenceNamespace } from './business-schema-reference-acquisition.mjs';

// Data-only future negative definitions. No runner, SQL execution or path authority exists here.
const negativeFixtureProposals = Object.freeze([
  { id: 'N1', effects: ["CREATE TEMP TABLE schema_migration(version TEXT)", "CREATE TEMP VIEW namespace_probe_view AS SELECT version FROM temp.schema_migration", "CREATE INDEX temp.namespace_probe_index ON schema_migration(version)", "CREATE TEMP TRIGGER namespace_probe_trigger AFTER INSERT ON schema_migration BEGIN SELECT 1; END"], executionAuthorized: false },
  { id: 'N2', effects: ["ATTACH ':memory:' AS aux"], executionAuthorized: false },
  { id: 'N3', effects: ['ATTACH ? AS aux'], missingGate: 'master must freeze the sole absent owned aux file binding/target and aggregate budget', executionAuthorized: false },
  { id: 'N4', effects: ['wrong expected main physical identity'], executionAuthorized: false }
]);

test('namespace predicate accepts only original main and explicitly verified empty builtin temp', () => {
  const target = '/isolated-namespace-shape/d2-business.sqlite';
  const main = { seq: 0, name: 'main', file: target }, temp = { seq: 1, name: 'temp', file: '' };
  const builtin = { schema: 'temp', name: 'sqlite_temp_schema', type: 'table', ncol: 5, wr: 0, strict: 0 };
  const mainMetadata = { schema: 'main', name: 'sqlite_schema', type: 'table', ncol: 5, wr: 0, strict: 0 };
  const mainOnly = { databases: [main], tableList: [mainMetadata], tempCatalog: null };
  const emptyTemp = { databases: [main,temp], tableList: [mainMetadata,builtin], tempCatalog: [] };
  assert.deepEqual(assertReferenceNamespace(mainOnly,target), { builtinTemp: 'not-present', qualification: false });
  assert.deepEqual(assertReferenceNamespace(emptyTemp,target), { builtinTemp: 'verified-empty-v1', qualification: false });
  const invalid = [
    { ...emptyTemp, databases: [main,{ seq: 1, name: 'aux', file: '' }] },
    { ...emptyTemp, databases: [main,{ seq: 1, name: 'aux', file: '/isolated-namespace-shape/aux.sqlite' }] },
    { ...mainOnly, databases: [{ ...main, file: '/wrong-main.sqlite' }] },
    { ...mainOnly, databases: [temp] }, { ...mainOnly, databases: [main,main] },
    { ...mainOnly, databases: [{ ...main, seq: '0' }] }, { ...mainOnly, databases: [{ ...main, extra: true }] },
    { ...emptyTemp, databases: [main,{ ...temp, seq: 0 }] }, { ...emptyTemp, databases: [main,{ ...temp, file: '/temp.sqlite' }] },
    { ...emptyTemp, tableList: [mainMetadata,{ ...builtin, name: 'unknown_alias' }] },
    { ...emptyTemp, tableList: [mainMetadata,{ ...builtin, extra: true }] }, { ...emptyTemp, tableList: [mainMetadata,builtin,builtin] },
    { ...emptyTemp, tableList: [mainMetadata,{ ...builtin, schema: 'aux' }] }, { ...emptyTemp, tableList: null },
    { ...mainOnly, tableList: [mainMetadata,builtin] }, { ...mainOnly, tempCatalog: [] },
    { ...mainOnly, tableList: [] }, { ...emptyTemp, tempCatalog: null },
    { ...mainOnly, tableList: [{ ...mainMetadata, ncol: '5' }] }, { ...mainOnly, tableList: [{ ...mainMetadata, wr: true }] },
    ...['table','index','view','trigger'].map(type => ({ ...emptyTemp, tempCatalog: [{ type, name: 'shadow', tbl_name: 'schema_migration', rootpage: 0, sql: null }] }))
  ];
  for (const facts of invalid) {
    const original = JSON.stringify(facts); assert.throws(() => assertReferenceNamespace(facts,target));
    assert.equal(JSON.stringify(facts), original, 'rejection must not filter or erase supplied raw facts');
  }
  assert.deepEqual(negativeFixtureProposals.map(p => p.id), ['N1','N2','N3','N4']);
  assert.ok(negativeFixtureProposals.every(p => p.executionAuthorized === false));
});

function retainedByteLabel(counts, retained) {
  return { receivedBytesRetained: counts.stdout === retained.stdout && counts.stderr === retained.stderr };
}

test('retained-byte serialization never asserts original stream completeness', () => {
  const equal = { stdout: 8, stderr: 2 };
  const cases = [
    { name: 'pipe-error', counts: equal, retained: equal, actualClose: true, first: 'reference_stdout_error:EIO', expected: true },
    { name: 'close-unknown', counts: equal, retained: equal, actualClose: false, first: 'reference_child_close_unknown', expected: true },
    { name: 'truncated-prefix', counts: equal, retained: { stdout: 7, stderr: 2 }, actualClose: true, first: 'reference_stdout_budget', expected: false },
    { name: 'clean-known-close', counts: equal, retained: equal, actualClose: true, first: null, expected: true }
  ];
  for (const example of cases) {
    const record = JSON.parse(JSON.stringify({ counts: example.counts, retained: example.retained,
      actualClose: example.actualClose, first: example.first, ...retainedByteLabel(example.counts, example.retained) }));
    assert.equal(record.receivedBytesRetained, example.expected, example.name);
    assert.equal(Object.hasOwn(record, 'complete'), false, example.name);
    assert.equal(Object.hasOwn(record, 'originalStreamComplete'), false, example.name);
    assert.equal(record.actualClose, example.actualClose, example.name);
    assert.equal(record.first, example.first, example.name);
    assert.deepEqual(record.counts, example.counts); assert.deepEqual(record.retained, example.retained);
  }
});

test('one hosted real business reference acquisition preserves complete raw source-bound facts, not qualification', async t => {
  assert.equal(process.env.CI, 'true', 'reference_hosted_gate');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'reference_hosted_gate');
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'business-reference-'))); chmodSync(root, 0o700);
  t.diagnostic('preserved acquisition-only root ' + root);
  const env = { PATH: process.env.PATH, CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test',
    TSX_DISABLE_CACHE: '1', AWS_EC2_METADATA_DISABLED: 'true' };
  for (const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA']) if (process.env[key]) env[key] = process.env[key];
  const entry = fileURLToPath(new URL('./business-schema-reference-acquisition.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', entry, root], { env, stdio: ['ignore','pipe','pipe'] });
  // Aggregate retained input <=1.25MiB leaves room for base64 framing below 2MiB.
  const bounds = { stdout: LIMITS.descriptor, stderr: 256 * 1024 };
  const buffers = { stdout: [], stderr: [] }, counts = { stdout: 0, stderr: 0 }, retained = { stdout: 0, stderr: 0 };
  const receivedHashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }, secondary = [];
  let first = null, exit = null, close = null, killTimer, closeDeadline;
  function stop(reason) {
    reason = reason.slice(0,4096);
    if (!first) first = reason; else if (secondary.length < 32) secondary.push(reason);
    if (close || exit) return;
    try { child.kill('SIGTERM'); } catch (error) { first ??= String(error); }
    if (!killTimer) killTimer = setTimeout(() => { if (!close && !exit) { try { child.kill('SIGKILL'); } catch (error) { first ??= String(error); } } }, 500);
  }
  const deadline = setTimeout(() => stop('reference_child_deadline'), LIMITS.childMs);
  const resources = setInterval(() => {
    try {
      let size = 0;
      const target = 'd2-business.sqlite', sidecars = [target+'-wal', target+'-shm', target+'-journal'];
      for (const name of readdirSync(root)) {
        assert.ok(name === target || sidecars.includes(name), 'reference_extra_file');
        let s;
        try { s = lstatSync(join(root,name)); }
        catch (error) { if (error.code === 'ENOENT' && sidecars.includes(name)) continue; throw error; }
        assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && s.nlink === 1 && (s.mode & 0o777) === 0o600, 'reference_resource_identity'); size += s.size;
      }
      if (size > LIMITS.database) stop('reference_database_budget');
    } catch (error) { stop('reference_resource_identity:' + error.message); }
  }, 100);
  for (const key of ['stdout','stderr']) {
    child[key].on('error', error => stop('reference_' + key + '_error:' + error.message));
    child[key].on('data', bytes => {
      counts[key] += bytes.length; receivedHashes[key].update(bytes);
      const prefix = bytes.subarray(0, Math.max(0, bounds[key] - retained[key]));
      if (prefix.length) { buffers[key].push(prefix); retained[key] += prefix.length; }
      if (counts[key] > bounds[key]) stop('reference_' + key + '_budget');
    });
  }
  child.on('error', error => stop('reference_spawn:' + error.message));
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  const actualClose = await new Promise(resolve => {
    child.on('close', (code, signal) => { close = { code, signal }; resolve(true); });
    closeDeadline = setTimeout(() => {
      stop('reference_child_close_unknown'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); resolve(false);
    }, LIMITS.childMs + 2500);
  });
  clearTimeout(deadline); clearInterval(resources); clearTimeout(killTimer); clearTimeout(closeDeadline);
  const bytes = Buffer.concat(buffers.stdout), stderr = Buffer.concat(buffers.stderr);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const frames = [];
  for (const [stream, raw] of [['stdout',bytes],['stderr',stderr]]) {
    const chunks = raw.toString('base64').match(/.{1,4096}/g) ?? [];
    const streamDigest = createHash('sha256').update(raw).digest('hex');
    for (const [index,data] of chunks.entries()) frames.push(JSON.stringify({schema:'business-reference-raw-chunk-v1',stream,digest:streamDigest,index,count:chunks.length,data}));
  }
  const terminalRecord = { schema: 'business-reference-child-close-v1', root, exit, close, actualClose, first, secondary, counts, retained,
    ...retainedByteLabel(counts, retained),
    receivedSHA256: Object.fromEntries(Object.entries(receivedHashes).map(([key,hash]) => [key,hash.digest('hex')])),
    bytes: bytes.length, digest, stderrBytes: stderr.length, stderrSHA256: createHash('sha256').update(stderr).digest('hex') };
  // Reserve 256KiB for bounded first/secondary/terminal metadata; emit a prefix even on framing failure.
  let emitted = 0, emittedFrames = 0;
  for (const frame of frames) {
    if (emitted + Buffer.byteLength(frame) + 1 > LIMITS.diagnostic - 256*1024) break;
    t.diagnostic(frame); emitted += Buffer.byteLength(frame) + 1; emittedFrames++;
  }
  const terminal = JSON.stringify({ ...terminalRecord, emittedFrames, totalFrames: frames.length, framesComplete: emittedFrames === frames.length });
  t.diagnostic(terminal);
  if (emittedFrames !== frames.length || emitted + Buffer.byteLength(terminal) > LIMITS.diagnostic) assert.fail('reference_diagnostic_frame_budget: incomplete raw prefix, no complete evidence claim');
  assert.equal(first, null); assert.equal(actualClose,true); assert.deepEqual(exit, { code: 0, signal: null }); assert.deepEqual(close, exit);
  assert.ok(bytes.length > 0 && counts.stdout === bytes.length, 'reference_complete_stdout');
  const data = JSON.parse(bytes);
  assert.equal(data.status, 'ACQUIRED', JSON.stringify(data.primary));
  assert.equal(data.qualification, false); assert.equal(data.expected_native_descriptor_sha256, null);
  assert.ok(data.raw.catalog.length > 7); assert.equal(data.raw.ledger.length, 48);
  assert.ok(data.raw.namespaceSnapshots.length === 3);
  for (const snapshot of data.raw.namespaceSnapshots) {
    assertReferenceNamespace({ databases: snapshot.after, tableList: snapshot.tableList, tempCatalog: snapshot.tempCatalog }, data.originalHandle.target.path);
  }
  assert.ok(data.raw.databases.some(d => d.name === 'main' && d.file === data.originalHandle.target.path));
  assert.equal(data.originalHandle.target.nlink, 1);
  assert.equal(data.raw.resources.scope, 'owned-root-only'); assert.equal(data.raw.resources.allTempDiskHeapQualification, 'UNKNOWN');
  assert.ok(Number.isInteger(data.raw.resources.tempStore) && Array.isArray(data.raw.resources.compileOptions));
  assert.equal(typeof data.raw.sqliteVersion.version, 'string');
  assert.equal(data.runtime.sqlite, data.raw.sqliteVersion.version);
  assert.equal(typeof data.raw.sqliteSourceId.source_id, 'string');
  assert.equal(data.runtime.sqliteSourceId, data.raw.sqliteSourceId.source_id);
  assert.equal(data.stable.normalization, 'business-main-native-observation-v2');
  assert.ok(data.stable.tableList.every(row => row.schema === 'main'));
  assert.equal(data.databaseClose.existed, true); assert.equal(data.databaseClose.openAfter, false);
  assert.equal(data.originalHandle.target.path, join(root,'d2-business.sqlite'));
  assert.equal(data.semanticExpectations.golden, 'UNKNOWN');
  assert.ok(data.effects.some(e => e.phase === 'checkpoint_delete_returned'));
  for (const suffix of ['-wal','-shm','-journal']) assert.equal(existsSync(join(root,'d2-business.sqlite')+suffix), false);
  assert.deepEqual(readdirSync(root), ['d2-business.sqlite']);
});

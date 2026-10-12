import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './business-schema-reference-acquisition.mjs';

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
  assert.equal(data.databaseClose.existed, true); assert.equal(data.databaseClose.openAfter, false);
  assert.equal(data.originalHandle.target.path, join(root,'d2-business.sqlite'));
  assert.equal(data.semanticExpectations.golden, 'UNKNOWN');
  assert.ok(data.effects.some(e => e.phase === 'checkpoint_delete_returned'));
  for (const suffix of ['-wal','-shm','-journal']) assert.equal(existsSync(join(root,'d2-business.sqlite')+suffix), false);
  assert.deepEqual(readdirSync(root), ['d2-business.sqlite']);
});

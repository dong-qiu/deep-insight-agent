/** Real production worker; controlled local HTTP and SIGTERM, no DB/provider/production service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function waitForFixture(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(new Error('controlled_fixture_aborted')); };
    void promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}

test('SIGTERM drains the real worker without aborting its request or claiming more work', { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ia-c2a-drain-'));
  const marker = join(root, 'draining');
  let requests = 0;
  let respond;
  let received;
  const requestStarted = new Promise((resolve) => { received = resolve; });
  const server = createServer((req, res) => {
    requests++;
    respond = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"claimed":true}'); };
    received({ req, res });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-dispatch-worker.mjs', import.meta.url))], {
    // An explicit environment prevents ambient production endpoints/secrets/config from being used.
    env: { APP_URL: `http://127.0.0.1:${address.port}`, DISPATCH_WORKER_SECRET: 'synthetic-test-secret', DISPATCH_DRAIN_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  void exited.catch(() => undefined);
  let output = '';
  let draining;
  const drainObserved = new Promise((resolve) => { draining = resolve; });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.includes('received; draining')) draining(); });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  try {
    const { req, res } = await waitForFixture(requestStarted, t.signal);
    assert.equal(req.url, '/api/internal/generation-dispatch');
    assert.equal(req.headers['x-dispatch-worker-secret'], 'synthetic-test-secret');
    assert.equal(child.kill('SIGTERM'), true);
    await waitForFixture(drainObserved, t.signal);
    assert.equal(existsSync(marker), true);
    assert.equal(child.exitCode, null);
    assert.equal(req.aborted, false);
    assert.equal(res.destroyed, false);
    respond();
    assert.deepEqual(await waitForFixture(exited, t.signal), [0, null]);
    assert.equal(requests, 1);
    assert.equal(existsSync(marker), false);
    assert.equal(errors, '');
  } finally {
    // Only the test-owned subprocess and synthetic temporary artifacts are cleaned up.
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.catch(() => undefined); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

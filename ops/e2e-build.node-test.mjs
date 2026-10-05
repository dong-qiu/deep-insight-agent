import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildForE2E, verifyE2EBuild } from './e2e-build.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'c5-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'fixture source');
  writeFileSync(join(root, 'package.json'), '{}');
  const env = { CI: 'true', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'fixture', NEXT_PUBLIC_TEST: 'public' };
  const output = () => {
    for (const dir of ['server', 'static']) mkdirSync(join(root, '.next', dir), { recursive: true });
    for (const file of ['BUILD_ID', 'routes-manifest.json', 'build-manifest.json', 'required-server-files.json', 'server/app.js', 'static/app.js']) {
      writeFileSync(join(root, '.next', file), file);
    }
  };
  const build = (spawn = () => { output(); return { status: 0 }; }) => buildForE2E(root, env, spawn);
  return { root, env, build, output, verify: () => verifyE2EBuild(root, env) };
}

test('reuse rejects missing receipt and missing production output', (t) => {
  const f = fixture(t);
  assert.throws(f.verify, /e2e_build/);
  assert.throws(() => f.build(() => ({ status: 0 })), /e2e_build/);
});

test('successful build is reusable; cache changes do not invalidate production output', (t) => {
  const f = fixture(t); f.build(); f.verify();
  mkdirSync(join(f.root, '.next/cache'), { recursive: true });
  writeFileSync(join(f.root, '.next/cache/data'), 'mutable cache');
  f.verify();
});

for (const file of ['src/app.ts', 'public/new.svg', 'vendor/tool/index.js', 'next.config.mjs', 'package-lock.json', '.env.local', 'postcss.config.js', '.babelrc', 'next.config.ts', 'evals/check.ts']) {
  test(`reuse rejects changed build input ${file}`, (t) => {
    const f = fixture(t); f.build();
    mkdirSync(join(f.root, file, '..'), { recursive: true });
    writeFileSync(join(f.root, file), 'changed');
    assert.throws(f.verify, /e2e_build_identity/);
  });
}
for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'NEXT_PUBLIC_TEST', 'NODE_OPTIONS', 'NODE_PATH', 'BABEL_ENV', 'BROWSERSLIST_ENV']) {
  test(`reuse rejects changed environment identity ${key}`, (t) => {
    const f = fixture(t); f.build(); f.env[key] = 'changed';
    assert.throws(f.verify, /e2e_build_identity/);
  });
}
test('reuse rejects a different HEAD and a copied worktree', (t) => {
  const f = fixture(t); f.build();
  const other = fixture(t);
  rmSync(join(other.root, '.next'), { recursive: true, force: true });
  // Recreate identical output and copy receipt: path binding must reject it.
  other.output();
  writeFileSync(join(other.root, '.next/e2e-build-receipt.json'), readFileSync(join(f.root, '.next/e2e-build-receipt.json')));
  assert.throws(other.verify, /e2e_build_identity/);
  execFileSync('git', ['-C', f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'different HEAD']);
  assert.throws(f.verify, /e2e_build_identity/);
});
for (const file of ['BUILD_ID', 'server/app.js', 'static/app.js', 'routes-manifest.json']) {
  test(`reuse rejects modified or missing artifact ${file}`, (t) => {
    const f = fixture(t); f.build();
    writeFileSync(join(f.root, '.next', file), 'replacement');
    assert.throws(f.verify, /e2e_build_artifact/);
    rmSync(join(f.root, '.next', file));
    assert.throws(f.verify, /e2e_build/);
  });
}
for (const delta of [-3_600_001, 60_000]) {
  test(`reuse rejects expired/future receipt (${delta})`, (t) => {
    const f = fixture(t); f.build();
    const file = join(f.root, '.next/e2e-build-receipt.json');
    const receipt = JSON.parse(readFileSync(file));
    receipt.completedAt = Date.now() + delta;
    writeFileSync(file, JSON.stringify(receipt));
    assert.throws(f.verify, /e2e_build_expired/);
  });
}
test('malformed receipt and failed/signalled rebuild never allow old output', (t) => {
  const f = fixture(t); f.build();
  writeFileSync(join(f.root, '.next/e2e-build-receipt.json'), '{broken');
  assert.throws(f.verify, /e2e_build_receipt/);
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failure') }]) {
    f.build();
    assert.throws(() => f.build(() => result));
    assert.throws(f.verify, /e2e_build_receipt/);
  }
});
test('input mutation during build refuses a receipt', (t) => {
  const f = fixture(t);
  assert.throws(() => f.build(() => { f.output(); writeFileSync(join(f.root, 'src/app.ts'), 'during build'); return { status: 0 }; }), /e2e_build_identity/);
  assert.throws(f.verify, /e2e_build_receipt/);
});

test('CI reuse requires complete run identity; deleted source also invalidates it', (t) => {
  const f = fixture(t); f.build();
  delete f.env.GITHUB_RUN_ATTEMPT;
  assert.throws(f.verify, /e2e_build_ci_identity_missing/);
  f.env.GITHUB_RUN_ATTEMPT = '1';
  rmSync(join(f.root, 'src/app.ts'));
  assert.throws(f.verify, /e2e_build_identity/);
});

test('real verify CLI fails closed on missing output and succeeds only for matching output', (t) => {
  const f = fixture(t);
  const script = new URL('./e2e-build.mjs', import.meta.url).pathname;
  const run = () => execFileSync(process.execPath, [script, 'verify'], { cwd: f.root, env: { ...process.env, ...f.env }, stdio: 'pipe' });
  // Use the actual CLI environment to match NEXT_* identity as well.
  const env = { ...process.env, ...f.env };
  assert.throws(run, (error) => error.status === 1);
  buildForE2E(f.root, env, () => { f.output(); return { status: 0 }; });
  assert.match(run().toString(), /additional_builds=0/);
  writeFileSync(join(f.root, '.next/server/app.js'), 'changed');
  assert.throws(run, (error) => error.status === 1);
});


test('ignored public assets affect identity; ignored eval output does not', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.gitignore'), 'public/private.svg\nevals/out/\n');
  f.build();
  mkdirSync(join(f.root, 'evals/out'), { recursive: true });
  writeFileSync(join(f.root, 'evals/out/receipt.json'), '{}');
  f.verify();
  mkdirSync(join(f.root, 'public'), { recursive: true });
  writeFileSync(join(f.root, 'public/private.svg'), 'synthetic asset');
  assert.throws(f.verify, /e2e_build_identity/);
});

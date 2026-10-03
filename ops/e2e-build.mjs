import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const receiptName = 'e2e-build-receipt.json';
const maxAgeMs = 60 * 60 * 1000;
const privateInputs = [
  '.env', '.env.local', '.env.production', '.env.production.local',
  'node_modules/next/package.json',
];

function buildInputs(root) {
  // Include new config files and the evals TS project, but never ignored local
  // datasets/output. Documentation/tool metadata is not a Next build input.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((path) => !/^(src|public|vendor|node_modules|\.next|docs|skills|\.agents|\.claude|\.codex|\.github|\.githooks)\//.test(path));
  return [...new Set(['src', 'public', 'vendor', ...files, ...privateInputs])].sort();
}

// Hash names and bytes, including newly added inputs. Never persist env contents.
function treeHash(root, paths, excluded = new Set()) {
  const hash = createHash('sha256');
  function visit(path) {
    if (excluded.has(path)) return;
    const full = join(root, path);
    hash.update(JSON.stringify(path));
    if (!existsSync(full)) { hash.update('missing'); return; }
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      hash.update('directory');
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile()) {
      const bytes = readFileSync(full);
      hash.update(`file:${bytes.length}:`); hash.update(bytes);
    } else {
      // Symlinks can point outside the isolated worktree and evade content identity.
      throw new Error('e2e_build_unsupported_input');
    }
  }
  for (const path of paths) visit(path);
  return hash.digest('hex');
}

function identity(root, env) {
  if (env.CI === 'true' && (!env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT || !env.GITHUB_SHA)) {
    throw new Error('e2e_build_ci_identity_missing');
  }
  const publicEnv = Object.fromEntries(Object.keys(env).filter((key) => key.startsWith('NEXT_') || ['NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'BABEL_ENV', 'BROWSERSLIST', 'BROWSERSLIST_ENV'].includes(key)).sort().map((key) => [key, env[key]]));
  return {
    root: realpathSync(root),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    inputs: treeHash(root, buildInputs(root)),
    node: process.version,
    environment: createHash('sha256').update(JSON.stringify(publicEnv)).digest('hex'),
    ci: [env.CI ?? '', env.GITHUB_RUN_ID ?? '', env.GITHUB_RUN_ATTEMPT ?? '', env.GITHUB_SHA ?? ''],
  };
}

function artifactHash(root) {
  for (const path of ['BUILD_ID', 'routes-manifest.json', 'build-manifest.json', 'required-server-files.json', 'server', 'static']) {
    if (!existsSync(join(root, '.next', path))) throw new Error('e2e_build_artifact_missing');
  }
  if (!readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim()) throw new Error('e2e_build_artifact_missing');
  // standalone contains Next's traced dependency symlinks; E2E uses next start,
  // whose served output is server/static plus the root manifests, not standalone.
  return treeHash(root, ['.next'], new Set(['.next/cache', '.next/standalone', '.next/trace', `.next/${receiptName}`]));
}

export function buildForE2E(root, env = process.env, spawn = spawnSync) {
  const receiptPath = join(root, '.next', receiptName);
  rmSync(receiptPath, { force: true });
  const before = identity(root, env);
  const started = Date.now();
  const result = spawn('npm', ['run', 'build'], { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('e2e_build_failed');
  const after = identity(root, env);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('e2e_build_identity_changed_during_build');
  const artifacts = artifactHash(root);
  const completedAt = Date.now();
  writeFileSync(receiptPath, JSON.stringify({ version: 1, identity: after, artifacts, completedAt, buildMs: completedAt - started }) + '\n', { mode: 0o600 });
  console.log(`E2E build receipt written: build_ms=${completedAt - started}, builds=1`);
}

export function verifyE2EBuild(root, env = process.env) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(root, '.next', receiptName), 'utf8')); }
  catch { throw new Error('e2e_build_receipt_missing_or_invalid'); }
  if (receipt?.version !== 1) throw new Error('e2e_build_receipt_invalid');
  const age = Date.now() - receipt.completedAt;
  if (!Number.isSafeInteger(receipt.completedAt) || age < 0 || age > maxAgeMs) throw new Error('e2e_build_expired');
  if (JSON.stringify(receipt.identity) !== JSON.stringify(identity(root, env))) throw new Error('e2e_build_identity_mismatch');
  if (receipt.artifacts !== artifactHash(root)) throw new Error('e2e_build_artifact_mismatch');
  console.log(`E2E reusing verified build: build_ms=${receipt.buildMs}, additional_builds=0`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'build') buildForE2E(process.cwd());
    else if (process.argv[2] === 'verify') verifyE2EBuild(process.cwd());
    else throw new Error('e2e_build_expected_build_or_verify');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'e2e_build_failed');
    process.exitCode = 1;
  }
}

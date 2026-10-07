import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const historicalRevision = "b199bc0381a1ebd2b50fde0e68819e0b884a4383";
export const oldRevision = "823b6d875ceecc66dc35ff4ef37a8699aadbec17";
export const releasePolicy = JSON.parse(readFileSync(new URL("./security-release-policy.json", import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const isolatedEnv = directory => ({ PATH: process.env.PATH, HOME: directory, NODE_ENV: "test", NO_COLOR: "1",
  DATA_DIR: directory, DB_PATH: join(directory, "unused.db"), AUTH_SECRET: "a2-synthetic-test-secret-with-no-production-value" });

// Versioned source only. No local config/data, and no reads in another Session's worktree.
export function exportSource(revision, directory) {
  assert.ok([oldRevision, historicalRevision, releasePolicy.revision].includes(revision));
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync("git", ["archive", revision], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  // Dependency sharing is confined to installed packages, never state/configuration.
  if (revision === releasePolicy.revision) {
    for (const name of ["package.json", "package-lock.json"]) assert.equal(hash(readFileSync(join(directory, name))), hash(readFileSync(join(root, name))));
  } else {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json")));
    assert.equal(pkg.dependencies["better-sqlite3"], JSON.parse(readFileSync(join(root, "package.json"))).dependencies["better-sqlite3"]);
  }
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
}

/** Create legacy data using an exact historical source runner. Never downgrade a v48 DB or launch the old vulnerable image. */
export function makeLegacyFixture(directory, revision = oldRevision) {
  const source = join(directory, "old-source");
  exportSource(revision, source);
  const entry = join(source, "ops/a2-fixture.ts"), output = join(source, "ops/a2-fixture.cjs");
  writeFileSync(entry, `
    import {openDb} from '../src/lib/db/index.js';
    import {applyProvenanceMigrations} from '../src/lib/db/provenance-migrations.js';
    const db = openDb(':memory:'); applyProvenanceMigrations(db);
    db.prepare("INSERT INTO topic(id,name,language,brief_schedule) VALUES ('t_old','Synthetic','en','daily')").run();
    db.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES ('run_a1b2c3d4','ingest','{}','done','2026-10-01T00:00:00Z')").run();
    db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,citation_count,cost) VALUES ('rep_a1b2c3d4','brief','t_old','failed','2026-10-01T00:00:00Z','Synthetic',0,'{}')").run();
    process.stdout.write(db.serialize()); db.close();
  `);
  execFileSync(join(root, "node_modules/.bin/esbuild"), [entry, "--bundle", "--platform=node", "--format=cjs", "--packages=external", `--outfile=${output}`], { stdio: "pipe" });
  const fixture = execFileSync(process.execPath, [output], { cwd: source, env: isolatedEnv(directory), maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  const path = join(directory, "synthetic-legacy.db");
  writeFileSync(path, fixture);
  return { path, sha256: hash(fixture), source_revision: revision };
}

export function testFrozenSource(directory) {
  const source = join(directory, "release-source");
  exportSource(releasePolicy.revision, source);
  const tests = ["src/lib/db/d7-id-compatibility.test.ts", "src/lib/db/provenance-migrations.test.ts",
    "src/lib/db/deployment.test.ts", "src/lib/db/initialization.test.ts", "src/lib/db/reports-cancellation.test.ts",
    "src/lib/db/reader-evidence.test.ts", "src/lib/db/report-redaction-boundary.test.ts", "src/lib/db/model-usage.test.ts",
    "src/lib/db/auth-reader.test.ts", "src/lib/runtime/session-jwt.test.ts", "src/lib/agents/report-gen.test.ts",
    "src/lib/agents/c2a-cancellation.integration.test.ts"];
  const output = execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests], {
    cwd: source, env: isolatedEnv(directory), timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  execFileSync(process.execPath, ["--test", "ops/source-map-security.node-test.mjs"], {
    cwd: source, env: isolatedEnv(directory), timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  return { source_revision: releasePolicy.revision, kind: "specified-source-tests-not-image-tests", tests, summary: output.match(/Test Files[^\n]*|Tests[^\n]*/g) };
}

export function verifySourceUpgrade(directory, fixture) {
  const source = join(directory, "release-source"), script = join(source, "ops/a2-migrate.mjs");
  const expected = JSON.parse(readFileSync(join(root, "tests/fixtures/c3-v47-migration-checksums.json"))).ledger.slice(0, fixture.source_revision === historicalRevision ? 46 : 47);
  const ledgerAt = () => {
    const db = new Database(fixture.path, { readonly: true, fileMustExist: true });
    try { return db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all(); }
    finally { db.close(); }
  };
  assert.deepEqual(ledgerAt(), expected);
  execFileSync(join(root, "node_modules/.bin/esbuild"), [join(source, "ops/run-provenance-migrations.ts"), "--bundle",
    "--platform=node", "--format=esm", "--packages=external", `--outfile=${script}`], { stdio: "pipe" });
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [script], {
    cwd: source, env: { ...isolatedEnv(directory), DB_PATH: fixture.path }, timeout: 30_000, stdio: "pipe",
  });
  const after = ledgerAt();
  assert.equal(after.length, 48);
  assert.deepEqual(after.slice(0, expected.length), expected);
  const db = new Database(fixture.path, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.prepare("SELECT status FROM run WHERE id='run_a1b2c3d4'").get().status, "done");
    assert.equal(db.prepare("SELECT status FROM report WHERE id='rep_a1b2c3d4'").get().status, "failed");
  } finally { db.close(); }
  return { kind: "specified-source-cli-not-image", historical_migrations: expected.length, historical_checksums: "unchanged", v48: after[47], ledger_sha256: hash(JSON.stringify(after)) };
}

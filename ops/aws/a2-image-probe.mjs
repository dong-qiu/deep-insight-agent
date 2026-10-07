// Mounted by the isolated CI test, never included in or invoked by production.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const identity = JSON.parse(readFileSync("/app/a2-identity.json"));
assert.equal(JSON.parse(readFileSync("/app/build-info.json")).git_sha, identity.revision);
assert.equal(JSON.parse(readFileSync("/app/node_modules/source-map-js/package.json")).version, "1.2.2");
const envFor = path => ({ PATH: process.env.PATH, NODE_ENV: "production", DATA_DIR: "/data", DB_PATH: path,
  GIT_SHA: identity.revision, INSIGHT_IMAGE_DIGEST: identity.manifest_digest,
  PROVENANCE_DEPLOYMENT_REQUIRED: "1", DEPLOY_ACTOR: "a2-synthetic-ci" });
function cli(name, path, extra = {}, success = true) {
  const r = spawnSync(process.execPath, [`/app/ops/${name}.mjs`], { env: { ...envFor(path), ...extra },
    encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  if (success) assert.equal(r.status, 0, r.stderr);
  else assert.notEqual(r.status, 0);
  return r;
}
const v48 = "20261004_48_model_usage_attempt";
const ledger = db => db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all();
const dbAt = path => { const db = new Database(path); db.pragma("foreign_keys=ON"); return db; };

for (const stage of ["fresh-v48", "v46-to-v48", "v47-to-v48"]) {
  const path = `/data/${stage}.db`;
  if (stage !== "fresh-v48") copyFileSync(stage === "v46-to-v48" ? "/app/a2-v46.db" : "/app/a2-v47.db", path);
  let before;
  if (stage !== "fresh-v48") {
    const db = dbAt(path); before = ledger(db);
    assert.equal(before.length, stage === "v46-to-v48" ? 46 : 47);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='model_usage_attempt'").get(), undefined);
    db.close();
  }
  cli("run-provenance-migrations", path);
  const db = dbAt(path);
  const migrated = ledger(db);
  assert.equal(migrated.length, 48);
  if (before) assert.deepEqual(migrated.slice(0, before.length), before);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  if (before) {
    assert.equal(db.prepare("SELECT status FROM run WHERE id='run_a1b2c3d4'").get().status, "done");
    assert.equal(db.prepare("SELECT status FROM report WHERE id='rep_a1b2c3d4'").get().status, "failed");
  }
  const runId = "run_0123456789abcdef0123456789abcdef";
  // SQL fixtures exercise persistence constraints; not claims that the business writer ran.
  db.prepare("INSERT INTO run(id,kind,target,status,started_at) VALUES (?,'ingest','{}','done','2026-10-07T00:00:00Z')").run(runId);
  db.prepare(`INSERT INTO model_usage_attempt(attempt_id,logical_call_id,attempt_number,run_id,role,provider,model,started_at)
    VALUES ('a2_attempt','a2_call',1,?,'analyzer','anthropic','synthetic','2026-10-07T00:00:00Z')`).run(runId);
  assert.throws(() => db.prepare("DELETE FROM model_usage_attempt").run(), /usage_delete_forbidden/);
  assert.throws(() => db.prepare("UPDATE model_usage_attempt SET run_id='missing'").run(), /usage_identity_immutable/);
  assert.throws(() => db.prepare(`INSERT INTO model_usage_attempt(attempt_id,logical_call_id,attempt_number,run_id,role,provider,model,started_at)
    VALUES ('bad','bad',1,'missing','analyzer','anthropic','synthetic','2026-10-07T00:00:00Z')`).run(), /FOREIGN KEY/);
  const newRow = db.prepare("SELECT * FROM model_usage_attempt").get();
  db.close();
  cli("run-provenance-migrations", path); // Same research rollback image, no reverse migration.
  const again = dbAt(path);
  assert.deepEqual(ledger(again), migrated);
  assert.deepEqual(again.prepare("SELECT * FROM model_usage_attempt").get(), newRow);
  assert.deepEqual(again.pragma("foreign_key_check"), []);
  again.close();

  cli("record-deployment", path);
  cli("record-deployment", path);
  const records = dbAt(path);
  assert.deepEqual(records.prepare("SELECT image_digest,git_sha,actor FROM deployment_record").all(), [1, 2].map(() => ({
    image_digest: identity.manifest_digest, git_sha: identity.revision, actor: "a2-synthetic-ci",
  })));
  records.close();
  cli("record-deployment", path, { INSIGHT_IMAGE_DIGEST: "" }, false);
  const failedRecord = dbAt(path);
  assert.equal(failedRecord.prepare("SELECT count(*) n FROM deployment_record").get().n, 2);
  failedRecord.exec("CREATE TRIGGER a2_record_failure BEFORE INSERT ON deployment_record BEGIN SELECT RAISE(ABORT,'synthetic_record_failure'); END");
  failedRecord.close();
  cli("record-deployment", path, {}, false);
  const afterFailure = dbAt(path);
  assert.equal(afterFailure.prepare("SELECT count(*) n FROM deployment_record").get().n, 2);
  assert.deepEqual(afterFailure.prepare("SELECT * FROM model_usage_attempt").get(), newRow);
  // Corrupt only this isolated test ledger to prove migration refusal preserves new data.
  afterFailure.prepare("UPDATE schema_migration SET checksum=? WHERE version=?").run("f".repeat(64), v48);
  afterFailure.close();
  assert.match(cli("run-provenance-migrations", path, {}, false).stderr, /checksum mismatch/);
  const final = dbAt(path);
  assert.deepEqual(final.prepare("SELECT * FROM model_usage_attempt").get(), newRow);
  assert.equal(final.prepare("SELECT count(*) n FROM deployment_record").get().n, 2);
  final.close();
}

// A v48 DDL failure does not erase previously committed v47 migrations.
const brokenPath = "/data/failed-migration.db";
copyFileSync("/app/a2-v47.db", brokenPath);
const broken = dbAt(brokenPath), oldLedger = ledger(broken);
broken.exec("CREATE TABLE model_usage_attempt(conflict TEXT)");
broken.close();
cli("run-provenance-migrations", brokenPath, {}, false);
const failed = dbAt(brokenPath);
assert.deepEqual(ledger(failed), oldLedger);
assert.equal(failed.prepare("SELECT status FROM report WHERE id='rep_a1b2c3d4'").get().status, "failed");
failed.close();

const native = spawnSync(process.execPath, ["--test", "/app/ops/a2-sharp-security.node-test.mjs"], {
  cwd: "/app", env: { PATH: process.env.PATH }, timeout: 80_000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 128 * 1024,
});
assert.ifError(native.error); assert.equal(native.status, 0, native.stderr + native.stdout);
assert.match(native.stdout, /# pass 6/);
console.log(JSON.stringify({ schema_version: "a2-image-probe-v1", revision: identity.revision,
  manifest_digest: identity.manifest_digest, native_six: "pass", runtime_source_map: "1.2.2",
  matrices: ["fresh-v48", "v46-to-v48", "v47-to-v48", "same-image-post-migration", "record-and-migration-failure"],
  business_writer: "not-exercised-by-SQL-fixtures", http_auth_reader: "not-exercised", production_compatibility: "unknown",
  deployment_permitted: false, rollback_permitted: false }));

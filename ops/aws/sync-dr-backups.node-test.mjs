import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("ops/aws/sync-dr-backups.sh");
const stamp = (date) => date.toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 8)
  + "-" + date.toISOString().replaceAll(":", "").slice(11, 17);

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "insight-dr-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backups = join(root, "backups");
  mkdirSync(backups);
  const log = join(root, "aws.log");
  const aws = join(root, "aws-mock");
  writeFileSync(aws, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DR_TEST_LOG\"\n");
  chmodSync(aws, 0o755);
  return { root, backups, log, aws };
}

function addBackup(f, date, { manifest = true, status = "complete", corrupt = false, extra = false } = {}) {
  const dir = join(f.backups, stamp(date));
  mkdirSync(dir);
  const body = "snapshot bytes";
  writeFileSync(join(dir, "insight.db"), corrupt ? "changed bytes" : body);
  if (extra) writeFileSync(join(dir, "stray.env"), "must not upload");
  if (manifest) writeFileSync(join(dir, "backup-manifest.json"), JSON.stringify({
    schema_version: 1,
    created_at: date.toISOString(),
    status,
    files: [{ path: "insight.db", size: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") }],
  }));
  return dir;
}

function run(f) {
  return spawnSync("bash", [SCRIPT], {
    cwd: f.root,
    env: { ...process.env, DR_BACKUP_ROOT: f.backups, DR_BUCKET: "test-bucket", DR_AWS_BIN: f.aws, DR_TEST_LOG: f.log },
    encoding: "utf8",
  });
}

test("off-box sync selects only recent sealed snapshots and includes declared partial snapshots", (t) => {
  const f = setup(t);
  const now = new Date();
  const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const partial = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const old = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
  addBackup(f, recent);
  addBackup(f, partial, { status: "incomplete" });
  addBackup(f, old);
  addBackup(f, new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), { manifest: false });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.ok(calls.some((call) => call.includes(`/ec2/${stamp(recent)}/`)));
  assert.ok(calls.some((call) => call.includes(`/ec2/${stamp(partial)}/`)));
});

test("off-box sync rejects corrupt, extra, and linked artifacts without making an AWS call", (t) => {
  const f = setup(t);
  const now = Date.now();
  addBackup(f, new Date(now - 86400000), { corrupt: true });
  addBackup(f, new Date(now - 2 * 86400000), { extra: true });
  const linked = addBackup(f, new Date(now - 3 * 86400000));
  symlinkSync(join(linked, "insight.db"), join(linked, "secret-link"));
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no_eligible_backup_for_dr_sync/);
  assert.throws(() => readFileSync(f.log));
});

test("off-box sync uses the interval start and DB hash for new manifests", (t) => {
  const f = setup(t);
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dir = addBackup(f, recent);
  const path = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.db_snapshot_interval = {
    started_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(),
    completed_at: recent.toISOString(),
    source_data_version_before: 1,
    source_data_version_after: 1,
    source_data_version_unchanged: true,
    db_sha256: manifest.files[0].sha256,
  };
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(run(f).status, 2);
  manifest.db_snapshot_interval.started_at = recent.toISOString();
  manifest.db_snapshot_interval.db_sha256 = "0".repeat(64);
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(run(f).status, 2);
  manifest.db_snapshot_interval.db_sha256 = manifest.files[0].sha256;
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(run(f).status, 0);
  manifest.db_snapshot_interval = null;
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(run(f).status, 2);
});

test("off-box sync reports a rejected recent snapshot even when an older one syncs", (t) => {
  const f = setup(t);
  const now = Date.now();
  const prior = new Date(now - 2 * 86400000);
  const recent = new Date(now - 86400000);
  addBackup(f, prior);
  const dir = addBackup(f, recent);
  const path = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.db_snapshot_interval = {
    started_at: recent.toISOString(),
    completed_at: recent.toISOString(),
    source_data_version_before: 1,
    source_data_version_after: 1,
    source_data_version_unchanged: true,
    db_sha256: "0".repeat(64),
  };
  writeFileSync(path, JSON.stringify(manifest));
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`dr_sync_rejected_snapshot=${stamp(recent)}`));
  assert.match(result.stderr, /dr_sync_rejected_snapshots=1/);
  assert.match(result.stdout, /dr_sync_snapshots=1/);
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`/ec2/${stamp(prior)}/`));
});

test("off-box sync diagnoses an older invalid snapshot without failing a newer valid sync", (t) => {
  const f = setup(t);
  const now = Date.now();
  const older = new Date(now - 4 * 86400000);
  const recent = new Date(now - 86400000);
  addBackup(f, older, { extra: true });
  addBackup(f, recent);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`dr_sync_skipped_invalid_historical_snapshot=${stamp(older)}`));
  assert.doesNotMatch(result.stderr, /dr_sync_rejected_snapshot=/);
  assert.match(result.stdout, /dr_sync_snapshots=1/);
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`/ec2/${stamp(recent)}/`));
});

test("off-box sync rejects a newer snapshot whose manifest time is in the future", (t) => {
  const f = setup(t);
  const now = Date.now();
  const prior = new Date(now - 2 * 86400000);
  const recent = new Date(now - 86400000);
  addBackup(f, prior);
  const dir = addBackup(f, recent);
  const path = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const future = new Date(now + 86400000).toISOString();
  manifest.created_at = new Date(now + 2 * 86400000).toISOString();
  manifest.db_snapshot_interval = {
    started_at: future,
    completed_at: future,
    source_data_version_before: 1,
    source_data_version_after: 1,
    source_data_version_unchanged: true,
    db_sha256: manifest.files[0].sha256,
  };
  writeFileSync(path, JSON.stringify(manifest));
  const result = run(f);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`dr_sync_rejected_snapshot=${stamp(recent)}`));
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`/ec2/${stamp(prior)}/`));
});

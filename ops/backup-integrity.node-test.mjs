import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { inspectBackup, planBackupPrune, verifyBackup } from "./backup-integrity.mjs";

function fixture(t, { rawRef, report = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "insight-backup-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const backupRoot = join(root, "backups");
  mkdirSync(join(dataDir, "raw"), { recursive: true });
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  const source = "exact original source bytes";
  const digest = createHash("sha256").update(source).digest("hex");
  const rawName = `ci_test.${digest}.txt`;
  writeFileSync(join(dataDir, "raw", rawName), source);
  if (report) {
    writeFileSync(join(dataDir, "reports", "rep1.md"), "# report");
    writeFileSync(join(dataDir, "reports", "rep1.html"), "<h1>report</h1>");
  }
  const dbPath = join(dataDir, "insight.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE content_item(raw_ref TEXT,speaker_map_status TEXT,speaker_map_ref TEXT); CREATE TABLE report(status TEXT,body_path TEXT)");
  db.prepare("INSERT INTO content_item(raw_ref) VALUES (?)").run(rawRef ?? join("raw", rawName));
  db.prepare("INSERT INTO report(status,body_path) VALUES (?,?)").run("done", join(dataDir, "reports", "rep1"));
  db.close();
  return { root, dataDir, backupRoot, dbPath, rawName };
}

function backup(f, extraEnv = {}) {
  const env = { ...process.env, DATA_DIR: f.dataDir, DB_PATH: f.dbPath, BACKUP_DIR: f.backupRoot, BACKUP_KEEP: "3" };
  delete env.BACKUP_INCLUDE_RAW;
  const result = spawnSync(process.execPath, [resolve("ops/backup-db.mjs")], {
    cwd: resolve("."),
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const names = readdirSync(f.backupRoot);
  assert.equal(names.length, 1);
  return join(f.backupRoot, names[0]);
}

test("default backup includes raw, seals file hashes, and verifies an isolated copy", (t) => {
  const f = fixture(t);
  const original = backup(f);
  assert.ok(existsSync(join(original, "raw", f.rawName)));
  const manifest = JSON.parse(readFileSync(join(original, "backup-manifest.json"), "utf8"));
  const interval = manifest.db_snapshot_interval;
  assert.ok(interval);
  assert.ok(interval.started_at <= interval.completed_at && interval.completed_at <= manifest.created_at);
  assert.equal(interval.source_data_version_unchanged, interval.source_data_version_before === interval.source_data_version_after);
  assert.equal(interval.db_sha256, createHash("sha256").update(readFileSync(join(original, "insight.db"))).digest("hex"));
  assert.equal(verifyBackup(original, f.dataDir).complete, true);
  assert.equal(verifyBackup(original, f.dataDir).snapshot_time_evidence, "db_interval_no_external_commit_observed");
  const isolated = join(f.root, "isolated-restore");
  cpSync(original, isolated, { recursive: true });
  assert.equal(verifyBackup(isolated, f.dataDir).complete, true);
  writeFileSync(join(isolated, "raw", f.rawName), "different bytes");
  assert.equal(verifyBackup(isolated, f.dataDir).reason, "manifest_mismatch");
});

test("snapshot time receipt is bound to the backed-up database and data-version observation", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  const path = join(dir, "backup-manifest.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  const changedSha = structuredClone(original);
  changedSha.db_snapshot_interval.db_sha256 = "0".repeat(64);
  writeFileSync(path, JSON.stringify(changedSha));
  assert.equal(verifyBackup(dir, f.dataDir).reason, "snapshot_interval_invalid");
  const changedObservation = structuredClone(original);
  changedObservation.db_snapshot_interval.source_data_version_unchanged = !changedObservation.db_snapshot_interval.source_data_version_unchanged;
  writeFileSync(path, JSON.stringify(changedObservation));
  assert.equal(verifyBackup(dir, f.dataDir).reason, "snapshot_interval_invalid");
});

test("legacy manifests remain restorable without gaining snapshot-time evidence", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  const path = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  delete manifest.db_snapshot_interval;
  writeFileSync(path, JSON.stringify(manifest));
  const result = verifyBackup(dir, f.dataDir);
  assert.equal(result.complete, true);
  assert.equal(result.snapshot_time_evidence, "legacy_unattested");
});

test("a second SQLite connection changes data_version and marks the observed interval", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  const observer = new Database(f.dbPath);
  const writer = new Database(f.dbPath);
  try {
    const before = observer.pragma("data_version", { simple: true });
    writer.prepare("INSERT INTO content_item(raw_ref) VALUES (?)").run("raw/another.txt");
    const after = observer.pragma("data_version", { simple: true });
    assert.notEqual(before, after);
    const path = join(dir, "backup-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.db_snapshot_interval.source_data_version_before = before;
    manifest.db_snapshot_interval.source_data_version_after = after;
    manifest.db_snapshot_interval.source_data_version_unchanged = false;
    writeFileSync(path, JSON.stringify(manifest));
    const result = verifyBackup(dir, f.dataDir);
    assert.equal(result.complete, true);
    assert.equal(result.snapshot_time_evidence, "db_interval_external_commit_observed");
  } finally {
    writer.close();
    observer.close();
  }
});

test("data_version detects a second connection's commit during the online backup call", async (t) => {
  const f = fixture(t);
  const observer = new Database(f.dbPath);
  const writer = new Database(f.dbPath);
  try {
    const before = observer.pragma("data_version", { simple: true });
    let wroteDuringBackup = false;
    await observer.backup(join(f.root, "concurrent.db"), {
      progress() {
        if (!wroteDuringBackup) {
          writer.prepare("INSERT INTO content_item(raw_ref) VALUES (?)").run("raw/another.txt");
          wroteDuringBackup = true;
        }
        return 1;
      },
    });
    const after = observer.pragma("data_version", { simple: true });
    assert.equal(wroteDuringBackup, true);
    assert.notEqual(after, before);
  } finally {
    writer.close();
    observer.close();
  }
});

test("a WAL source produces a standalone sealed backup without generated SQLite sidecars", (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
  db.close();
  const dir = backup(f);
  assert.equal(existsSync(join(dir, "insight.db-wal")), false);
  assert.equal(existsSync(join(dir, "insight.db-shm")), false);
  const snapshot = new Database(join(dir, "insight.db"), { readonly: true });
  assert.equal(snapshot.pragma("journal_mode", { simple: true }), "delete");
  snapshot.close();
  assert.equal(verifyBackup(dir, f.dataDir).complete, true);
});

test("verification refuses an unnormalized WAL backup before SQLite can create sidecars", async (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
  const dir = join(f.root, "unsealed-wal-backup");
  mkdirSync(dir);
  try { await db.backup(join(dir, "insight.db")); }
  finally { db.close(); }
  assert.throws(() => inspectBackup(dir, f.dataDir), /backup_wal_mode_unsupported/);
  assert.equal(existsSync(join(dir, "insight.db-wal")), false);
  assert.equal(existsSync(join(dir, "insight.db-shm")), false);
});

test("explicit raw opt-out keeps a partial backup but never passes recovery verification", (t) => {
  const f = fixture(t);
  const dir = backup(f, { BACKUP_INCLUDE_RAW: "0" });
  assert.equal(existsSync(join(dir, "raw")), false);
  const result = verifyBackup(dir, f.dataDir);
  assert.equal(result.complete, false);
  assert.equal(result.reason, "raw_excluded");
  assert.equal(result.summary.references_missing, 1);
});

test("explicit raw opt-out is incomplete even when the snapshot has no raw reference", (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  db.exec("DELETE FROM content_item");
  db.close();
  const result = verifyBackup(backup(f, { BACKUP_INCLUDE_RAW: "0" }), f.dataDir);
  assert.equal(result.complete, false);
  assert.equal(result.reason, "raw_excluded");
  assert.equal(result.summary.references_missing, 0);
});

test("missing report body remains visible as an incomplete backup", (t) => {
  const f = fixture(t, { report: false });
  const result = verifyBackup(backup(f), f.dataDir);
  assert.equal(result.complete, false);
  assert.equal(result.summary.references_missing, 2);
});

test("historical and unsafe raw refs cannot be silently mapped", (t) => {
  const f = fixture(t, { rawRef: ".data/raw/legacy.txt" });
  const dir = backup(f);
  assert.equal(verifyBackup(dir, f.dataDir).summary.references_unmapped, 1);
  const g = fixture(t, { rawRef: "raw/../reports/rep1.md" });
  assert.equal(verifyBackup(backup(g), g.dataDir).summary.references_unmapped, 1);
  const h = fixture(t);
  const db = new Database(h.dbPath);
  db.prepare("UPDATE content_item SET raw_ref=?").run(`${h.dataDir}/raw/../raw/${h.rawName}`);
  db.prepare("UPDATE report SET body_path=?").run(`${h.dataDir}/reports/../reports/rep1`);
  db.close();
  assert.equal(verifyBackup(backup(h), h.dataDir).summary.references_unmapped, 3);
});

test("old snapshots without a manifest fail closed", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  rmSync(join(dir, "backup-manifest.json"));
  assert.deepEqual(verifyBackup(dir, f.dataDir), { complete: false, reason: "manifest_missing" });
});

test("a changed report file breaks the sealed hash even when DB references still exist", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  assert.match(readFileSync(join(dir, "reports", "rep1.md"), "utf8"), /report/);
  writeFileSync(join(dir, "reports", "rep1.md"), "# altered");
  assert.equal(verifyBackup(dir, f.dataDir).reason, "manifest_mismatch");
});

test("absolute volume raw refs map into the isolated backup without reading the live DB", (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  db.prepare("UPDATE content_item SET raw_ref=?").run(join(f.dataDir, "raw", f.rawName));
  db.close();
  assert.equal(verifyBackup(backup(f), f.dataDir).complete, true);
});

test("a copied raw file whose embedded digest does not match is incomplete", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dataDir, "raw", f.rawName), "altered before backup");
  const result = verifyBackup(backup(f), f.dataDir);
  assert.equal(result.complete, false);
  assert.equal(result.summary.embedded_hash_mismatch, 1);
});

test("a symlink added to an isolated copy cannot be treated as a backed artifact", (t) => {
  const f = fixture(t);
  const isolated = join(f.root, "isolated-restore");
  cpSync(backup(f), isolated, { recursive: true });
  symlinkSync(join(f.dataDir, "raw", f.rawName), join(isolated, "raw", "external-link"));
  assert.equal(verifyBackup(isolated, f.dataDir).reason, "backup_check_failed");
});

test("verified auxiliary evidence and pending-deletion artifacts are also recovery references", (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  db.exec("CREATE TABLE transcript_acquisition_fact(raw_ref TEXT,evidence_status TEXT); CREATE TABLE integrity_report_lifecycle(artifact_body_path TEXT,reader_state TEXT)");
  db.prepare("UPDATE content_item SET speaker_map_status=?,speaker_map_ref=?").run("verified", "raw/missing-speaker-map.json");
  db.prepare("INSERT INTO transcript_acquisition_fact VALUES (?,?)").run("raw/missing-transcript.json", "verified");
  db.prepare("INSERT INTO integrity_report_lifecycle VALUES (?,?)").run(join(f.dataDir, "reports", "missing-retained"), "delete_pending");
  db.close();
  const result = verifyBackup(backup(f), f.dataDir);
  assert.equal(result.complete, false);
  assert.equal(result.summary.references_missing, 4);
});

test("rotation verifies the protected snapshot and does not trust a newer corrupt complete manifest", (t) => {
  const f = fixture(t);
  const now = new Date(Date.now() + 1000);
  const stamp = (daysAgo) => {
    const iso = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  };
  const oldest = join(f.backupRoot, stamp(3));
  renameSync(backup(f), oldest);
  const corrupt = join(f.backupRoot, stamp(2));
  cpSync(oldest, corrupt, { recursive: true });
  writeFileSync(join(corrupt, "raw", f.rawName), "corrupt after seal");
  const partial = join(f.backupRoot, stamp(1));
  cpSync(oldest, partial, { recursive: true });
  const partialManifest = JSON.parse(readFileSync(join(partial, "backup-manifest.json"), "utf8"));
  partialManifest.status = "incomplete";
  writeFileSync(join(partial, "backup-manifest.json"), JSON.stringify(partialManifest));
  assert.deepEqual(planBackupPrune(f.backupRoot, 1, f.dataDir, now), [stamp(2)]);
  const newest = join(f.backupRoot, stamp(0));
  cpSync(oldest, newest, { recursive: true });
  assert.deepEqual(planBackupPrune(f.backupRoot, 1, f.dataDir, now), [stamp(1), stamp(2), stamp(3)]);
  const expired = join(f.backupRoot, stamp(91));
  cpSync(oldest, expired, { recursive: true });
  assert.deepEqual(planBackupPrune(f.backupRoot, 1, f.dataDir, now), [stamp(1), stamp(2), stamp(3), stamp(91)]);
  const legacy = join(f.backupRoot, stamp(92));
  mkdirSync(legacy);
  assert.deepEqual(planBackupPrune(f.backupRoot, 1, f.dataDir, now), [stamp(1), stamp(2), stamp(3), stamp(91)]);
});

test("a sealed snapshot older than the redaction-safe restore window is not admitted", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  const manifestPath = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.created_at = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  manifest.db_snapshot_interval.started_at = manifest.created_at;
  manifest.db_snapshot_interval.completed_at = manifest.created_at;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(verifyBackup(dir, f.dataDir).reason, "backup_outside_restore_window");
});

test("new manifests use the interval start for the 90-day restore boundary", (t) => {
  const f = fixture(t);
  const dir = backup(f);
  const path = join(dir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.db_snapshot_interval.started_at = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 - 1000).toISOString();
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(verifyBackup(dir, f.dataDir).reason, "backup_outside_restore_window");
  const legacy = structuredClone(manifest);
  delete legacy.db_snapshot_interval;
  writeFileSync(path, JSON.stringify(legacy));
  assert.equal(verifyBackup(dir, f.dataDir).complete, true);
  assert.equal(verifyBackup(dir, f.dataDir).snapshot_time_evidence, "legacy_unattested");
});

test("malformed calendar-stamp directories do not crash retention planning", (t) => {
  const f = fixture(t);
  const good = backup(f);
  const malformed = join(f.backupRoot, "99999999-999999");
  cpSync(good, malformed, { recursive: true });
  assert.deepEqual(planBackupPrune(f.backupRoot, 1, f.dataDir).includes("99999999-999999"), true);
});

test("a lookalike manifest does not authorize automatic deletion", (t) => {
  const f = fixture(t);
  const good = backup(f);
  const lookalike = join(f.backupRoot, "20200101-000000");
  cpSync(good, lookalike, { recursive: true });
  writeFileSync(join(lookalike, "backup-manifest.json"), JSON.stringify({ schema_version: 1 }));
  assert.equal(planBackupPrune(f.backupRoot, 1, f.dataDir).includes("20200101-000000"), false);
});

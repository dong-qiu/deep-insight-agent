import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const scripts = ["backfill-report-chain.mjs", "backfill-highlights.mjs", "cleanup-reports.mjs"];
const scriptPath = (name) => new URL(`./${name}`, import.meta.url).pathname;

test("legacy report metadata and cleanup commands preview but cannot write", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-report-maintenance-"));
  try {
    const path = join(root, "insight.db");
    const body1 = join(root, "rep_one.md");
    const body2 = join(root, "rep_two.md");
    writeFileSync(body1, "first report\n");
    writeFileSync(body2, "second report\n");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE report(id TEXT PRIMARY KEY, topic_id TEXT, type TEXT, status TEXT,
        generated_at TEXT, prev_report_id TEXT, insight_ids TEXT, citation_count INTEGER, body_path TEXT);
      CREATE TABLE report_index(report_id TEXT PRIMARY KEY, highlights TEXT, date TEXT);
      CREATE TABLE insight(id TEXT PRIMARY KEY, statement TEXT, importance INTEGER, headline TEXT);
    `);
    const addReport = db.prepare("INSERT INTO report VALUES(?,?,?,?,?,?,?,?,?)");
    addReport.run("rep_one", "topic", "brief", "done", "2026-01-01T01:00:00Z", null, '["ins_one"]', 1, join(root, "rep_one"));
    addReport.run("rep_two", "topic", "brief", "done", "2026-01-01T02:00:00Z", null, "[]", 0, join(root, "rep_two"));
    db.prepare("INSERT INTO report_index VALUES(?,?,?)").run("rep_one", "[]", "2026-01-01");
    db.prepare("INSERT INTO insight VALUES(?,?,?,?)").run("ins_one", "已验证的旧结论", 5, "");
    db.close();
    const before = readFileSync(path);
    const beforeFiles = readdirSync(root).sort();

    for (const name of scripts) {
      const preview = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: join(root, "active.db"), REPORT_SNAPSHOT_DB_PATH: path }, encoding: "utf8",
      });
      assert.equal(preview.status, 0, `${name}: ${preview.stderr}`);
      assert.match(preview.stdout, /只读预览/);
      assert.deepEqual(readFileSync(path), before, `${name} changed SQLite during preview`);
      assert.deepEqual(readdirSync(root).sort(), beforeFiles, `${name} created a WAL/SHM sidecar`);
      assert.equal(readFileSync(body1, "utf8"), "first report\n");
      assert.equal(readFileSync(body2, "utf8"), "second report\n");
      const missing = join(root, `missing-${name}.db`);
      const apply = spawnSync(process.execPath, [scriptPath(name), "--apply"], {
        env: { ...process.env, DB_PATH: join(root, "active.db"), REPORT_SNAPSHOT_DB_PATH: missing }, encoding: "utf8",
      });
      assert.equal(apply.status, 2, `${name}: ${apply.stderr}`);
      assert.equal(existsSync(missing), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all historical previews refuse a live-style WAL database without touching its sidecars", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-wal-reject-"));
  try {
    const path = join(root, "live.db");
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE probe(id INTEGER); INSERT INTO probe VALUES(1)");
    assert.equal(existsSync(`${path}-wal`), true);
    const before = Object.fromEntries(readdirSync(root).map((name) => [name, readFileSync(join(root, name))]));
    for (const name of [...scripts, "regenerate-reports-cites.mjs"]) {
      const result = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: join(root, "active.db"), REPORT_SNAPSHOT_DB_PATH: path }, encoding: "utf8",
      });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /拒绝读取带 WAL\/SHM 的库/);
    }
    assert.deepEqual(readdirSync(root).sort(), Object.keys(before).sort());
    for (const [name, bytes] of Object.entries(before)) assert.deepEqual(readFileSync(join(root, name)), bytes);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("highlights preview refuses old schema rather than adding columns", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-highlights-schema-"));
  try {
    const path = join(root, "old.db");
    const db = new Database(path);
    db.exec("CREATE TABLE insight(id TEXT); CREATE TABLE report_index(report_id TEXT)");
    db.close();
    const before = readFileSync(path);
    const result = spawnSync(process.execPath, [scriptPath("backfill-highlights.mjs")], {
      env: { ...process.env, DB_PATH: join(root, "active.db"), REPORT_SNAPSHOT_DB_PATH: path }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不会自动补列/);
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all historical previews ignore ambient DB_PATH and reject a snapshot alias of the active DB", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-active-db-reject-"));
  try {
    const path = join(root, "active.db");
    const db = new Database(path);
    db.exec("CREATE TABLE probe(id INTEGER); INSERT INTO probe VALUES(1)");
    db.close();
    const alias = join(root, "snapshot-alias.db");
    symlinkSync(path, alias);
    const hardlink = join(root, "snapshot-hardlink.db");
    linkSync(path, hardlink);
    const before = readFileSync(path);
    const beforeFiles = readdirSync(root).sort();
    for (const name of [...scripts, "regenerate-reports-cites.mjs"]) {
      const missing = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: path, REPORT_SNAPSHOT_DB_PATH: "" }, encoding: "utf8",
      });
      assert.notEqual(missing.status, 0, `${name} used ambient DB_PATH`);
      assert.match(missing.stderr, /显式指定隔离快照 REPORT_SNAPSHOT_DB_PATH/);
      const same = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: path, REPORT_SNAPSHOT_DB_PATH: path }, encoding: "utf8",
      });
      assert.notEqual(same.status, 0, `${name} accepted the active DB as a snapshot`);
      assert.match(same.stderr, /拒绝将活动库作为报告快照/);
      const viaAlias = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: path, REPORT_SNAPSHOT_DB_PATH: alias }, encoding: "utf8",
      });
      assert.notEqual(viaAlias.status, 0, `${name} accepted a symlink to the active DB`);
      assert.match(viaAlias.stderr, /拒绝将活动库作为报告快照/);
      const viaHardlink = spawnSync(process.execPath, [scriptPath(name)], {
        env: { ...process.env, DB_PATH: path, REPORT_SNAPSHOT_DB_PATH: hardlink }, encoding: "utf8",
      });
      assert.notEqual(viaHardlink.status, 0, `${name} accepted a hard link to the active DB`);
      assert.match(viaHardlink.stderr, /拒绝将活动库作为报告快照/);
    }
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(root).sort(), beforeFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

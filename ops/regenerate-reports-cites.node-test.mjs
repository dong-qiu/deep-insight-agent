import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const script = new URL("./regenerate-reports-cites.mjs", import.meta.url).pathname;

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "insight-report-preview-"));
  try {
    const dbPath = join(root, "insight.db");
    const oldPath = join(root, "rep_old");
    const freshPath = join(root, "rep_fresh");
    const oldBody = "## 1. 旧结论\n- 引用（1）：\n  - 「原文」— `ci_abc`\n";
    const freshBody = "# 无需变更\n";
    writeFileSync(`${oldPath}.md`, oldBody);
    writeFileSync(`${freshPath}.md`, freshBody);
    const db = new Database(dbPath);
    db.exec("CREATE TABLE report(id TEXT PRIMARY KEY, body_path TEXT, generated_at TEXT); CREATE TABLE source(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE content_item(id TEXT PRIMARY KEY, url TEXT, published_at TEXT, source_id TEXT)");
    db.prepare("INSERT INTO report VALUES(?,?,?)").run("rep_old", oldPath, "2026-01-02");
    db.prepare("INSERT INTO report VALUES(?,?,?)").run("rep_fresh", freshPath, "2026-01-01");
    db.prepare("INSERT INTO source VALUES(?,?)").run("s1", "来源");
    db.prepare("INSERT INTO content_item VALUES(?,?,?,?)").run("ci_abc", "https://example.test/original", "2026-01-01T00:00:00Z", "s1");
    db.close();
    const before = readFileSync(dbPath);
    const beforeFiles = readdirSync(root).sort();
    const run = (args = [], overridePath = dbPath) => spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, DB_PATH: join(root, "active.db"), REPORT_SNAPSHOT_DB_PATH: overridePath }, encoding: "utf8",
    });
    fn({ dbPath, root, oldPath, freshPath, oldBody, freshBody, before, beforeFiles, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("default and scoped historical-citation previews cannot mutate published files or SQLite", () => {
  withFixture(({ dbPath, root, oldPath, freshPath, oldBody, freshBody, before, beforeFiles, run }) => {
    const all = run();
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /只读预览：扫描 2 份报告/);
    assert.match(all.stdout, /rep_old · 待变更/);
    const scoped = run(["--report-id", "rep_old"]);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /只读预览：扫描 1 份报告/);
    assert.doesNotMatch(scoped.stdout, /rep_fresh/);
    assert.equal(readFileSync(`${oldPath}.md`, "utf8"), oldBody);
    assert.equal(readFileSync(`${freshPath}.md`, "utf8"), freshBody);
    assert.deepEqual(readFileSync(dbPath), before);
    assert.deepEqual(readdirSync(root).sort(), beforeFiles, "preview created a WAL/SHM or another sidecar");
  });
});

test("write flag and invalid arguments reject before opening or creating a database", () => {
  withFixture(({ root, run }) => {
    for (const args of [["--apply"], ["--report-id", "rep_old", "--apply"], ["--unknown"], ["--report-id", "../outside"], ["--report-id"]]) {
      const missingDb = join(root, `missing-${args.join("-").replaceAll("/", "_")}.db`);
      const result = run(args, missingDb);
      assert.equal(result.status, 2, `${args}: ${result.stderr}`);
      assert.equal(existsSync(missingDb), false);
    }
  });
});

test("valid but nonexistent report ID fails after a read-only lookup", () => {
  withFixture(({ dbPath, before, run }) => {
    const result = run(["--report-id", "rep_missing"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未找到报告 rep_missing/);
    assert.deepEqual(readFileSync(dbPath), before);
  });
});

test("preview requires an explicit standalone snapshot path", () => {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, DB_PATH: "/data/insight.db", REPORT_SNAPSHOT_DB_PATH: "" }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /显式指定隔离快照 REPORT_SNAPSHOT_DB_PATH/);
});

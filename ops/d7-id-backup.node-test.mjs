import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { inspectBackup } from "./backup-integrity.mjs";

test("D7 read-only C1 inventory maps historical and long report artifacts without renaming", () => {
  const root = mkdtempSync(join(tmpdir(), "insight-d7-inventory-"));
  try {
    mkdirSync(join(root, "reports"));
    // A synthetic, standalone fixture only; no snapshot, backup or restore command.
    const db = new Database(join(root, "insight.db"));
    try {
      db.exec("CREATE TABLE content_item(raw_ref TEXT,speaker_map_status TEXT,speaker_map_ref TEXT); CREATE TABLE report(id TEXT PRIMARY KEY,status TEXT,body_path TEXT)");
      for (const id of ["rep_12345678", "rep_0123456789abcdef0123456789abcdef"]) {
        db.prepare("INSERT INTO report VALUES (?,'done',?)").run(id, join(root, "reports", id));
        for (const extension of ["md", "html"]) writeFileSync(join(root, "reports", `${id}.${extension}`), `synthetic ${id}`, { mode: 0o600 });
      }
    } finally { db.close(); }
    const inventory = inspectBackup(root, root);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.summary.references_total, 4);
    assert.equal(inventory.summary.references_present, 4);
    assert.equal(inventory.summary.references_unmapped, 0);
    assert.deepEqual(inventory.files.filter(file => file.path.startsWith("reports/")).map(file => file.path), [
      "reports/rep_0123456789abcdef0123456789abcdef.html", "reports/rep_0123456789abcdef0123456789abcdef.md",
      "reports/rep_12345678.html", "reports/rep_12345678.md",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

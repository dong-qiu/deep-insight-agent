// Synthetic pair harness only. Never called by C1 or any production backup/restore entrypoint.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function tableHashes(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x => x.name);
  return names.map(name => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all().map(row => JSON.stringify(row)).sort();
    return { name, rows: rows.length, sha256: hash(JSON.stringify(rows)) };
  });
}
export async function backupSyntheticDatabase(Database, sourcePath, targetPath) {
  assert.notEqual(sourcePath, targetPath); assert.equal(existsSync(targetPath), false, 'refuse synthetic target overwrite');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const before = tableHashes(source);
    // SQLite's backup API reads committed WAL pages as well as the main file.
    await source.backup(targetPath);
    const target = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(target.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
      assert.deepEqual(target.pragma('foreign_key_check'), []);
      const copied = tableHashes(target); assert.deepEqual(copied, before, 'consistent copy preserves every table field/row');
      assert.deepEqual(tableHashes(source), before, 'copy must not change synthetic source business data');
      return { source_tables: before, copied_tables: copied, source_readonly: true, method: 'sqlite-backup' };
    } finally { target.close(); }
  } finally { source.close(); }
}

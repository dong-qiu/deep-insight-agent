import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { backupSyntheticDatabase } from './consistent-copy.mjs';
import { dbAt, snapshot, hash, bundleIdentity } from './pair-in-image.mjs';
assert.equal(process.env.A2_PAIR_ROLE, 'candidate');
const expected = JSON.parse(readFileSync('/source/pair-final.json'));
const Database = createRequire('/app/package.json')('better-sqlite3');
const copied = await backupSyntheticDatabase(Database, '/source/insight.db', '/data/insight.db');
assert.deepEqual(copied.source_tables, expected.table_hashes);
const db = dbAt('/data/insight.db');
try {
  assert.deepEqual(snapshot(db), expected.state, 'fault fixture matches successful candidate before fault injection');
  assert.deepEqual(db.prepare('SELECT * FROM deployment_record ORDER BY id').all(), expected.deployment_rows);
  console.log(JSON.stringify({ method: copied.method, all_tables: copied.copied_tables, source_readonly: copied.source_readonly,
    state_sha256: hash(JSON.stringify(snapshot(db))), deployment_rows_sha256: hash(JSON.stringify(expected.deployment_rows)), bundle: bundleIdentity() }));
} finally { db.close(); }

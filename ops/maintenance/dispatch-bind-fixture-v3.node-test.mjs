// Standalone CI fixture oracle. No writer, admission, target-cap or business consumer API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Guard before importing a native addon; node --check does not evaluate this module.
if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('dispatch_fixture_native_execution_requires_linux_github_ci');
}
const { default: Database } = await import('better-sqlite3');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function freeze(value) {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const BUSINESS = freeze({
  "format": "dispatch-bind-fixture-v1",
  "application_id": 1144144433,
  "user_version": 1,
  "objects": [
    {
      "type": "index",
      "name": "idx_generation_lease_active",
      "tbl_name": "generation_lease",
      "sql": "CREATE UNIQUE INDEX idx_generation_lease_active ON generation_lease(active_key) WHERE state IN ('reserved','owned')"
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_dispatch_1",
      "tbl_name": "generation_dispatch",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_dispatch_2",
      "tbl_name": "generation_dispatch",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_dispatch_3",
      "tbl_name": "generation_dispatch",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_lease_1",
      "tbl_name": "generation_lease",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_trace_1",
      "tbl_name": "generation_trace",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_trace_2",
      "tbl_name": "generation_trace",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_trace_request_1",
      "tbl_name": "generation_trace_request",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_trace_request_2",
      "tbl_name": "generation_trace_request",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_generation_trace_request_3",
      "tbl_name": "generation_trace_request",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_run_1",
      "tbl_name": "run",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_source_1",
      "tbl_name": "source",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_topic_1",
      "tbl_name": "topic",
      "sql": null
    },
    {
      "type": "table",
      "name": "generation_dispatch",
      "tbl_name": "generation_dispatch",
      "sql": "CREATE TABLE generation_dispatch (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES generation_trace_request(id),trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,claim_epoch INTEGER NOT NULL DEFAULT 0,owner_token TEXT,claimed_at TEXT,heartbeat_at TEXT,lease_expires_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
    },
    {
      "type": "table",
      "name": "generation_lease",
      "tbl_name": "generation_lease",
      "sql": "CREATE TABLE generation_lease (id TEXT PRIMARY KEY,active_key TEXT NOT NULL,scope_key TEXT NOT NULL,trace_id TEXT NOT NULL REFERENCES generation_trace(id),state TEXT NOT NULL,owner_token TEXT,fencing_epoch INTEGER NOT NULL DEFAULT 0,heartbeat_at TEXT,expires_at TEXT,created_at TEXT NOT NULL,released_at TEXT)"
    },
    {
      "type": "table",
      "name": "generation_trace",
      "tbl_name": "generation_trace",
      "sql": "CREATE TABLE generation_trace (id TEXT PRIMARY KEY,request_id TEXT UNIQUE,scope_kind TEXT NOT NULL,trigger_kind TEXT NOT NULL,topic_id TEXT REFERENCES topic(id),root_run_id TEXT REFERENCES run(id) DEFERRABLE INITIALLY DEFERRED,status TEXT NOT NULL,completion_policy TEXT NOT NULL,coverage TEXT NOT NULL DEFAULT 'complete',runtime_version TEXT NOT NULL DEFAULT '{}',summary TEXT NOT NULL DEFAULT '{}',next_sequence INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT,retry_of_trace_id TEXT REFERENCES generation_trace(id),source_id TEXT REFERENCES source(id))"
    },
    {
      "type": "table",
      "name": "generation_trace_request",
      "tbl_name": "generation_trace_request",
      "sql": "CREATE TABLE generation_trace_request (id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,active_key TEXT NOT NULL,idempotency_key_hash TEXT,request_sequence INTEGER NOT NULL DEFAULT 1,trace_id TEXT NOT NULL UNIQUE REFERENCES generation_trace(id),state TEXT NOT NULL,retained_until TEXT NOT NULL,created_at TEXT NOT NULL)"
    },
    {
      "type": "table",
      "name": "run",
      "tbl_name": "run",
      "sql": "CREATE TABLE run (\n  id          TEXT PRIMARY KEY,\n  kind        TEXT NOT NULL CHECK (kind IN ('ingest','analyze','validate','report-gen')),\n  target      TEXT NOT NULL,\n  status      TEXT NOT NULL CHECK (status IN ('running','done','failed')),\n  started_at  TEXT NOT NULL,\n  ended_at    TEXT,\n  duration_ms INTEGER,\n  cost        TEXT,\n  error       TEXT,\n  retry_of    TEXT REFERENCES run(id),\n  inserted    INTEGER,\n  trace_id TEXT\n)"
    },
    {
      "type": "table",
      "name": "source",
      "tbl_name": "source",
      "sql": "CREATE TABLE source (\n  id             TEXT PRIMARY KEY,\n  name           TEXT NOT NULL,\n  type           TEXT NOT NULL CHECK (type IN ('rss','arxiv','api')),\n  endpoint       TEXT NOT NULL,\n  topic_ids      TEXT NOT NULL DEFAULT '[]',\n  fetch_interval TEXT NOT NULL,\n  backfill       TEXT,\n  enabled        INTEGER NOT NULL DEFAULT 1,\n  fetch_mode     TEXT NOT NULL DEFAULT 'feed' CHECK (fetch_mode IN ('feed','full_text')),\n  content_container TEXT,\n  transcript_mode TEXT NOT NULL DEFAULT 'off' CHECK (transcript_mode IN ('off','observe','enabled')),\n  transcript_strategy TEXT NOT NULL DEFAULT 'relevant_only' CHECK (transcript_strategy IN ('all','relevant_only')),\n  transcript_max_items_per_run INTEGER NOT NULL DEFAULT 5 CHECK (transcript_max_items_per_run > 0),\n  transcript_max_bytes_per_run INTEGER NOT NULL DEFAULT 5242880 CHECK (transcript_max_bytes_per_run > 0),\n  transcript_timeout_budget_ms INTEGER NOT NULL DEFAULT 30000 CHECK (transcript_timeout_budget_ms > 0),\n  transcript_host_qps REAL NOT NULL DEFAULT 0.5 CHECK (transcript_host_qps > 0),\n  transcript_policy_version TEXT,\n  disabled_reason TEXT,\n  disabled_at     TEXT,\n  circuit_reset_at TEXT,\n  last_probe_at   TEXT,\n  created_at     TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),\n  CHECK (transcript_mode = 'off' OR (transcript_policy_version IS NOT NULL AND length(trim(transcript_policy_version)) > 0))\n)"
    },
    {
      "type": "table",
      "name": "topic",
      "tbl_name": "topic",
      "sql": "CREATE TABLE topic (\n  id             TEXT PRIMARY KEY,\n  name           TEXT NOT NULL,\n  keywords       TEXT NOT NULL DEFAULT '[]',\n  language       TEXT NOT NULL CHECK (language IN ('zh','en','mixed')),\n  brief_schedule TEXT NOT NULL CHECK (brief_schedule IN ('daily','weekly')),\n  enabled        INTEGER NOT NULL DEFAULT 1,\n  -- ADR-0010 行为原型：无 DB CHECK（app 层 ARCHETYPE_VALUES 校验，加原型零迁移，reference-data 模式）\n  archetype      TEXT NOT NULL DEFAULT 'deep_vertical',\n  -- ADR-0010 分面标签（JSON 数组，如 [\"domain:software-engineering\",\"lens:business\"]）：分类维度 domain(必填)+lens(选填)。\n  facets         TEXT NOT NULL DEFAULT '[]',\n  created_at     TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))\n)"
    }
  ]
});
const REGISTRY = freeze({
  "application_id": 1093883698,
  "user_version": 3,
  "tables": [
    "CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)",
    "CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('open','closed')))",
    "CREATE TABLE workers (worker_id TEXT PRIMARY KEY, generation_token TEXT UNIQUE NOT NULL, entry_point TEXT NOT NULL CHECK(entry_point IN ('generation-dispatch','source-collect','startup','local-seed','raw-recovery','report-recovery')))",
    "CREATE TABLE tasks (task_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(worker_id))",
    "CREATE TABLE operations (operation_id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL REFERENCES tasks(task_id), invocation_id TEXT UNIQUE NOT NULL, scope_json TEXT NOT NULL, input_hash TEXT NOT NULL, recovery_of TEXT)",
    "CREATE TABLE steps (step_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(operation_id), step_key TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), input_hash TEXT NOT NULL, UNIQUE(operation_id,ordinal))",
    "CREATE TABLE bindings (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), target_kind TEXT NOT NULL CHECK(target_kind IN ('business','raw','report')), identity_json TEXT NOT NULL)",
    "CREATE TABLE step_results (step_id TEXT PRIMARY KEY REFERENCES steps(step_id), business_commit TEXT NOT NULL CHECK(business_commit IN ('not_committed','committed','unknown','not_applicable')), filesystem_json TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('completed','denied','cancelled','unsupported','unknown')), reason TEXT NOT NULL)",
    "CREATE TABLE terminals (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), outcome TEXT NOT NULL CHECK(outcome IN ('completed','completed_with_diagnostics','denied','cancelled','interrupted_unknown','binding_completed')), first_reason TEXT NOT NULL)",
    "CREATE TABLE audit_facts (seq INTEGER PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, fact_json TEXT NOT NULL)"
  ],
  "triggers": [
    "CREATE TRIGGER identity_no_update BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER identity_no_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER workers_no_update BEFORE UPDATE ON workers BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER workers_no_delete BEFORE DELETE ON workers BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER tasks_no_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER steps_no_update BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER steps_no_delete BEFORE DELETE ON steps BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER bindings_no_update BEFORE UPDATE ON bindings BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER bindings_no_delete BEFORE DELETE ON bindings BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER step_results_no_update BEFORE UPDATE ON step_results BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER step_results_no_delete BEFORE DELETE ON step_results BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER terminals_no_update BEFORE UPDATE ON terminals BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER terminals_no_delete BEFORE DELETE ON terminals BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER audit_facts_no_update BEFORE UPDATE ON audit_facts BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER audit_facts_no_delete BEFORE DELETE ON audit_facts BEGIN SELECT RAISE(ABORT,'writer_v2_facts_append_only'); END",
    "CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END",
    "CREATE TRIGGER admission_no_reopen BEFORE UPDATE ON admission WHEN OLD.mode='closed' BEGIN SELECT RAISE(ABORT,'writer_v2_admission_permanent'); END"
  ],
  "autoindex_columns": {
    "workers_1": [
      "worker_id"
    ],
    "workers_2": [
      "generation_token"
    ],
    "tasks_1": [
      "task_id"
    ],
    "operations_1": [
      "operation_id"
    ],
    "operations_2": [
      "task_id"
    ],
    "operations_3": [
      "invocation_id"
    ],
    "steps_1": [
      "step_id"
    ],
    "steps_2": [
      "operation_id",
      "ordinal"
    ],
    "bindings_1": [
      "step_id"
    ],
    "step_results_1": [
      "step_id"
    ],
    "terminals_1": [
      "operation_id"
    ],
    "audit_facts_1": [
      "hash"
    ]
  }
});
const POSITIVE = freeze({
  "claim": {
    "dispatchId": "dispatch_bind_fixture",
    "traceId": "trace_bind_fixture",
    "ownerToken": "owner_bind_fixture",
    "claimEpoch": 1,
    "fencingEpoch": 1,
    "rootRunId": "run_bind_root"
  },
  "usageRun": {
    "runId": "run_bind_child",
    "traceId": "trace_bind_fixture"
  },
  "terminalRun": {
    "runId": "run_bind_root",
    "traceId": "trace_bind_fixture"
  },
  "rows": {
    "source": [],
    "topic": [
      {
        "id": "topic_bind_fixture",
        "name": "synthetic",
        "language": "zh",
        "brief_schedule": "daily"
      }
    ],
    "run": [
      {
        "id": "run_bind_root",
        "kind": "analyze",
        "target": "{\"topic_id\":\"topic_bind_fixture\"}",
        "status": "running",
        "started_at": "2026-10-12T00:00:00.000Z",
        "trace_id": "trace_bind_fixture"
      },
      {
        "id": "run_bind_child",
        "kind": "validate",
        "target": "{\"topic_id\":\"topic_bind_fixture\"}",
        "status": "running",
        "started_at": "2026-10-12T00:00:00.000Z",
        "trace_id": "trace_bind_fixture"
      }
    ],
    "generation_trace": [
      {
        "id": "trace_bind_fixture",
        "request_id": "request_bind_fixture",
        "scope_kind": "topic_pipeline",
        "trigger_kind": "api",
        "topic_id": "topic_bind_fixture",
        "root_run_id": "run_bind_root",
        "status": "running",
        "completion_policy": "{}",
        "started_at": "2026-10-12T00:00:00.000Z"
      }
    ],
    "generation_trace_request": [
      {
        "id": "request_bind_fixture",
        "scope_key": "bind_fixture_scope",
        "active_key": "bind_fixture_active",
        "trace_id": "trace_bind_fixture",
        "state": "accepted",
        "retained_until": "2099-01-01T00:00:00.000Z",
        "created_at": "2026-10-12T00:00:00.000Z"
      }
    ],
    "generation_dispatch": [
      {
        "id": "dispatch_bind_fixture",
        "request_id": "request_bind_fixture",
        "trace_id": "trace_bind_fixture",
        "kind": "topic_pipeline",
        "payload": "{\"schema_version\":1,\"topic_id\":\"topic_bind_fixture\",\"planning\":false,\"report_type\":\"brief\"}",
        "state": "claimed",
        "attempt": 1,
        "claim_epoch": 1,
        "owner_token": "owner_bind_fixture",
        "lease_expires_at": "2099-01-01T00:00:00.000Z",
        "created_at": "2026-10-12T00:00:00.000Z",
        "updated_at": "2026-10-12T00:00:00.000Z"
      }
    ],
    "generation_lease": [
      {
        "id": "lease_bind_fixture",
        "active_key": "bind_fixture_active",
        "scope_key": "bind_fixture_scope",
        "trace_id": "trace_bind_fixture",
        "state": "owned",
        "owner_token": "owner_bind_fixture",
        "fencing_epoch": 1,
        "expires_at": "2099-01-01T00:00:00.000Z",
        "created_at": "2026-10-12T00:00:00.000Z"
      }
    ]
  },
  "setup_order": [
    "source",
    "topic",
    "run",
    "generation_trace",
    "generation_trace_request",
    "generation_dispatch",
    "generation_lease"
  ],
  "test_setup_only": true,
  "execute_now": false
});
const SELECT = "SELECT d.id AS dispatch_id,d.trace_id,d.owner_token,d.claim_epoch,l.fencing_epoch,\n       t.root_run_id,child.id AS run_id,child.trace_id AS run_trace_id,child.status AS run_status\nFROM generation_dispatch d\nJOIN generation_lease l ON l.trace_id=d.trace_id\nJOIN generation_trace t ON t.id=d.trace_id\nJOIN run root ON root.id=t.root_run_id\nJOIN run child ON child.id=@run_id AND child.trace_id=t.id\nWHERE d.id=@dispatch_id AND d.trace_id=@trace_id AND d.state='claimed'\n  AND d.owner_token=@owner_token AND d.claim_epoch=@claim_epoch AND d.lease_expires_at>=@now_iso\n  AND l.state='owned' AND l.owner_token=@owner_token AND l.fencing_epoch=@fencing_epoch AND l.expires_at>=@now_iso\n  AND t.root_run_id=@root_run_id AND root.trace_id=t.id\n  AND (@purpose='terminal' OR child.status='running')\n  AND (@purpose='usage' OR child.id=root.id)";
const BUSINESS_HASH = 'cc57b8b610500d9b57f0a41ead782df4a4ea7eaef359c87eda94adbcfd44a5c3';
const REGISTRY_HASH = 'ca0a81b1ada410e0f52d9d3be233377771e7f959b405ac81cbf3e855c7427e5d';
const SELECT_HASH = 'd26881b619b0918acb4176b751a98728a7d314be9b04943ae4cb6be573e1a2dc';
assert.equal(hash(canonical(BUSINESS)), BUSINESS_HASH);
assert.equal(hash(canonical(REGISTRY)), REGISTRY_HASH);
assert.equal(hash(SELECT), SELECT_HASH);
const MAX_DATABASES = 48, MAX_BYTES = 16 * 1024 * 1024, MAX_PROOF = 128 * 1024;
// 32*4096 byte DB + <=32*(4096+8)+512 rollback journal, at most 48 fixtures.
const PER_FIXTURE_BOUND = 32 * 4096 + 32 * (4096 + 8) + 512;
assert(MAX_DATABASES * PER_FIXTURE_BOUND < MAX_BYTES);
let constructors = 0, proofBytes = 0, stoppedAfter = null;
const unsupported = ['admission', 'opaque-cap', 'signal-brand', 'COMMIT-ACK', 'replay', 'cancel', 'producer', 'whole-dispatch', 'writer-quiescence', 'production'];
function proof(t, name, detail) {
  const line = JSON.stringify({ proof: 'dispatch-bind-native-fixture-v1', case: name, ...detail, unsupported });
  proofBytes += Buffer.byteLength(line + '\n'); assert(proofBytes <= MAX_PROOF, 'proof_stdout_budget');
  t.diagnostic(line);
}
function identity(path, directory = false) {
  const s = fs.lstatSync(path, { bigint: true });
  assert(directory ? s.isDirectory() : s.isFile(), 'ordinary_owned_type');
  assert.equal(s.uid, BigInt(process.getuid()), 'owned_uid');
  if (!directory) assert.equal(s.nlink, 1n, 'ordinary_owned_link');
  assert.equal(s.mode & 0o777n, directory ? 0o700n : 0o600n, 'owned_mode');
  return { dev: s.dev, ino: s.ino, uid: s.uid };
}
function same(path, expected, directory = false) {
  assert.deepEqual(identity(path, directory), expected, 'owned_inode_changed');
}
function openFixture(kind) {
  assert(++constructors <= MAX_DATABASES, 'native_constructor_budget');
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'dispatch-bind-fixture-v3-'));
  const path = join(root, 'fixture.sqlite');
  let db;
  try {
    fs.chmodSync(root, 0o700); const rootIdentity = identity(root, true);
    let fd, allocationError;
    try {
      fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      fs.fsyncSync(fd);
    } catch (error) { allocationError = error; }
    finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (error) { allocationError ??= error; }
      }
    }
    if (allocationError) throw allocationError;
    const fileIdentity = identity(path);
    db = new Database(path); same(root, rootIdentity, true); same(path, fileIdentity);
    db.pragma('busy_timeout = 0'); db.pragma('page_size = 4096'); db.pragma('max_page_count = 32');
    db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON'); db.pragma('temp_store = MEMORY');
    const manifest = kind === 'registry' ? REGISTRY : BUSINESS;
    db.pragma(`application_id = ${manifest.application_id}`); db.pragma(`user_version = ${manifest.user_version}`);
    if (kind === 'registry') {
      for (const sql of REGISTRY.tables) db.exec(sql);
      for (const sql of REGISTRY.triggers) db.exec(sql);
    } else {
      for (const object of BUSINESS.objects.filter(x => x.type === 'table')) db.exec(object.sql);
      for (const object of BUSINESS.objects.filter(x => x.type === 'index' && x.sql !== null)) db.exec(object.sql);
      db.transaction(() => {
        for (const table of POSITIVE.setup_order) for (const row of POSITIVE.rows[table]) {
          const columns = Object.keys(row); assert(columns.every(key => /^[a-z_]+$/.test(key)));
          db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
        }
      })();
    }
    assert.equal(db.pragma('max_page_count', { simple: true }), 32);
    assert.equal(db.pragma('page_size', { simple: true }), 4096);
    if (kind === 'registry') verifyRegistry(db); else verifyBusiness(db);
    return { db, root, path, rootIdentity, fileIdentity };
  } catch (error) {
    try { db?.close(); } catch { /* Unknown close retains this newly owned root. */ }
    const preserved = new Error(`preserved ${root}: ${error.message}`, { cause: error });
    preserved.retainedRoot = root; throw preserved;
  }
}
function dispose(f, success) {
  // Close first; never repair or recursively delete an unknown/failed fixture.
  f.db.close();
  if (!success) return { retained: f.root };
  same(f.root, f.rootIdentity, true); same(f.path, f.fileIdentity);
  assert(fs.statSync(f.path).size <= 32 * 4096, 'owned_file_size_budget');
  assert.deepEqual(fs.readdirSync(f.root), ['fixture.sqlite'], 'unknown_sidecar_preserved');
  fs.unlinkSync(f.path); fs.rmdirSync(f.root); return { removed: 'exact-owned-inode-after-close' };
}
function nativeCase(name, kind, body) {
  test('dispatch fixture v3: ' + name, { timeout: 30000, concurrency: false }, t => {
    assert.equal(stoppedAfter, null, `validation_stopped_after_${stoppedAfter}`);
    let f, closed = false;
    try {
      f = openFixture(kind); const detail = body(f.db);
      const cleanup = dispose(f, true); closed = true;
      proof(t, name, { ...detail, cleanup, databaseConstructions: constructors });
    } catch (error) {
      stoppedAfter = name;
      if (f && !closed) {
        try { if (f.db.open) f.db.close(); } catch { /* Preserve unknown close. */ }
        proof(t, name + ': retained', { retained: f.root, error: String(error.message).slice(0, 1024) });
      } else if (!f) {
        proof(t, name + ': retained', { retained: error.retainedRoot ?? 'unknown-new-root', error: String(error.message).slice(0, 1024) });
      }
      throw error;
    }
  });
}
function objects(db) { return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name').all(); }
function configuration(db) {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys_required');
  assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const databases = db.pragma('database_list'); assert.equal(databases.length, 1); assert.equal(databases[0].name, 'main');
  assert.equal(databases[0].file, db.name, 'same_original_fixture_connection');
  return { application_id: db.pragma('application_id', { simple: true }), user_version: db.pragma('user_version', { simple: true }) };
}
function verifyBusiness(db) {
  const actual = { format: BUSINESS.format, ...configuration(db), objects: objects(db) };
  assert.deepEqual(actual, BUSINESS, 'business_exact_metadata_mismatch');
  assert.equal(hash(canonical(actual)), BUSINESS_HASH);
  return actual;
}
function registryExpectedObjects() {
  const names = sql => sql.split(' ')[2];
  const expected = REGISTRY.tables.map(sql => ({ type: 'table', name: names(sql), tbl_name: names(sql), sql }));
  for (const sql of REGISTRY.triggers) {
    const table = sql.split(' ON ')[1].split(' ')[0];
    expected.push({ type: 'trigger', name: names(sql), tbl_name: table, sql });
  }
  for (const key of Object.keys(REGISTRY.autoindex_columns)) {
    const table = key.slice(0, key.lastIndexOf('_'));
    expected.push({ type: 'index', name: 'sqlite_autoindex_' + key, tbl_name: table, sql: null });
  }
  return expected.sort((a,b) => { const x = [a.type,a.name,a.tbl_name].join('\0'), y = [b.type,b.name,b.tbl_name].join('\0'); return x < y ? -1 : x > y ? 1 : 0; });
}
function verifyRegistry(db) {
  const headers = configuration(db); assert.equal(headers.application_id, REGISTRY.application_id); assert.equal(headers.user_version, 3);
  const actualObjects = objects(db); assert.deepEqual(actualObjects, registryExpectedObjects(), 'registry_exact_metadata_mismatch');
  const columns = {};
  for (const key of Object.keys(REGISTRY.autoindex_columns)) columns[key] = db.pragma(`index_info(sqlite_autoindex_${key})`).map(row => row.name);
  assert.deepEqual(columns, REGISTRY.autoindex_columns);
  return { headers, objects: actualObjects, autoindex_columns: columns, manifest_hash: REGISTRY_HASH };
}
function params(purpose = 'usage') {
  assert(['usage','terminal'].includes(purpose), 'test_setup_valid_purpose');
  const claim = POSITIVE.claim;
  return { dispatch_id: claim.dispatchId, trace_id: claim.traceId, owner_token: claim.ownerToken, claim_epoch: claim.claimEpoch,
    fencing_epoch: claim.fencingEpoch, root_run_id: claim.rootRunId, run_id: purpose === 'usage' ? POSITIVE.usageRun.runId : POSITIVE.terminalRun.runId,
    purpose, now_iso: new Date().toISOString() };
}
function select(db, p) { return db.prepare(SELECT).all(p); }
function positive(db, p, expectedRunStatus = 'running') {
  verifyBusiness(db); const rows = select(db, p); assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['dispatch_id','trace_id','owner_token','claim_epoch','fencing_epoch','root_run_id','run_id','run_trace_id','run_status'].sort());
  assert.deepEqual(rows[0], { dispatch_id: p.dispatch_id, trace_id: p.trace_id, owner_token: p.owner_token, claim_epoch: p.claim_epoch,
    fencing_epoch: p.fencing_epoch, root_run_id: p.root_run_id, run_id: p.run_id, run_trace_id: p.trace_id,
    run_status: expectedRunStatus });
  return rows;
}
nativeCase('registry exact 10 tables 20 triggers 12 indices header3', 'registry', db => ({ actual: verifyRegistry(db) }));
nativeCase('business exact 20 objects current-clock usage child', 'business', db => {
  const actual = verifyBusiness(db), p = params(); const rows = positive(db,p), next = params(); assert(next.now_iso >= p.now_iso); positive(db,next);
  return { actual, SELECT_HASH, clocks: [p.now_iso,next.now_iso], rows };
});
nativeCase('terminal root done remains valid with owned lease', 'business', db => {
  db.prepare('UPDATE run SET status=? WHERE id=?').run('done', POSITIVE.claim.rootRunId); const p = params('terminal'); return { rows: positive(db,p,'done'), clock: p.now_iso };
});
nativeCase('SQL alone does not authenticate purpose enum', 'business', db => {
  const p = { ...params('terminal'), purpose: 'untyped-invalid' }; assert.equal(select(db,p).length,1);
  assert.throws(() => params('untyped-invalid'), /test_setup_valid_purpose/); return { SQL_alone_accepts_invalid_purpose: true, runtime_purpose_guard: 'not_implemented' };
});
for (const key of ['dispatch_id','trace_id','owner_token','claim_epoch','fencing_epoch','root_run_id','run_id']) {
  nativeCase('bound parameter mismatch ' + key, 'business', db => {
    const p = params(); p[key] = typeof p[key] === 'number' ? p[key] + 1 : p[key] + '_other'; assert.deepEqual(select(db,p),[]); return { mismatch: key, rows: [] };
  });
}
const rowNegatives = [
  ['dispatch token', "UPDATE generation_dispatch SET owner_token='wrong'"],
  ['dispatch epoch', 'UPDATE generation_dispatch SET claim_epoch=2'],
  ['dispatch state', "UPDATE generation_dispatch SET state='queued'"],
  ['lease token', "UPDATE generation_lease SET owner_token='wrong'"],
  ['lease epoch', 'UPDATE generation_lease SET fencing_epoch=2'],
  ['lease state', "UPDATE generation_lease SET state='released'"],
  ['trace root', "UPDATE generation_trace SET root_run_id='run_bind_child'"],
  ['root trace', "UPDATE run SET trace_id='wrong' WHERE id='run_bind_root'"],
  ['child trace', "UPDATE run SET trace_id='wrong' WHERE id='run_bind_child'"],
  ['usage child status', "UPDATE run SET status='done' WHERE id='run_bind_child'"]
];
for (const [name,sql] of rowNegatives) nativeCase('native row mismatch ' + name, 'business', db => {
  db.exec(sql); assert.deepEqual(db.pragma('foreign_key_check'),[]); const p=params(); assert.deepEqual(select(db,p),[]); return { mismatch: name, clock:p.now_iso, rows:[] };
});
for (const [table,column] of [['generation_dispatch','lease_expires_at'],['generation_lease','expires_at']]) {
  nativeCase('expiry boundary and elapsed ' + table, 'business', db => {
    const p=params(); db.prepare(`UPDATE ${table} SET ${column}=?`).run(p.now_iso); assert.equal(select(db,p).length,1);
    db.prepare(`UPDATE ${table} SET ${column}=?`).run(new Date(Date.parse(p.now_iso)-1).toISOString()); assert.deepEqual(select(db,p),[]);
    return { equality_allowed:true, elapsed_denied:true, clock:p.now_iso };
  });
}
nativeCase('terminal child instead of root denied', 'business', db => {
  const p={...params('terminal'),run_id:POSITIVE.usageRun.runId}; assert.deepEqual(select(db,p),[]); return { rows:[] };
});
for (const [name,sql] of [
  ['extra table','CREATE TABLE unexpected_object (id TEXT)'],
  ['missing explicit index','DROP INDEX idx_generation_lease_active'],
  ['changed table SQL','ALTER TABLE topic ADD COLUMN unexpected_column TEXT'],
  ['changed application id','PRAGMA application_id=1'],
  ['changed user version','PRAGMA user_version=99']
]) nativeCase('full business metadata rejects ' + name, 'business', db => {
  db.exec(sql); assert.throws(() => verifyBusiness(db), /business_exact_metadata_mismatch/); return { mismatch:name, rejected:true };
});
nativeCase('native foreign key ON rejects invalid fixture reference', 'business', db => {
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  assert.throws(() => db.prepare('UPDATE generation_dispatch SET trace_id=?').run('missing_trace'), /FOREIGN KEY constraint failed/);
  return { foreign_keys:1, rows:positive(db,params()) };
});
nativeCase('registry header and extra objects cannot masquerade as exact profile', 'registry', db => {
  db.pragma('user_version=2'); assert.throws(() => verifyRegistry(db)); db.pragma('user_version=3');
  db.exec('CREATE TABLE unexpected_object (id TEXT)'); assert.throws(() => verifyRegistry(db), /registry_exact_metadata_mismatch/);
  return { header2_rejected:true, extra_object_rejected:true };
});

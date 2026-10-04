/** D1 design counterexamples. Keep separate from the frozen 63-test preflight. */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { openLocalBootstrapDb } from "./local-bootstrap.js";
import { readCurrentSessionUser } from "./auth-reader.js";
import { upsertUser } from "./users.js";

const ledger = (JSON.parse(readFileSync(new URL("../../../tests/fixtures/d1-main-v48-database-contract.json", import.meta.url), "utf8")) as { ledger: unknown[] }).ledger;
const connections = new Set<DB>();
let root: string;
function own(db: DB) { connections.add(db); return db; }
function prefixFile(count: number) {
  const db = own(openDb(":memory:"));
  db.exec("CREATE TABLE schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TRIGGER d1_boundary BEFORE INSERT ON schema_migration
    WHEN (SELECT COUNT(*) FROM schema_migration) >= ${count}
    BEGIN SELECT RAISE(ABORT, 'd1_prefix_boundary'); END`);
  expect(() => applyProvenanceMigrations(db)).toThrow("d1_prefix_boundary");
  expect(db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all()).toEqual(ledger.slice(0, count));
  db.exec("DROP TRIGGER d1_boundary");
  const path = join(root, "fixture.sqlite"); db.prepare("VACUUM INTO ?").run(path); db.close();
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ia-d1-boundary-"));
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", undefined);
  vi.stubEnv("AUTH_SECRET", "synthetic-d1-auth-secret");
  vi.stubEnv("ADMIN_EMAIL", "admin@example.test"); vi.stubEnv("ADMIN_PASSWORD", "synthetic-password");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections) if (db.open) db.close();
  connections.clear(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it("raw archive v40 BEGIN lock failure must restore foreign_keys", () => {
  const path = prefixFile(39);
  const runner = own(openDb(path, { bootstrap: false })); runner.pragma("busy_timeout=1");
  const holder = own(new Database(path)); holder.exec("BEGIN IMMEDIATE");
  const before = runner.prepare("SELECT * FROM schema_migration ORDER BY version").all();
  try {
    expect(() => applyProvenanceMigrations(runner)).toThrow(/locked/);
    expect(runner.prepare("SELECT * FROM schema_migration ORDER BY version").all()).toEqual(before);
    expect(runner.inTransaction).toBe(false);
    expect(runner.pragma("foreign_keys", { simple: true })).toBe(1);
  } finally { holder.exec("ROLLBACK"); }
}, 30_000);

it("runner BEGIN rejection must not roll back a transaction owned by its caller", () => {
  const db = own(openDb(prefixFile(47), { bootstrap: false }));
  db.exec("BEGIN; CREATE TABLE d1_caller_owned (value TEXT); INSERT INTO d1_caller_owned VALUES ('pending')");
  try {
    expect(() => applyProvenanceMigrations(db)).toThrow(/within a transaction/);
    expect(db.inTransaction).toBe(true);
    expect(db.prepare("SELECT value FROM d1_caller_owned").get()).toEqual({ value: "pending" });
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); }
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='d1_caller_owned'").get()).toBeUndefined();
  applyProvenanceMigrations(db);
  expect(db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all()).toEqual(ledger);
}, 30_000);

it("local bootstrap metadata failure must close its owned connection", () => {
  const path = prefixFile(47);
  const fixture = own(openDb(path, { bootstrap: false })); applyProvenanceMigrations(fixture);
  fixture.exec("CREATE TRIGGER d1_meta_fail BEFORE INSERT ON provenance_meta BEGIN SELECT RAISE(ABORT, 'd1_meta_failure'); END"); fixture.close();
  const observed = new Set<DB>(), original = Database.prototype.pragma;
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: DB, ...args: Parameters<DB["pragma"]>) {
    own(this); observed.add(this); return original.apply(this, args);
  });
  expect(() => openLocalBootstrapDb(path)).toThrow("d1_meta_failure");
  expect(observed.size).toBe(1);
  for (const db of observed) expect(db.open).toBe(false);
}, 30_000);

it("live WAL authentication must see password and role changes not yet checkpointed", () => {
  const path = join(root, "auth.sqlite"), writer = own(openDb(path));
  writer.pragma("wal_autocheckpoint=0");
  upsertUser(writer, "viewer@example.test", "old-synthetic-password", "viewer");
  writer.pragma("wal_checkpoint(TRUNCATE)");
  const old = readCurrentSessionUser("viewer@example.test", path)!;
  const checkpointed = readFileSync(path);
  upsertUser(writer, "viewer@example.test", "new-synthetic-password", "admin");
  expect(readFileSync(path)).toEqual(checkpointed);
  const current = readCurrentSessionUser("viewer@example.test", path)!;
  expect(current.role).toBe("admin");
  expect(current.sessionVersion).not.toBe(old.sessionVersion);
});

/** D1 protection tests written against unchanged main before extraction.
 * All data is synthetic. Prefixes are actual runner commits, not old binary backups. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, openDb, openReadonlyDb, type DB } from "./index.js";
import { applyProvenanceMigrations, assertProvenanceSchema } from "./provenance-migrations.js";
import { readCurrentSessionUser } from "./auth-reader.js";
import { openLocalBootstrapDb } from "./local-bootstrap.js";
import { listModelUsageAttempts } from "./model-usage.js";

interface LedgerRow { version: string; checksum: string }
const baseline = JSON.parse(readFileSync(new URL("../../../tests/fixtures/d1-main-v48-database-contract.json", import.meta.url), "utf8")) as { ledger: LedgerRow[]; schema: unknown[] };
const historical = JSON.parse(readFileSync(new URL("../../../tests/fixtures/c3-v47-migration-checksums.json", import.meta.url), "utf8")) as { ledger: LedgerRow[] };
const connections: DB[] = [];
let root: string;
function own(db: DB): DB { connections.push(db); return db; }
function schema(db: DB) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); }
function ledger(db: DB) { return db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all(); }
function state(db: DB) { return { schema: schema(db), ledger: db.prepare("SELECT * FROM schema_migration ORDER BY version").all(), userVersion: db.pragma("user_version", { simple: true }) }; }
function files() { return readdirSync(root).sort().map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(root, name))).digest("hex"), mtime: statSync(join(root, name)).mtimeMs })); }

beforeEach(() => {
  closeDb(); root = mkdtempSync(join(tmpdir(), "ia-d1-contract-"));
  vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", undefined);
  vi.stubEnv("PROVENANCE_DEPLOYMENT_REQUIRED", undefined);
  vi.stubEnv("PROVENANCE_DEPLOYMENT_WRITER", undefined);
  vi.stubEnv("DB_PATH", join(root, "singleton.sqlite"));
  vi.stubEnv("AUTH_SECRET", "synthetic-d1-auth-secret");
  vi.stubEnv("ADMIN_EMAIL", "admin@example.test");
  vi.stubEnv("ADMIN_PASSWORD", "synthetic-password");
});
afterEach(() => {
  closeDb(); connections.splice(0).forEach((db) => { if (db.open) db.close(); });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

/** Stop the unmodified runner at a real ledger commit boundary. The next
 * migration's DDL rolls back with its failing ledger insert. */
function prefix(count: number): DB {
  const db = own(openDb(":memory:"));
  db.exec("CREATE TABLE schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TRIGGER d1_stop BEFORE INSERT ON schema_migration
    WHEN (SELECT COUNT(*) FROM schema_migration) >= ${count}
    BEGIN SELECT RAISE(ABORT, 'd1_prefix_boundary'); END`);
  expect(() => applyProvenanceMigrations(db)).toThrow("d1_prefix_boundary");
  expect(ledger(db)).toEqual(baseline.ledger.slice(0, count));
  expect(db.inTransaction).toBe(false);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  db.exec("DROP TRIGGER d1_stop");
  return db;
}

function fileFromPrefix(count: number, name = "fixture.sqlite"): string {
  const db = prefix(count), path = join(root, name);
  db.prepare("VACUUM INTO ?").run(path); db.close();
  return path;
}

describe("D1 immutable runner contracts", () => {
  it.each(Array.from({ length: 48 }, (_, count) => ({ count })))
    ("fresh / v$count prefix upgrades through the real file runner to frozen v48", ({ count }) => {
      const path = fileFromPrefix(count);
      const db = own(openDb(path, { bootstrap: false }));
      applyProvenanceMigrations(db);
      expect(schema(db)).toEqual(baseline.schema);
      expect(ledger(db)).toEqual(baseline.ledger);
      expect(ledger(db).slice(0, 47)).toEqual(historical.ledger);
      expect(db.inTransaction).toBe(false);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      const before = state(db);
      applyProvenanceMigrations(db);
      expect(state(db)).toEqual(before);
      db.close();
      const reopened = own(openReadonlyDb(path));
      expect(schema(reopened)).toEqual(baseline.schema);
      expect(ledger(reopened)).toEqual(baseline.ledger);
    }, 30_000);

  it("ledger insert failure rolls back v48 DDL, keeps committed v47, and allows retry", () => {
    const db = own(openDb(fileFromPrefix(47), { bootstrap: false }));
    db.exec("CREATE TRIGGER d1_fail BEFORE INSERT ON schema_migration BEGIN SELECT RAISE(ABORT, 'd1_ledger_failure'); END");
    const before = state(db);
    expect(() => applyProvenanceMigrations(db)).toThrow("d1_ledger_failure");
    expect(state(db)).toEqual(before);
    expect(listModelUsageAttempts(db, "synthetic-run").available).toBe(false);
    db.exec("DROP TRIGGER d1_fail"); applyProvenanceMigrations(db);
    expect(listModelUsageAttempts(db, "synthetic-run").available).toBe(true);
  }, 30_000);

  it("BEGIN lock failure must restore foreign_keys before runner retry", () => {
    const path = fileFromPrefix(12);
    const runner = own(openDb(path, { bootstrap: false })); runner.pragma("busy_timeout=1");
    const holder = own(new Database(path)); holder.exec("BEGIN IMMEDIATE");
    const before = state(runner);
    try {
      expect(() => applyProvenanceMigrations(runner)).toThrow(/locked/);
      expect(runner.inTransaction).toBe(false);
      expect(state(runner)).toEqual(before);
      expect(runner.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { holder.exec("ROLLBACK"); }
  }, 30_000);

  it("rejects historical checksum mismatch without repairing the ledger", () => {
    const db = own(openDb(fileFromPrefix(47), { bootstrap: false }));
    db.prepare("UPDATE schema_migration SET checksum='synthetic-mismatch' WHERE version=?").run(baseline.ledger[0].version);
    const before = state(db);
    expect(() => applyProvenanceMigrations(db)).toThrow(/checksum mismatch/);
    expect(state(db)).toEqual(before);
  });

  it("missing core ledger with existing core DDL is rejected atomically by explicit runner", () => {
    const db = own(openDb(fileFromPrefix(47), { bootstrap: false }));
    db.prepare("DELETE FROM schema_migration WHERE version=?").run(baseline.ledger[0].version);
    const before = state(db);
    expect(() => applyProvenanceMigrations(db)).toThrow(/already exists/);
    expect(state(db)).toEqual(before);
  });
});

describe("D1 startup compatibility", () => {
  it("strict startup rejects an unmigrated real file without adding schema or ledger", () => {
    const path = fileFromPrefix(47);
    vi.stubEnv("DB_PATH", path); vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", "1");
    const read = own(openReadonlyDb(path)); const before = state(read); read.close();
    const close = vi.spyOn(Database.prototype, "close");
    expect(getDb).toThrow(/has not been applied/); expect(getDb).toThrow(/has not been applied/);
    expect(close).toHaveBeenCalledTimes(2);
    const db = own(openDb(path, { bootstrap: false })); expect(state(db)).toEqual(before);
    applyProvenanceMigrations(db); db.close();
    expect(getDb().open).toBe(true); expect(getDb()).toBe(getDb());
  }, 30_000);

  it("strict fresh startup creates no schema and rejects a corrupt latest ledger", () => {
    const path = join(root, "strict.sqlite");
    vi.stubEnv("DB_PATH", path); vi.stubEnv("PROVENANCE_SCHEMA_REQUIRED", "1");
    expect(getDb).toThrow(/has not been applied/);
    const empty = own(new Database(path)); expect(schema(empty)).toEqual([]); empty.close();
    const seed = own(openDb(path)); applyProvenanceMigrations(seed);
    seed.prepare("UPDATE schema_migration SET checksum='synthetic-mismatch' WHERE version=?").run(baseline.ledger.at(-1)!.version); seed.close();
    expect(getDb).toThrow(/checksum mismatch/); expect(getDb).toThrow(/checksum mismatch/);
  }, 30_000);

  it("failed explicit local bootstrap must close its owned connection", () => {
    vi.stubEnv("NODE_ENV", "test");
    const path = fileFromPrefix(47);
    const fixture = own(openDb(path, { bootstrap: false }));
    fixture.exec("CREATE TRIGGER d1_fail BEFORE INSERT ON schema_migration BEGIN SELECT RAISE(ABORT, 'd1_local_migration_failure'); END"); fixture.close();
    const observed = new Set<DB>();
    const originalPragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: DB, ...args: Parameters<DB["pragma"]>) {
      observed.add(this); own(this); return originalPragma.apply(this, args);
    });
    expect(() => openLocalBootstrapDb(path)).toThrow("d1_local_migration_failure");
    expect(observed.size).toBe(1);
    for (const db of observed) expect(db.open).toBe(false);
  }, 30_000);

  it("latest-only startup ledger check remains distinct from historical runner validation", () => {
    const db = own(openDb(":memory:")); applyProvenanceMigrations(db);
    db.prepare("UPDATE schema_migration SET checksum='synthetic-mismatch' WHERE version=?").run(baseline.ledger[0].version);
    expect(() => assertProvenanceSchema(db)).not.toThrow();
    expect(() => applyProvenanceMigrations(db)).toThrow(/checksum mismatch/);
    db.prepare("DELETE FROM schema_migration WHERE version=?").run(baseline.ledger.at(-1)!.version);
    expect(() => assertProvenanceSchema(db)).toThrow(/has not been applied/);
  });

  it("singleton stays at its published path; independent connections and close/reopen do not mix files", () => {
    const a = getDb(), pathB = join(root, "independent.sqlite");
    a.exec("CREATE TABLE d1_identity (label TEXT); INSERT INTO d1_identity VALUES ('a')");
    const b = own(openDb(pathB)); b.exec("CREATE TABLE d1_identity (label TEXT); INSERT INTO d1_identity VALUES ('b')");
    vi.stubEnv("DB_PATH", pathB);
    expect(getDb()).toBe(a);
    expect(getDb().prepare("SELECT label FROM d1_identity").get()).toEqual({ label: "a" });
    expect(b.prepare("SELECT label FROM d1_identity").get()).toEqual({ label: "b" });
    closeDb(); expect(a.open).toBe(false); expect(b.open).toBe(true); expect(closeDb).not.toThrow();
    const next = getDb(); expect(next).not.toBe(a); expect(next).not.toBe(b);
    expect(next.prepare("SELECT label FROM d1_identity").get()).toEqual({ label: "b" });
  });
});

describe("D1 read-only boundaries", () => {
  it.each([0, 47, 48])("v%i reader preserves real DELETE-mode file and database state", (count) => {
    const path = count < 48 ? fileFromPrefix(count) : join(root, "fixture.sqlite");
    if (count === 48) {
      const db = own(openDb(":memory:")); applyProvenanceMigrations(db); db.prepare("VACUUM INTO ?").run(path); db.close();
    }
    const read = own(openReadonlyDb(path)); const before = state(read), beforeFiles = files();
    expect(readCurrentSessionUser("nobody@example.test", path)).toBeNull();
    expect(listModelUsageAttempts(read, "synthetic-run")).toEqual({ available: count === 48, attempts: [] });
    expect(() => read.exec("CREATE TABLE d1_forbidden_write (id TEXT)")).toThrow(/readonly/);
    expect(state(read)).toEqual(before); read.close(); expect(files()).toEqual(beforeFiles);
  }, 30_000);

  it("missing reader never creates parent or file; empty reader never bootstraps tables", () => {
    const missing = join(root, "missing", "db.sqlite");
    expect(() => readCurrentSessionUser("nobody@example.test", missing)).toThrow(); expect(files()).toEqual([]);
    const path = join(root, "empty.sqlite"); const empty = own(new Database(path)); empty.close(); const before = files();
    expect(() => readCurrentSessionUser("nobody@example.test", path)).toThrow(); expect(files()).toEqual(before);
  });

  // User-approved boundary: SQLite may coordinate WAL sidecars; the reader
  // must not write application schema/ledger/data or the main database file.
  it.each([47, 48])("v%i WAL authentication reader preserves main file and application state", (count) => {
    const path = fileFromPrefix(47); const db = own(openDb(path, { bootstrap: false }));
    if (count === 48) applyProvenanceMigrations(db);
    const beforeState = state(db); db.close();
    const before = files().find((entry) => entry.name === "fixture.sqlite");
    expect(readCurrentSessionUser("nobody@example.test", path)).toBeNull();
    expect(files().find((entry) => entry.name === "fixture.sqlite")).toEqual(before);
    const reader = own(openReadonlyDb(path));
    expect(state(reader)).toEqual(beforeState);
    expect(listModelUsageAttempts(reader, "synthetic-run")).toEqual({ available: count === 48, attempts: [] });
  }, 30_000);
});

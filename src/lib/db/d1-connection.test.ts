import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openConnection, openReadonlyDb, type DB } from "./connection.js";

let root: string;
const connections = new Set<DB>();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ia-d1-connection-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections) if (db.open) db.close();
  connections.clear();
  rmSync(root, { recursive: true, force: true });
});

it("connection creation configures SQLite without creating application schema or ledger", () => {
  const db = openConnection(join(root, "nested", "connection.sqlite")); connections.add(db);
  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("busy_timeout", { simple: true })).toBe(5_000);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
  db.close();
  const reader = openReadonlyDb(join(root, "nested", "connection.sqlite")); connections.add(reader);
  expect(reader.pragma("query_only", { simple: true })).toBe(1);
  expect(reader.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
  expect(() => reader.exec("CREATE TABLE forbidden (id TEXT)")).toThrow(/readonly/);
});

it.each(["writer", "reader"] as const)("a %s configuration failure closes the real connection and preserves its root error", (mode) => {
  const path = join(root, "connection.sqlite");
  const fixture = new Database(path); fixture.close();
  const rootError = new Error("d1_configuration_failure");
  const originalPragma = Database.prototype.pragma;
  const originalClose = Database.prototype.close;
  const observed = new Set<DB>();
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: DB, ...args: Parameters<DB["pragma"]>) {
    connections.add(this); observed.add(this);
    if (args[0] === (mode === "writer" ? "foreign_keys = ON" : "query_only=ON")) throw rootError;
    return originalPragma.apply(this, args);
  });
  vi.spyOn(Database.prototype, "close").mockImplementation(function (this: DB) {
    originalClose.call(this);
    throw new Error("d1_secondary_cleanup_failure");
  });
  expect(() => mode === "writer" ? openConnection(path) : openReadonlyDb(path)).toThrow(rootError);
  expect(observed.size).toBe(1);
  for (const db of observed) expect(db.open).toBe(false);
  vi.restoreAllMocks();
  const retry = mode === "writer" ? openConnection(path) : openReadonlyDb(path); connections.add(retry);
  expect(retry.open).toBe(true);
});

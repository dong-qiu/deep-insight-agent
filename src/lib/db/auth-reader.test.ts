import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./index.js";
import { upsertUser } from "./users.js";
import { readCurrentSessionUser } from "./auth-reader.js";

let root: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auth-reader-")); path = join(root, "db.sqlite");
  vi.stubEnv("AUTH_SECRET", "test-secret"); vi.stubEnv("ADMIN_EMAIL", "admin@example.test"); vi.stubEnv("ADMIN_PASSWORD", "admin-password");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("read-only auth DB boundary", () => {
  it("does not create missing files or bootstrap missing schema", () => {
    expect(() => readCurrentSessionUser("admin@example.test", path)).toThrow();
    expect(existsSync(path)).toBe(false);
    const empty = new Database(path); empty.close();
    expect(() => readCurrentSessionUser("admin@example.test", path)).toThrow();
    const check = new Database(path, { readonly: true });
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]); }
    finally { check.close(); }
  });

  it("closes every connection, sees current updates and recovers after query failure", () => {
    const writer = openDb(path);
    try {
      upsertUser(writer, "v@example.test", "password", "viewer");
      const close = vi.spyOn(Database.prototype, "close");
      const original = readCurrentSessionUser("v@example.test", path)!;
      expect(close).toHaveBeenCalledTimes(1);
      upsertUser(writer, "v@example.test", "new-password", "viewer");
      expect(readCurrentSessionUser("v@example.test", path)!.sessionVersion).not.toBe(original.sessionVersion);
      writer.exec("ALTER TABLE app_user RENAME TO unavailable_user");
      expect(() => readCurrentSessionUser("v@example.test", path)).toThrow();
      expect(close).toHaveBeenCalledTimes(3);
      writer.exec("ALTER TABLE unavailable_user RENAME TO app_user");
      expect(readCurrentSessionUser("v@example.test", path)).not.toBeNull();
      expect(close).toHaveBeenCalledTimes(4);
    } finally { writer.close(); }
  });
});

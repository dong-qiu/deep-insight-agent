/** SQLite connections only: no schema replay, migrations, recovery or global cache. */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/** Owned writable connection, configured as before. Caller must initialize or close it. */
export function openConnection(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (error) {
    closeFailedInitialization(db);
    throw error;
  }
}

/** Application-level zero writes. SQLite may coordinate WAL sidecars; live
 * databases must keep locking/change detection so authentication sees updates. */
export function openReadonlyDb(path: string): DB {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 });
  try {
    db.pragma("query_only=ON");
    return db;
  } catch (error) {
    closeFailedInitialization(db);
    throw error;
  }
}

/** Cleanup must not replace the failure that caused initialization to stop. */
export function closeFailedInitialization(db: DB): void {
  try { db.close(); } catch { /* Preserve the original initialization error. */ }
}

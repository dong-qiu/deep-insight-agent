/** Node-only authentication read: never migrate, reconcile or create a missing DB. */
import Database from "better-sqlite3";
import { readSessionUser, type SessionUser } from "./users.js";

export function readCurrentSessionUser(email: string, path = process.env.DB_PATH ?? ".data/insight.db"): SessionUser | null {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 });
  try {
    db.pragma("query_only=ON");
    return readSessionUser(db, email);
  } finally {
    db.close();
  }
}

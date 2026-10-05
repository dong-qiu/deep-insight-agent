/** Node-only authentication read: never migrate, reconcile or create a missing DB. */
import { openReadonlyDb } from "./connection.js";
import { readSessionUser, type SessionUser } from "./users.js";

export function readCurrentSessionUser(email: string, path = process.env.DB_PATH ?? ".data/insight.db"): SessionUser | null {
  const db = openReadonlyDb(path);
  try {
    return readSessionUser(db, email);
  } finally {
    db.close();
  }
}

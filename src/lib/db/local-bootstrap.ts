/** Local-only bootstrap used by the documented `npm run seed -> npm run dev`
 * path.  Unlike SCHEMA_SQL, this also advances the immutable provenance
 * ledger.  Production deployment must continue to use `npm run db:migrate`
 * before app/worker startup. */
import { openDb, type DB } from "./index.js";
import { initializeProvenanceMeta } from "./provenance-facts.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";

export function openLocalBootstrapDb(path: string): DB {
  const db = openDb(path);
  applyProvenanceMigrations(db);
  initializeProvenanceMeta(db);
  return db;
}

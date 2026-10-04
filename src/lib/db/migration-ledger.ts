/** Read-only readiness check. Preserve the existing latest-version gate. */
import { createHash } from "node:crypto";
import type { DB } from "./connection.js";
import { MIGRATIONS } from "./migration-definitions.js";

export function assertProvenanceSchema(db: DB): void {
  const latest = MIGRATIONS.at(-1)!;
  const expected = latest.version;
  const ledgerExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'",
  ).get();
  if (!ledgerExists) throw new Error(`provenance migration ${expected} has not been applied`);
  const row = db.prepare("SELECT checksum FROM schema_migration WHERE version=?").get(expected) as { checksum: string } | undefined;
  if (!row) throw new Error(`provenance migration ${expected} has not been applied`);
  const checksum = createHash("sha256").update(latest.sql).digest("hex");
  if (row.checksum !== checksum) throw new Error(`provenance migration checksum mismatch: ${expected}`);
}

/**
 * Frozen reader-visibility dependency for the P0c-v2 report-reader baseline.
 *
 * This is the visibility portion of `integrity-lifecycle.ts` at
 * b0c14ef36215e2c4c344b1dc2f86631ac06d6ed9. It deliberately has no runtime
 * dependency on the current lifecycle module: changing the current lifecycle
 * implementation must not alter the committed performance baseline.
 */
import type { DB } from "./index.js";

export const P0C_READER_VISIBILITY_SNAPSHOT_VERSION = "p0c-reader-visibility-v1";
export const P0C_READER_VISIBILITY_SNAPSHOT_COMMIT = "b0c14ef36215e2c4c344b1dc2f86631ac06d6ed9";

type LifecycleState = "active" | "delete_pending" | "destroyed";
interface LifecycleRow { reader_state: LifecycleState }

function tableExists(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Exact reader-visibility behavior from the committed P0c baseline. */
export function isP0cBaselineReportReaderVisible(db: DB, reportId: string): boolean {
  if (!tableExists(db, "integrity_report_lifecycle")) return true;
  const row = db.prepare(`SELECT reader_state FROM integrity_report_lifecycle
    WHERE tenant_id='default' AND report_id=?`).get(reportId) as LifecycleRow | undefined;
  return !row || row.reader_state === "active";
}

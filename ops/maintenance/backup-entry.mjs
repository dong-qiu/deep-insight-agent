/** Denied-only consumer. Real all-writer coverage and backup FS are NOT wired. */
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse, requestSchema, same } from './contract.mjs';
import { openBackupStore } from './backup-store.mjs';

const safeInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const inputSchema = requestSchema.omit({ kind: true }).extend({
  schema: z.literal('r2-backup-input-v1'), requestId: z.uuid(), DB_PATH: z.string(), DATA_DIR: z.string(),
  keep: safeInt, includeRaw: z.boolean(), windowMs: safeInt.max(2147483647), deadlineAt: safeInt,
});
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
function denial(code, controlReceipt = 'unknown') {
  return Object.freeze({ kind: 'denied', attemptId: null, code, publication: 'not_attempted',
    controlReceipt, durability: 'not_applicable', positive_admission_ready: false });
}

export function createBackupEntry(root) {
  // Bind the original physical source/control identity, not a new handle after await.
  const store = openBackupStore(root);
  let closed = false;
  async function prepare(raw, signal) {
    const started = performance.now(), wallStarted = Date.now();
    let input, firstStop = null;
    try { aborted.call(signal); input = parse(inputSchema, raw); }
    catch { return denial('backup_input_invalid'); }
    const snapshot = structuredClone(input);
    if (snapshot.DATA_DIR !== root || snapshot.DB_PATH !== join(root, 'fixture-business.sqlite')
      || snapshot.target.dataPath !== root) return denial('backup_target_mismatch');
    const absoluteEnd = Math.min(snapshot.deadlineAt, wallStarted + snapshot.windowMs);
    const monotonicBudget = Math.min(snapshot.windowMs, snapshot.deadlineAt - wallStarted);
    function stop() {
      if (!firstStop && aborted.call(signal)) firstStop = 'backup_cancelled';
      if (!firstStop && (Date.now() >= absoluteEnd || performance.now() - started >= monotonicBudget)) firstStop = 'backup_deadline_exceeded';
      return firstStop;
    }
    if (closed) return denial('backup_entry_closed');
    if (stop()) return denial(firstStop);
    // Deliver already-queued cancellation/deadline events outside any SQLite lock.
    await setImmediate();
    if (closed) return denial('backup_entry_closed');
    if (stop()) return denial(firstStop);
    try {
      const facts = store.inspect();
      if (stop()) return denial(firstStop);
      if (!same(snapshot.target, facts.target)) return denial('backup_target_mismatch', 'confirmed');
      if (facts.blocked) return denial('backup_target_unresolved', 'confirmed');
      // target metadata cannot serve as a capability; it only rejects mismatches.
      // The S0 source is already physically bound by the store.
      return denial('backup_source_coverage_unavailable', 'confirmed');
    } catch { return denial('backup_control_unavailable'); }
  }
  return Object.freeze({ prepare, close() { closed = true; store.close(); } });
}

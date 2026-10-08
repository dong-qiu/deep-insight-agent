/** Fixed synchronous isolated terminal writer. No initialization, callbacks or production permission. */
import Database from "better-sqlite3";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { assertGenerationDispatchClaim, finishGenerationDispatch, type DispatchClaim } from "../db/provenance.js";
import type { DispatchOutcome, FixedTerminalDispatchDriver, TerminalCommitResult, TerminalDenyCode } from "./writer-admission.js";

const bridge = Symbol.for("insight-agent.a3-terminal-driver-v1");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const markerSchema = z.strictObject({
  schema: z.literal("a3-isolation-v1"), initId: z.uuid(), approverId: id, publicKey: z.string().max(4096),
  target: z.strictObject({ region: z.literal("isolated"), instanceId: z.string().regex(/^fixture-[A-Za-z0-9_-]+$/),
    volumeId: z.string().regex(/^fixture-[A-Za-z0-9_-]+$/), dataPath: z.string().min(1),
    serviceSet: z.array(id).min(1).max(16).refine(value => JSON.stringify(value) === JSON.stringify([...new Set(value)].sort())) }),
});
function fail(code: string): never { throw new Error(code); }
function safe(path: string, directory = false) {
  const st = lstatSync(path);
  if (!(directory ? st.isDirectory() : st.isFile()) || st.isSymbolicLink() || st.uid !== process.getuid!()
    || (st.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && st.nlink !== 1)) fail("writer_terminal_business_mismatch");
  return st;
}
function readMarker(root: string) {
  if (!isAbsolute(root) || root !== realpathSync(root)) fail("writer_terminal_business_mismatch");
  safe(root, true); const path = join(root, "isolation.json"), st = safe(path);
  if (st.size > 16384) fail("writer_terminal_business_mismatch");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.uid !== process.getuid!()
      || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) fail("writer_terminal_business_mismatch");
    const parsed = markerSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success || parsed.data.target.dataPath !== root || createPublicKey(parsed.data.publicKey).asymmetricKeyType !== "ed25519") fail("writer_terminal_business_mismatch");
    return parsed.data;
  } finally { closeSync(fd); }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function sidecars(path: string) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { safe(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
const notCommitted = (code: TerminalDenyCode): TerminalCommitResult => ({ kind: "not_committed", businessCommit: "not_committed", code });
function errorCode(error: unknown): TerminalDenyCode {
  if ((error as NodeJS.ErrnoException)?.code === "SQLITE_BUSY") return "writer_terminal_busy";
  if (error instanceof Error && error.message === "generation_fence_lost") return "generation_fence_lost";
  if (error instanceof Error && error.message === "writer_terminal_reverse_transaction") return "writer_terminal_reverse_transaction";
  if (error instanceof Error && error.message === "writer_terminal_business_mismatch") return "writer_terminal_business_mismatch";
  return "writer_terminal_commit_failed";
}
export function openTerminalDispatchDriver(root: string): FixedTerminalDispatchDriver {
  const path = join(root, "fixture-business.sqlite"), marker = deepFreeze(readMarker(root));
  const identity = safe(path); if (realpathSync(path) !== path) fail("writer_terminal_business_mismatch"); sidecars(path);
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  function preflight(insideTransaction = false) {
    if (!db.open || db.readonly || db.name !== path) fail("writer_terminal_business_mismatch");
    if (db.inTransaction && !insideTransaction) fail("writer_terminal_reverse_transaction");
    if (JSON.stringify(readMarker(root)) !== JSON.stringify(marker)) fail("writer_terminal_business_mismatch");
    const st = safe(path); if (st.dev !== identity.dev || st.ino !== identity.ino || realpathSync(path) !== path) fail("writer_terminal_business_mismatch"); sidecars(path);
  }
  function binding() {
    const databases = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    if (databases.length !== 1 || databases[0].name !== "main" || databases[0].file !== path) fail("writer_terminal_business_mismatch");
    for (const table of ["generation_dispatch", "generation_lease", "generation_trace", "run"]) db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
  }
  try { preflight(); db.pragma("foreign_keys = ON"); db.pragma("synchronous = FULL"); binding(); }
  catch (error) { db.close(); throw error; }
  function commit(claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult {
    let began = false, commitAttempted = false;
    try {
      preflight(); db.exec("BEGIN IMMEDIATE"); began = true;
      preflight(true); binding(); assertGenerationDispatchClaim(db, claim);
      const linked = db.prepare(`SELECT 1 FROM generation_dispatch d
        JOIN generation_trace t ON t.id=d.trace_id JOIN run r ON r.id=t.root_run_id
        WHERE d.id=? AND d.trace_id=? AND t.root_run_id=? AND r.trace_id=t.id`).get(claim.dispatchId, claim.traceId, claim.rootRunId);
      if (!linked || !finishGenerationDispatch(db, claim, outcome)) fail("generation_fence_lost");
      commitAttempted = true; db.exec("COMMIT");
      return { kind: "committed", businessCommit: "committed" };
    } catch (error) {
      if (!began) return notCommitted(errorCode(error));
      if (commitAttempted) {
        // Cleanup a still-open native transaction, but never classify an attempted COMMIT as rolled back.
        try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* Unknown remains unknown. */ }
        return { kind: "unknown", businessCommit: "unknown", code: "writer_terminal_business_commit_unknown" };
      }
      try { db.exec("ROLLBACK"); return notCommitted(errorCode(error)); }
      catch { return { kind: "unknown", businessCommit: "unknown", code: "writer_terminal_business_commit_unknown" }; }
    }
  }
  // Data bridge binds the reviewed factory's open-time physical facts; it is not authentication.
  const descriptor = deepFreeze({ root, marker, fileDev: identity.dev, fileIno: identity.ino });
  return Object.freeze({ db, commit, close: () => db.close(), [bridge]: descriptor });
}

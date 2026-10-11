/** Fixed synchronous isolated usage writer. No initialization, callbacks or production permission. */
import Database from "better-sqlite3";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { assertGenerationDispatchClaim, type DispatchClaim } from "../db/provenance.js";
import { types } from "node:util";
import { beginModelUsageAttempt, observeModelUsage, type UsageIdentity, type UsageObservation } from "../db/model-usage.js";
import type { FixedUsageDispatchDriver, UsageCommitResult, UsageDenyCode } from "./writer-admission.js";

const bridge = Symbol.for("insight-agent.a3-usage-driver-v1");
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
    || (st.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && st.nlink !== 1)) fail("writer_usage_business_mismatch");
  return st;
}
function readMarker(root: string) {
  if (!isAbsolute(root) || root !== realpathSync(root)) fail("writer_usage_business_mismatch");
  safe(root, true); const path = join(root, "isolation.json"), st = safe(path);
  if (st.size > 16384) fail("writer_usage_business_mismatch");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.uid !== process.getuid!()
      || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) fail("writer_usage_business_mismatch");
    const parsed = markerSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success || parsed.data.target.dataPath !== root || createPublicKey(parsed.data.publicKey).asymmetricKeyType !== "ed25519") fail("writer_usage_business_mismatch");
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
const notCommitted = (code: UsageDenyCode): UsageCommitResult => ({ kind: "not_committed", businessCommit: "not_committed", code });
function errorCode(error: unknown): UsageDenyCode {
  if ((error as NodeJS.ErrnoException)?.code === "SQLITE_BUSY") return "writer_usage_busy";
  if (error instanceof Error && error.message === "generation_fence_lost") return "generation_fence_lost";
  if (error instanceof Error && error.message === "writer_usage_reverse_transaction") return "writer_usage_reverse_transaction";
  if (error instanceof Error && error.message === "writer_usage_business_mismatch") return "writer_usage_business_mismatch";
  if (error instanceof Error && error.message === "writer_usage_claim_mismatch") return "writer_usage_claim_mismatch";
  if (error instanceof Error && ["usage_identity_invalid", "usage_identity_conflict", "usage_schema_unavailable", "usage_observation_invalid", "usage_count_invalid", "usage_attempt_missing", "usage_observation_stale", "usage_observation_conflict"].includes(error.message)) return error.message as UsageDenyCode;
  return "writer_usage_commit_failed";
}
export function openUsageDispatchDriver(root: string): FixedUsageDispatchDriver {
  const path = join(root, "fixture-business.sqlite"), marker = deepFreeze(readMarker(root));
  const rootIdentity = safe(root, true);
  const identity = safe(path); if (realpathSync(path) !== path) fail("writer_usage_business_mismatch"); sidecars(path);
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  function preflight(insideTransaction = false) {
    if (!db.open || db.readonly || db.name !== path) fail("writer_usage_business_mismatch");
    if (db.inTransaction && !insideTransaction) fail("writer_usage_reverse_transaction");
    const currentRoot = safe(root, true);
    if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) fail("writer_usage_business_mismatch");
    if (JSON.stringify(readMarker(root)) !== JSON.stringify(marker)) fail("writer_usage_business_mismatch");
    const st = safe(path); if (st.dev !== identity.dev || st.ino !== identity.ino || realpathSync(path) !== path) fail("writer_usage_business_mismatch"); sidecars(path);
  }
  function binding() {
    const databases = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    if (databases.length !== 1 || databases[0].name !== "main" || databases[0].file !== path) fail("writer_usage_business_mismatch");
    for (const table of ["generation_dispatch", "generation_lease", "generation_trace", "run", "model_usage_attempt"]) db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
  }
  try { preflight(); db.pragma("foreign_keys = ON"); db.pragma("synchronous = FULL"); binding(); }
  catch (error) { db.close(); throw error; }
  const identityFields = ["attempt_id", "logical_call_id", "attempt_number", "run_id", "trace_id", "role", "provider", "model", "started_at"] as const;
  function identitySnapshot(input: UsageIdentity): UsageIdentity {
    if (!input || typeof input !== "object" || types.isProxy(input)) fail("usage_identity_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(descriptors).length !== identityFields.length || !identityFields.every(key => descriptors[key] && "value" in descriptors[key])) fail("usage_identity_invalid");
    const value = Object.fromEntries(identityFields.map(key => [key, descriptors[key].value])) as unknown as UsageIdentity;
    if (!identityFields.every(key => key === "attempt_number" ? Number.isSafeInteger(value[key]) : typeof value[key] === "string")) fail("usage_identity_invalid");
    return Object.freeze(value);
  }
  function commitUsage(claim: DispatchClaim, input: UsageIdentity, observation?: UsageObservation): UsageCommitResult {
    let began = false, commitAttempted = false;
    try {
      const value = identitySnapshot(input);
      if (!claim || typeof claim !== "object" || types.isProxy(claim)) fail("writer_usage_claim_mismatch");
      const descriptors = Object.getOwnPropertyDescriptors(claim);
      const fields = ["dispatchId", "traceId", "ownerToken", "claimEpoch", "fencingEpoch", "rootRunId"] as const;
      if (!fields.every(key => descriptors[key] && "value" in descriptors[key])) fail("writer_usage_claim_mismatch");
      const fixedClaim = Object.freeze(Object.fromEntries(fields.map(key => [key, descriptors[key].value]))) as unknown as DispatchClaim;
      if (!fields.every(key => key === "claimEpoch" || key === "fencingEpoch" ? Number.isSafeInteger(fixedClaim[key]) && fixedClaim[key] > 0 : typeof fixedClaim[key] === "string")) fail("writer_usage_claim_mismatch");
      if (observation !== undefined) {
        if (!observation || typeof observation !== "object" || types.isProxy(observation)) fail("usage_observation_invalid");
        const data = Object.getOwnPropertyDescriptors(observation);
        if (Object.keys(data).length !== 3 || !["observation_number", "final", "usage"].every(key => data[key] && "value" in data[key])) fail("usage_observation_invalid");
        const raw = data.usage.value;
        if (!raw || typeof raw !== "object" || types.isProxy(raw)) fail("usage_count_invalid");
        const counts = Object.getOwnPropertyDescriptors(raw);
        const keys = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
        if (Object.keys(counts).length !== 4 || !keys.every(key => counts[key] && "value" in counts[key] && (counts[key].value === null || (Number.isSafeInteger(counts[key].value) && counts[key].value >= 0)))) fail("usage_count_invalid");
        if (!Number.isSafeInteger(data.observation_number.value) || data.observation_number.value! < 1 || typeof data.final.value !== "boolean") fail("usage_observation_invalid");
        observation = { observation_number: data.observation_number.value!, final: data.final.value,
          usage: Object.fromEntries(keys.map(key => [key, counts[key].value])) as unknown as UsageObservation["usage"] };
      }
      preflight(); db.exec("BEGIN IMMEDIATE"); began = true;
      preflight(true); binding(); assertGenerationDispatchClaim(db, fixedClaim);
      const linked = db.prepare(`SELECT 1 FROM generation_dispatch d
        JOIN generation_trace t ON t.id=d.trace_id JOIN run root ON root.id=t.root_run_id
        JOIN run child ON child.id=? AND child.trace_id=t.id
        WHERE d.id=? AND d.trace_id=? AND t.root_run_id=? AND root.trace_id=t.id
          AND (?=1 OR child.status='running')`).get(value.run_id, fixedClaim.dispatchId, fixedClaim.traceId, fixedClaim.rootRunId, observation === undefined ? 0 : 1);
      if (!linked || value.trace_id !== fixedClaim.traceId) fail("generation_fence_lost");
      let result: { replayed: boolean };
      if (observation === undefined) result = beginModelUsageAttempt(db, value);
      else {
        const previous = db.prepare("SELECT * FROM model_usage_attempt WHERE attempt_id=?").get(value.attempt_id) as UsageIdentity | undefined;
        if (!previous || !identityFields.every(key => previous[key] === value[key])) fail("usage_identity_conflict");
        result = observeModelUsage(db, value.attempt_id, observation);
      }
      assertGenerationDispatchClaim(db, fixedClaim);
      commitAttempted = true; db.exec("COMMIT");
      return { kind: "committed", businessCommit: "committed", replayed: result.replayed };
    } catch (error) {
      if (!began) return notCommitted(errorCode(error));
      if (commitAttempted) {
        try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* Keep unknown. */ }
        return { kind: "unknown", businessCommit: "unknown", code: "writer_usage_business_commit_unknown" };
      }
      try { db.exec("ROLLBACK"); return notCommitted(errorCode(error)); }
      catch { return { kind: "unknown", businessCommit: "unknown", code: "writer_usage_business_commit_unknown" }; }
    }
  }
  const descriptor = deepFreeze({ root, marker, rootDev: rootIdentity.dev, rootIno: rootIdentity.ino, fileDev: identity.dev, fileIno: identity.ino });
  return Object.freeze({ db,
    begin: (claim: DispatchClaim, value: UsageIdentity) => commitUsage(claim, value),
    observe: (claim: DispatchClaim, value: UsageIdentity, observation: UsageObservation) => commitUsage(claim, value, observation),
    close: () => db.close(), [bridge]: descriptor });
}

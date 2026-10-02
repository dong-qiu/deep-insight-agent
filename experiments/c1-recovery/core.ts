/** Isolated synthetic protocol prototype. Never imported by app, CLI or production migrations. */
import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { DB } from "../../src/lib/db/index.js";
import { applyRedactionTombstone } from "../../src/lib/db/redaction.js";
import { decryptEntityKey, verifyRedactionRecord, type RedactionRegistryRecord } from "../../src/lib/db/redaction-registry.js";
import { C1_SYNTHETIC_DELETION_SCHEMA_SQL } from "../../src/lib/db/schema.js";

type Signed<T> = { payload: T; signature: string };
type Entry = { sequence: number; key: string; version: string; hash: string };
type Checkpoint = { protocol: "synthetic-c1-v1"; epoch: string; origin: string; cutoff: string; baseline: "empty-at-origin"; entries: Entry[] };
type Backup = { protocol: "synthetic-c1-v1"; epoch: string; sampledAt: string; sequence: number; digest: string };
type Receipt = { protocol: "synthetic-c1-v1"; backupHash: string; checkpointHash: string; image: string; resultHash: string; applied: number };
export type ObjectVersion = { key: string; version: string; body: string };

function fail(code: string): never { throw new Error(`synthetic_recovery_${code}`); }
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
export function utc(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail("time_invalid");
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")) fail("time_invalid");
  return n;
}
function signed<T>(payload: T, key: KeyObject): Signed<T> {
  if (key.asymmetricKeyType !== "ed25519") fail("key_invalid");
  return { payload: structuredClone(payload), signature: sign(null, Buffer.from(encode(payload)), key).toString("base64url") };
}
function authenticated<T>(item: Signed<T>, key: KeyObject): T {
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(encode(item.payload)), key, Buffer.from(item.signature, "base64url"))) fail("signature_invalid");
  return structuredClone(item.payload);
}
function memoryOnly(db: DB) { if (db.name !== ":memory:") fail("memory_only"); }

/** In-memory authoritative log, intentionally no AWS/file adapter or reopen method. */
export class SyntheticAuthority {
  readonly epoch = randomUUID();
  #origin: string;
  #key: KeyObject;
  #objects: ObjectVersion[] = [];
  #pending = new Set<string>();
  #closed = false;
  #checkpoint: Signed<Checkpoint> | undefined;
  constructor(origin: string, privateKey: KeyObject) { utc(origin); this.#origin = origin; this.#key = privateKey; }
  begin(): string {
    if (this.#closed) fail("maintenance_closed");
    const token = randomUUID(); this.#pending.add(token); return token;
  }
  commit(token: string, object: ObjectVersion): void {
    if (this.#closed || !this.#pending.has(token)) fail("commit_fenced");
    if (!object.key || !object.version || this.#objects.some((o) => o.key === object.key)) fail("object_conflict");
    // Append before acknowledging the synthetic external commit, including local-orphan records.
    this.#objects.push(structuredClone(object)); this.#pending.delete(token);
  }
  abort(token: string): void { if (!this.#pending.delete(token)) fail("pending_unknown"); }
  backup(db: DB, sampledAt: string): Signed<Backup> {
    memoryOnly(db);
    if (this.#closed || this.#pending.size || utc(sampledAt) < utc(this.#origin)) fail("sample_invalid");
    return signed({ protocol: "synthetic-c1-v1", epoch: this.epoch, sampledAt, sequence: this.#objects.length, digest: digest(db.serialize()) }, this.#key);
  }
  freeze(cutoff: string): Signed<Checkpoint> {
    if (this.#closed || this.#pending.size || utc(cutoff) < utc(this.#origin)) fail("freeze_invalid");
    this.#closed = true;
    this.#checkpoint = signed({ protocol: "synthetic-c1-v1", epoch: this.epoch, origin: this.#origin, cutoff,
      baseline: "empty-at-origin", entries: this.#objects.map((o, index) => ({ sequence: index + 1, key: o.key, version: o.version, hash: digest(o.body) })) }, this.#key);
    return structuredClone(this.#checkpoint);
  }
  objects(): ObjectVersion[] { return structuredClone(this.#objects); }
  assertFrozen(checkpoint: Signed<Checkpoint>): void {
    if (!this.#closed || this.#pending.size || encode(checkpoint) !== encode(this.#checkpoint)) fail("gate_invalid");
  }
}

export function replaySynthetic(db: DB, input: {
  authority: SyntheticAuthority; trustedIssuer: KeyObject; recoverySigner: KeyObject; trustedRecovery: KeyObject;
  backup: Signed<Backup>; checkpoint: Signed<Checkpoint>; objects: ObjectVersion[];
  hmacKeys: Map<string, Buffer>; dataKeys: Map<string, Buffer>; now: string; image: string;
  previousReceipt?: Signed<Receipt>;
}): Signed<Receipt> {
  memoryOnly(db);
  // Reject unusable/mismatched receipt keys before any database mutation.
  authenticated(signed({ probe: "synthetic-recovery-key-pair" }, input.recoverySigner), input.trustedRecovery);
  const backup = authenticated(input.backup, input.trustedIssuer), checkpoint = authenticated(input.checkpoint, input.trustedIssuer);
  input.authority.assertFrozen(input.checkpoint);
  const now = utc(input.now), origin = utc(checkpoint.origin), cutoff = utc(checkpoint.cutoff), sample = utc(backup.sampledAt);
  if (backup.protocol !== "synthetic-c1-v1" || checkpoint.protocol !== backup.protocol || checkpoint.baseline !== "empty-at-origin" ||
    backup.epoch !== checkpoint.epoch || checkpoint.epoch !== input.authority.epoch || sample < origin || sample > cutoff || cutoff > now ||
    !Number.isSafeInteger(backup.sequence) || backup.sequence < 0 || backup.sequence > checkpoint.entries.length || !/^sha256:[a-f0-9]{64}$/.test(input.image)) fail("coverage_invalid");
  const backupHash = digest(encode(input.backup)), checkpointHash = digest(encode(input.checkpoint));
  const before = digest(db.serialize());
  if (before !== backup.digest) {
    if (!input.previousReceipt) fail("backup_mismatch");
    const previous = authenticated(input.previousReceipt, input.trustedRecovery);
    if (previous.protocol !== "synthetic-c1-v1" || previous.backupHash !== backupHash || previous.checkpointHash !== checkpointHash ||
      previous.image !== input.image || previous.resultHash !== before) fail("receipt_mismatch");
  }
  if (input.objects.length !== checkpoint.entries.length) fail("objects_incomplete");
  const objects = new Map(input.objects.map((o) => [o.key, o]));
  if (objects.size !== input.objects.length) fail("object_duplicate");
  const ids = new Set<string>();
  const tombstones = checkpoint.entries.map((entry, index) => {
    const object = objects.get(entry.key);
    if (entry.sequence !== index + 1 || !object || entry.version !== object.version || entry.hash !== digest(object.body)) fail("object_mismatch");
    let record: RedactionRegistryRecord;
    try { record = JSON.parse(object.body) as RedactionRegistryRecord; } catch { return fail("record_invalid"); }
    const effective = utc(record.effective_at), expiry = utc(record.expiry_at);
    if (effective < origin || effective > cutoff || effective >= expiry) fail("record_time_invalid");
    const hmac = input.hmacKeys.get(record.hmac_key_version), dataKey = input.dataKeys.get(record.encrypted_entity_key.encrypted_data_key_b64url);
    if (!hmac || hmac.length < 32 || !dataKey) fail("key_unavailable");
    const verified = verifyRedactionRecord(record, decryptEntityKey(record.encrypted_entity_key, dataKey), hmac);
    if (verified.scope !== "report" || !/^report:[A-Za-z0-9_-]+$/.test(verified.entity_key)) fail("scope_unsupported");
    if (ids.has(verified.record_id)) fail("record_duplicate"); ids.add(verified.record_id);
    return { verified, hash: entry.hash, ref: `synthetic://${checkpoint.epoch}/${entry.key}` };
  });
  input.authority.assertFrozen(input.checkpoint);
  db.transaction(() => {
    db.exec(C1_SYNTHETIC_DELETION_SCHEMA_SQL);
    for (const { verified: record, hash, ref } of tombstones) {
      const existing = db.prepare("SELECT entity_key,record_hash FROM c1_synthetic_deletion WHERE record_id=?").get(record.record_id) as { entity_key: string; record_hash: string } | undefined;
      if (existing && (existing.entity_key !== record.entity_key || existing.record_hash !== hash)) fail("record_conflict");
      // Existing real tombstones must also agree, not silently ON CONFLICT skip a conflicting record.
      const old = db.prepare("SELECT entity_key,scope,reason_code,effective_at,expiry_at FROM provenance_redaction WHERE record_id=? OR (entity_key=? AND scope=?)")
        .all(record.record_id, record.entity_key, record.scope) as { entity_key: string; scope: string; reason_code: string; effective_at: string; expiry_at: string }[];
      if (old.some((row) => row.entity_key !== record.entity_key || row.scope !== record.scope || row.reason_code !== record.reason_code ||
        row.effective_at !== record.effective_at || row.expiry_at !== record.expiry_at)) fail("record_conflict");
      db.prepare("INSERT INTO c1_synthetic_deletion VALUES (?,?,?) ON CONFLICT(record_id) DO NOTHING").run(record.record_id, record.entity_key, hash);
      applyRedactionTombstone(db, { ...record, registry_ref: ref });
      // The real primitive cleans only newly inserted tombstones. A recovered snapshot may
      // already contain an identical tombstone but stale projections, so repair them here too.
      const reportId = record.entity_key.slice("report:".length);
      db.prepare("UPDATE report SET status='deleted',body_path=NULL WHERE id=?").run(reportId);
      for (const table of ["report_fts", "report_index", "report_review_snapshot", "report_selection_decision", "ppt_polish_cache"]) {
        db.prepare(`DELETE FROM ${table} WHERE report_id=?`).run(reportId);
      }
    }
  })();
  return signed({ protocol: "synthetic-c1-v1", backupHash, checkpointHash, image: input.image,
    resultHash: digest(db.serialize()), applied: tombstones.length }, input.recoverySigner);
}

/** Synthetic resolver checks the persistent constraint even after signed expiry. */
export function permanentlyHidden(db: DB, reportId: string): boolean {
  memoryOnly(db);
  return Boolean(db.prepare("SELECT 1 FROM c1_synthetic_deletion WHERE entity_key=?").get(`report:${reportId}`));
}

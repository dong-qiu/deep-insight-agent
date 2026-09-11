/** Durable raw-content archival.
 *
 * Raw files are an external side effect, so their SQLite intent is recorded
 * before any filesystem write.  A content row may therefore temporarily point
 * at a not-yet-final file after a process crash; reconciliation is the only
 * component allowed to settle that state. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { DB } from "./index.js";

interface RawArchiveArtifact { target: string; sha256: string; size: number }
interface RawArchiveEffectRow {
  id: string;
  raw_content_id: string;
  idempotency_key: string;
  artifact_manifest: string;
  status: "planned" | "attempted" | "committed" | "unknown" | "abandoned";
}
export interface RawArchivePlan { effectId: string; rawRef: string; target: string; sha256: string; size: number }

const digest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
function root(): string { return resolve(process.env.DATA_DIR ?? ".data", "raw"); }
function targetFor(contentId: string, sha256: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contentId)) throw new Error("raw_archive_content_id_invalid");
  return `${contentId}.${sha256}.txt`;
}
function safeTarget(dir: string, target: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}\.[a-f0-9]{64}\.txt$/.test(target)) throw new Error("raw_archive_target_invalid");
  const path = resolve(dir, target);
  if (relative(dir, path).startsWith("..")) throw new Error("raw_archive_target_escaped");
  return path;
}
function hasSchema(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_effect'").get()
    && (db.prepare("PRAGMA table_info(generation_effect)").all() as { name: string }[]).some((column) => column.name === "raw_content_id");
}
function artifactFor(row: Pick<RawArchiveEffectRow, "artifact_manifest">): RawArchiveArtifact {
  let manifest: unknown;
  try { manifest = JSON.parse(row.artifact_manifest); } catch { throw new Error("raw_archive_manifest_invalid"); }
  if (!Array.isArray(manifest) || manifest.length !== 1) throw new Error("raw_archive_manifest_invalid");
  const artifact = manifest[0] as RawArchiveArtifact;
  if (!artifact || typeof artifact.target !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !Number.isInteger(artifact.size) || artifact.size < 0) throw new Error("raw_archive_manifest_invalid");
  safeTarget(root(), artifact.target);
  return artifact;
}

/** Must run in the same transaction as the ContentItem upsert. */
export function planRawArchive(db: DB, input: { contentId: string; raw: string; traceId?: string; eventId?: string }): RawArchivePlan {
  if (!hasSchema(db)) throw new Error("raw_archive_effect_schema_required");
  const sha256 = digest(input.raw);
  const target = targetFor(input.contentId, sha256);
  const size = Buffer.byteLength(input.raw, "utf8");
  const idempotencyKey = `raw_archive:${input.contentId}:${sha256}`;
  const existing = db.prepare("SELECT id,raw_content_id,idempotency_key,artifact_manifest,status FROM generation_effect WHERE idempotency_key=?")
    .get(idempotencyKey) as RawArchiveEffectRow | undefined;
  if (existing) {
    const artifact = artifactFor(existing);
    if (existing.raw_content_id !== input.contentId || artifact.target !== target || artifact.sha256 !== sha256 || artifact.size !== size) {
      throw new Error("raw_archive_idempotency_conflict");
    }
    // A content revision may be updated while retaining identical raw bytes.
    // Re-check the existing artifact before publishing that revision too.
    const bound = db.prepare("UPDATE content_item SET raw_ref=?,reader_eligible=0 WHERE id=?")
      .run(join("raw", target), input.contentId);
    if (bound.changes !== 1) throw new Error("raw_archive_content_not_found");
    return { effectId: existing.id, rawRef: join("raw", target), target, sha256, size };
  }
  const effectId = `effect_raw_${randomUUID().replaceAll("-", "")}`;
  if ((input.traceId == null) !== (input.eventId == null)) throw new Error("raw_archive_effect_trace_event_incomplete");
  if (input.traceId && !db.prepare("SELECT 1 FROM generation_event WHERE id=? AND trace_id=?").get(input.eventId, input.traceId)) {
    throw new Error("raw_archive_effect_event_trace_mismatch");
  }
  db.prepare(`INSERT INTO generation_effect
    (id,trace_id,event_id,report_id,raw_content_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at)
    VALUES (@id,@trace_id,@event_id,NULL,@raw_content_id,'raw_archive',@idempotency_key,@artifact_manifest,'{}','planned',NULL,@now,@now)`)
    .run({ id: effectId, trace_id: input.traceId ?? null, event_id: input.eventId ?? null, raw_content_id: input.contentId, idempotency_key: idempotencyKey,
      artifact_manifest: JSON.stringify([{ target, sha256, size }]), now: new Date().toISOString() });
  // Intent and this pending binding are one SQLite transaction in collector.
  const bound = db.prepare("UPDATE content_item SET raw_ref=?,reader_eligible=0 WHERE id=?")
    .run(join("raw", target), input.contentId);
  if (bound.changes !== 1) throw new Error("raw_archive_content_not_found");
  return { effectId, rawRef: join("raw", target), target, sha256, size };
}

function effect(db: DB, effectId: string): RawArchiveEffectRow {
  const row = db.prepare("SELECT id,raw_content_id,idempotency_key,artifact_manifest,status FROM generation_effect WHERE id=? AND kind='raw_archive'")
    .get(effectId) as RawArchiveEffectRow | undefined;
  if (!row) throw new Error("raw_archive_effect_not_found");
  return row;
}
function verify(path: string, artifact: RawArchiveArtifact): boolean {
  return existsSync(path) && Buffer.byteLength(readFileSync(path, "utf8"), "utf8") === artifact.size
    && digest(readFileSync(path, "utf8")) === artifact.sha256;
}
/** A caller that observes an interrupted archive must close reader visibility. */
export function markRawArchiveUnknown(db: DB, effectId: string, reasonCode: string): void {
  db.prepare("UPDATE generation_effect SET status='unknown',error=?,updated_at=? WHERE id=? AND status <> 'committed'")
    .run(JSON.stringify({ reason_code: reasonCode }), new Date().toISOString(), effectId);
}

/** Verify first; then publish the archive effect and reader eligibility together. */
function finalize(db: DB, row: RawArchiveEffectRow, artifact: RawArchiveArtifact): void {
  db.transaction(() => {
    const committed = db.prepare("UPDATE generation_effect SET status='committed',error=NULL,updated_at=? WHERE id=? AND status <> 'committed'")
      .run(new Date().toISOString(), row.id);
    if (committed.changes !== 1 && row.status !== "committed") throw new Error("raw_archive_effect_finalize_lost");
    const item = db.prepare("UPDATE content_item SET reader_eligible=1 WHERE id=? AND raw_ref=? AND reader_eligible=0")
      .run(row.raw_content_id, join("raw", artifact.target));
    if (item.changes !== 1) throw new Error("raw_archive_content_binding_missing");
  })();
}

/** Performs the external write only after its intent exists. */
export function writePlannedRawArchive(db: DB, plan: RawArchivePlan, raw: string): void {
  const row = effect(db, plan.effectId);
  const artifact = artifactFor(row);
  if (artifact.target !== plan.target || artifact.sha256 !== plan.sha256 || artifact.size !== plan.size
    || row.idempotency_key !== `raw_archive:${row.raw_content_id}:${artifact.sha256}`
    || digest(raw) !== artifact.sha256 || Buffer.byteLength(raw, "utf8") !== artifact.size) throw new Error("raw_archive_payload_mismatch");
  const finalRoot = root();
  const stagingRoot = resolve(finalRoot, ".staging", row.id);
  const staged = safeTarget(stagingRoot, artifact.target);
  const final = safeTarget(finalRoot, artifact.target);
  try {
    db.prepare("UPDATE generation_effect SET status='attempted',updated_at=? WHERE id=? AND status IN ('planned','attempted')")
      .run(new Date().toISOString(), row.id);
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, raw);
    if (!verify(staged, artifact)) throw new Error("raw_archive_staging_hash_mismatch");
    mkdirSync(finalRoot, { recursive: true });
    renameSync(staged, final);
    if (!verify(final, artifact)) throw new Error("raw_archive_final_hash_mismatch");
    finalize(db, row, artifact);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "raw_archive_write_failed";
    markRawArchiveUnknown(db, row.id, reason);
    throw error;
  }
}

/** Crash recovery never deletes an orphan: it either verifies/commits it or records an explainable unknown state. */
export function reconcileRawArchiveEffects(db: DB): { committed: number; failed: number } {
  if (!hasSchema(db)) return { committed: 0, failed: 0 };
  const rows = db.prepare(`SELECT id,raw_content_id,idempotency_key,artifact_manifest,status FROM generation_effect
    WHERE kind='raw_archive' AND status IN ('planned','attempted','unknown')`).all() as RawArchiveEffectRow[];
  let committed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const artifact = artifactFor(row);
      if (row.idempotency_key !== `raw_archive:${row.raw_content_id}:${artifact.sha256}`) throw new Error("raw_archive_idempotency_conflict");
      const finalRoot = root();
      const final = safeTarget(finalRoot, artifact.target);
      const staged = safeTarget(resolve(finalRoot, ".staging", row.id), artifact.target);
      if (existsSync(final) && !verify(final, artifact)) throw new Error("raw_archive_final_hash_mismatch");
      if (!existsSync(final) && existsSync(staged)) {
        if (!verify(staged, artifact)) throw new Error("raw_archive_staging_hash_mismatch");
        mkdirSync(finalRoot, { recursive: true });
        renameSync(staged, final);
      }
      if (!verify(final, artifact)) throw new Error("raw_archive_artifact_missing");
      finalize(db, row, artifact);
      committed += 1;
    } catch (error) {
      markRawArchiveUnknown(db, row.id, error instanceof Error ? error.message : "raw_archive_reconcile_failed");
      failed += 1;
    }
  }
  return { committed, failed };
}

/** SQLite visibility and recovery protocol for P1c anchors. */
import { createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import type { DB } from "./index.js";
import { anchorEnvelopeBytes, anchorIdempotencyKey, anchorMatchesManifest, parseCanonicalAnchorEnvelope, parseCanonicalJsonBytes, signAnchor, type AnchorSigner, type AnchorStore, type ArtifactManifest, type SignedAnchor, jcs, merkleRoot, sha256, utf8, validateManifest } from "./integrity-anchors.js";

const tenant = "default";
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export interface AnchorPublication {
  generation_effect_id: string;
  manifest: ArtifactManifest;
  issued_at: string;
  retain_until: string;
}
interface StoredAnchorEffect { id: string; generation_effect_id: string; report_id: string; artifact_id: string; artifact_version: string; manifest_hash: string; manifest_canonical: string; content_hash: string; content_length: number; media_type: string; object_key: string; anchor_payload: string; anchor_provider_version_id: string | null; status: string; retry_count: number }

function audit(db: DB, input: { effectId?: string; artifactId?: string; artifactVersion?: string; type: "anchor_written_sqlite_uncommitted" | "anchor_reconciled" | "orphan_anchor" | "daily_anchor_missing" | "daily_anchor_conflict" | "daily_anchor_recovered"; severity: "high" | "critical"; details: Record<string, unknown> }): void {
  db.prepare(`INSERT INTO integrity_audit_event(id,tenant_id,effect_id,artifact_id,artifact_version,event_type,severity,details,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id("iae"), tenant, input.effectId ?? null, input.artifactId ?? null, input.artifactVersion ?? null, input.type, input.severity, jcs(input.details), now());
}

function stored(db: DB, effectId: string, manifest: ArtifactManifest): StoredAnchorEffect | undefined {
  return db.prepare(`SELECT id,generation_effect_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,object_key,anchor_payload,anchor_provider_version_id,status,retry_count
    FROM generation_anchor_effect WHERE generation_effect_id=? AND artifact_id=? AND artifact_version=?`).get(effectId, manifest.artifact_id, manifest.artifact_version) as StoredAnchorEffect | undefined;
}

/** Persist exact candidate bytes before calling an external store. */
export function planAnchorPublication(db: DB, input: AnchorPublication, signer: AnchorSigner): StoredAnchorEffect {
  validateManifest(input.manifest); const manifestHash = sha256(utf8(input.manifest)); const prior = stored(db, input.generation_effect_id, input.manifest);
  const parent = db.prepare("SELECT report_id FROM generation_effect WHERE id=?").get(input.generation_effect_id) as { report_id: string } | undefined;
  if (!parent || parent.report_id !== input.manifest.report_id) throw new Error("anchor_effect_report_mismatch");
  if (prior) {
    if (prior.manifest_hash !== manifestHash || prior.object_key !== input.manifest.external_anchor.object_key) throw new Error("anchor_effect_conflict");
    return prior;
  }
  // Persist the exact signed candidate before external I/O so retries can never mint a different immutable object.
  const candidate = signAnchor(input.manifest, input.issued_at, signer);
  const created = now(); const result = { id: id("anchor_effect"), generation_effect_id: input.generation_effect_id, report_id: input.manifest.report_id, artifact_id: input.manifest.artifact_id, artifact_version: input.manifest.artifact_version, manifest_hash: manifestHash, manifest_canonical: jcs(input.manifest), content_hash: input.manifest.content_hash, content_length: input.manifest.length, media_type: input.manifest.media_type, object_key: input.manifest.external_anchor.object_key, anchor_payload: jcs(candidate), anchor_provider_version_id: null, status: "planned", retry_count: 0 };
  db.prepare(`INSERT INTO generation_anchor_effect(id,generation_effect_id,tenant_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,anchor_idempotency_key,object_key,anchor_payload,anchor_provider_version_id,status,retry_count,error,created_at,updated_at)
    VALUES (@id,@generation_effect_id,@tenant,@report_id,@artifact_id,@artifact_version,@manifest_hash,@manifest_canonical,@content_hash,@content_length,@media_type,@anchor_idempotency_key,@object_key,@anchor_payload,NULL,'planned',0,NULL,@created,@updated)`).run({ ...result, tenant, anchor_idempotency_key: anchorIdempotencyKey(input.manifest), created, updated: created });
  return result;
}

function parseCandidate(row: StoredAnchorEffect, publicKey?: KeyObject): SignedAnchor {
  const bytes = new TextEncoder().encode(row.anchor_payload);
  return publicKey ? parseCanonicalAnchorEnvelope(bytes, publicKey) : parseCanonicalJsonBytes(bytes) as SignedAnchor;
}

/**
 * External write only.  It deliberately does not change report visibility;
 * callers must invoke commitAnchoredPublication in their final SQLite tx.
 */
export async function writePlannedAnchor(db: DB, store: AnchorStore, input: AnchorPublication, signer: AnchorSigner): Promise<{ reused: boolean; provider_version_id: string | null }> {
  const row = planAnchorPublication(db, input, signer); const publicKey = createPublicKey(signer.private_key); const candidate = parseCandidate(row, publicKey);
  let providerVersion: string | null = null; let reused = false;
  try {
    const result = await store.putIfAbsent(row.object_key, anchorEnvelopeBytes(candidate), input.retain_until);
    providerVersion = result.provider_version_id;
  } catch (error) {
    const existing = await store.get(row.object_key);
    if (!existing) throw new Error("anchor_conflict");
    const recorded = parseCanonicalAnchorEnvelope(existing.body, publicKey);
    const candidateBytes = anchorEnvelopeBytes(candidate);
    if (recorded.key_id !== candidate.key_id || existing.body.byteLength !== candidateBytes.byteLength || existing.body.some((byte, index) => byte !== candidateBytes[index])) throw new Error("anchor_conflict");
    providerVersion = existing.provider_version_id; reused = true;
  }
  db.transaction(() => {
    db.prepare("UPDATE generation_anchor_effect SET status='anchor_written',anchor_provider_version_id=?,retry_count=retry_count+1,error=NULL,updated_at=? WHERE id=? AND status IN ('planned','anchor_written','unknown')").run(providerVersion, now(), row.id);
    audit(db, { effectId: row.generation_effect_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, type: "anchor_written_sqlite_uncommitted", severity: "critical", details: { anchor_effect_id: row.id, object_key: row.object_key, retry_count: row.retry_count + 1 } });
  })();
  return { reused, provider_version_id: providerVersion };
}

export interface CommitAnchoredPublication { manifest: ArtifactManifest; generation_effect_id: string; provider_version_id: string | null; public_key: KeyObject; finalize?: () => void }
function insertManifestProjection(db: DB, row: StoredAnchorEffect, anchor: SignedAnchor, committedAt: string): void {
  db.prepare(`INSERT INTO artifact_manifest(tenant_id,artifact_id,artifact_version,report_id,manifest_canonical,manifest_hash,content_hash,content_length,media_type,anchor_object_key,anchor_provider_version_id,anchor_payload_hash,anchor_signature,anchor_key_id,anchor_issued_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenant, row.artifact_id, row.artifact_version, row.report_id, row.manifest_canonical, row.manifest_hash, row.content_hash, row.content_length, row.media_type, row.object_key, row.anchor_provider_version_id, anchor.anchor_payload_hash, anchor.signature, anchor.key_id, anchor.payload.issued_at, committedAt);
}
function finalizeAnchoredProjection(
  db: DB, row: StoredAnchorEffect, anchor: SignedAnchor, providerVersion: string | null,
  finalize?: () => void, reconciled = false,
): void {
  const committedAt = now();
  db.transaction(() => {
    finalize?.();
    insertManifestProjection(db, { ...row, anchor_provider_version_id: providerVersion }, anchor, committedAt);
    db.prepare("UPDATE generation_anchor_effect SET status='committed',updated_at=? WHERE id=? AND status='anchor_written'").run(committedAt, row.id);
    db.prepare("UPDATE generation_effect SET status='committed',updated_at=? WHERE id=? AND status IN ('planned','attempted','unknown')").run(committedAt, row.generation_effect_id);
    if (reconciled) audit(db, { effectId: row.generation_effect_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, type: "anchor_reconciled", severity: "critical", details: { anchor_effect_id: row.id, retry_count: row.retry_count } });
  })();
}
/** The sole visibility boundary for a manifest: callback and all projection rows share one SQLite transaction. */
export function commitAnchoredPublication(db: DB, input: CommitAnchoredPublication): void {
  const row = stored(db, input.generation_effect_id, input.manifest); if (!row || row.status !== "anchor_written") throw new Error("anchor_effect_not_written");
  if (row.manifest_canonical !== jcs(input.manifest)) throw new Error("anchor_effect_manifest_conflict");
  if (row.anchor_provider_version_id !== input.provider_version_id) throw new Error("anchor_provider_version_mismatch");
  const anchor = parseCandidate(row, input.public_key);
  finalizeAnchoredProjection(db, row, anchor, input.provider_version_id, input.finalize);
}

/** Commit several already-written artifact anchors with the report's reader projections in one SQLite transaction. */
export function commitAnchoredPublications(db: DB, input: { generation_effect_id: string; publications: Array<{ manifest: ArtifactManifest; provider_version_id: string | null }>; public_key: KeyObject; finalize?: () => void }): void {
  if (!input.publications.length) throw new Error("anchor_publications_empty");
  const records = input.publications.map(({ manifest, provider_version_id }) => {
    const row = stored(db, input.generation_effect_id, manifest);
    if (!row || row.status !== "anchor_written") throw new Error("anchor_effect_not_written");
    if (row.manifest_canonical !== jcs(manifest)) throw new Error("anchor_effect_manifest_conflict");
    if (row.anchor_provider_version_id !== provider_version_id) throw new Error("anchor_provider_version_mismatch");
    return { row, anchor: parseCandidate(row, input.public_key), providerVersion: provider_version_id };
  });
  const committedAt = now();
  db.transaction(() => {
    input.finalize?.();
    for (const record of records) {
      insertManifestProjection(db, { ...record.row, anchor_provider_version_id: record.providerVersion }, record.anchor, committedAt);
      db.prepare("UPDATE generation_anchor_effect SET status='committed',updated_at=? WHERE id=? AND status='anchor_written'").run(committedAt, record.row.id);
    }
    db.prepare("UPDATE generation_effect SET status='committed',updated_at=? WHERE id=? AND status IN ('planned','attempted','unknown')").run(committedAt, input.generation_effect_id);
  })();
}

/** Reconciliation never creates an anchor: it verifies the recorded bytes then retries only the SQLite finalizer. */
export async function reconcileAnchoredEffects(db: DB, store: AnchorStore, publicKey: KeyObject, finalize: (row: { generation_effect_id: string; artifact_id: string; artifact_version: string }) => void): Promise<{ reconciled: number; failed: number }> {
  const rows = db.prepare("SELECT id,generation_effect_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,object_key,anchor_payload,anchor_provider_version_id,status,retry_count FROM generation_anchor_effect WHERE status='anchor_written'").all() as StoredAnchorEffect[];
  let reconciled = 0; let failed = 0;
  for (const row of rows) {
    try {
      const manifest = parseCanonicalJsonBytes(new TextEncoder().encode(row.manifest_canonical), "anchor_effect_manifest_invalid") as ArtifactManifest; const candidate = parseCandidate(row, publicKey);
      const object = await store.get(row.object_key); const candidateBytes = anchorEnvelopeBytes(candidate);
      if (!object || !anchorMatchesManifest(candidate, manifest)) throw new Error("orphan_anchor_conflict");
      parseCanonicalAnchorEnvelope(object.body, publicKey);
      if (object.body.byteLength !== candidateBytes.byteLength || object.body.some((byte, index) => byte !== candidateBytes[index])) throw new Error("orphan_anchor_conflict");
      finalizeAnchoredProjection(db, row, candidate, row.anchor_provider_version_id, () => finalize({ generation_effect_id: row.generation_effect_id, artifact_id: row.artifact_id, artifact_version: row.artifact_version }), true);
      reconciled += 1;
    } catch (error) {
      db.transaction(() => { db.prepare("UPDATE generation_anchor_effect SET status='unknown',error=?,updated_at=? WHERE id=? AND status='anchor_written'").run(JSON.stringify({ reason_code: "orphan_anchor_conflict" }), now(), row.id); audit(db, { effectId: row.generation_effect_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, type: "orphan_anchor", severity: "critical", details: { anchor_effect_id: row.id, retry_count: row.retry_count } }); })(); failed += 1;
    }
  }
  return { reconciled, failed };
}

export interface DailyRoot { tenant_id: string; utc_date: string; cutoff: string; leaf_count: number; merkle_root: string; sort: "tenant_id,report_id,artifact_id,artifact_version,manifest_hash" }
export async function writeDailyMerkleRoot(db: DB, store: AnchorStore, utcDate: string, cutoff: string, signer: AnchorSigner): Promise<{ status: "committed" | "recovered" | "missing" }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) throw new Error("daily_date_invalid");
  const dayStart = `${utcDate}T00:00:00.000Z`; const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(dayStart)) || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) < Date.parse(dayEnd)) throw new Error("daily_cutoff_invalid");
  // A root is frozen over anchors committed during the named UTC day.  Late
  // commits retain their per-manifest proof and never rewrite an old root.
  const rows = db.prepare(`SELECT tenant_id,report_id,artifact_id,artifact_version,manifest_hash FROM artifact_manifest WHERE tenant_id=? AND committed_at >= ? AND committed_at < ? ORDER BY tenant_id,report_id,artifact_id,artifact_version,manifest_hash`).all(tenant, dayStart, dayEnd) as Array<{ manifest_hash: string }>;
  const payload: DailyRoot = { tenant_id: tenant, utc_date: utcDate, cutoff, leaf_count: rows.length, merkle_root: merkleRoot(rows.map((row) => row.manifest_hash)), sort: "tenant_id,report_id,artifact_id,artifact_version,manifest_hash" };
  const objectKey = `integrity-daily-roots/v1/${tenant}/${utcDate}/root.json`; const bytes = utf8(payload); const envelope = { payload, payload_hash: sha256(bytes), signature: sign(null, Buffer.concat([Buffer.from("daily-root-v1\0"), Buffer.from(bytes)]), signer.private_key).toString("base64url"), key_id: signer.key_id, algorithm: "ed25519" };
  let recovered = false;
  try { await store.putIfAbsent(objectKey, utf8(envelope), cutoff); }
  catch {
    const existing = await store.get(objectKey);
    if (!existing || jcs(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existing.body))) !== jcs(envelope)) { db.transaction(() => audit(db, { type: "daily_anchor_conflict", severity: "critical", details: { utc_date: utcDate, object_key: objectKey } }))(); throw new Error("daily_anchor_conflict"); }
    recovered = true;
  }
  const existingRoot = db.prepare("SELECT payload,signature,key_id FROM integrity_daily_root WHERE tenant_id=? AND utc_date=?").get(tenant, utcDate) as { payload: string; signature: string; key_id: string } | undefined;
  db.transaction(() => {
    if (existingRoot) {
      if (existingRoot.payload !== jcs(payload) || existingRoot.signature !== envelope.signature || existingRoot.key_id !== signer.key_id) {
        audit(db, { type: "daily_anchor_conflict", severity: "critical", details: { utc_date: utcDate, object_key: objectKey } });
        throw new Error("daily_anchor_conflict");
      }
      recovered = true;
    } else {
      db.prepare(`INSERT INTO integrity_daily_root(tenant_id,utc_date,cutoff,leaf_count,merkle_root,object_key,payload,signature,key_id,status,committed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(tenant, utcDate, cutoff, payload.leaf_count, payload.merkle_root, objectKey, jcs(payload), envelope.signature, signer.key_id, "committed", now());
    }
    if (recovered) audit(db, { type: "daily_anchor_recovered", severity: "high", details: { utc_date: utcDate, object_key: objectKey } });
  })();
  return { status: recovered ? "recovered" : "committed" };
}

/** UTC scheduler hook: freeze yesterday at 02:00; record a high missing-root audit at 02:15 without touching readers. */
export async function runDailyAnchorSchedule(db: DB, store: AnchorStore, signer: AnchorSigner, nowIso = now()): Promise<{ status: "skipped" | "committed" | "recovered" | "missing" }> {
  const clock = new Date(nowIso);
  if (!Number.isFinite(clock.getTime())) throw new Error("daily_schedule_now_invalid");
  const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  if (minutes < 120) return { status: "skipped" };
  const prior = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() - 1));
  const utcDate = prior.toISOString().slice(0, 10);
  const cutoff = `${clock.toISOString().slice(0, 10)}T02:00:00.000Z`;
  try { return await writeDailyMerkleRoot(db, store, utcDate, cutoff, signer); }
  catch (error) {
    if (minutes >= 135) db.transaction(() => audit(db, { type: "daily_anchor_missing", severity: "high", details: { utc_date: utcDate, reason: error instanceof Error ? error.message : "daily_anchor_write_failed" } }))();
    return { status: "missing" };
  }
}

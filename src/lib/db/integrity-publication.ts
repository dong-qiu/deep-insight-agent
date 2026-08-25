/** SQLite visibility and recovery protocol for P1c anchors. */
import { createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { DB } from "./index.js";
import { anchorEnvelopeBytes, anchorIdempotencyKey, anchorMatchesManifest, parseCanonicalAnchorEnvelope, parseCanonicalJsonBytes, signAnchor, type AnchorSigner, type AnchorStore, type ArtifactManifest, type SignedAnchor, jcs, merkleRoot, sha256, utf8, validateManifest } from "./integrity-anchors.js";

const tenant = "default";
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const INTEGRITY_MAINTENANCE_LEASE_MS = 15 * 60_000;
const INTEGRITY_MAINTENANCE_HEARTBEAT_MS = 30_000;

export interface AnchorPublication {
  generation_effect_id: string;
  manifest: ArtifactManifest;
  issued_at: string;
  retain_until: string;
}

interface IntegrityMaintenanceLease { ownerToken: string }

/** Claim a short-lived operational lease.  The lease is separate from the
 * immutable integrity ledger so overlapping cron/manual triggers can safely
 * skip work without changing any evidence facts. */
export function claimIntegrityMaintenanceLease(
  db: DB,
  clock: Date = new Date(),
  leaseMs = INTEGRITY_MAINTENANCE_LEASE_MS,
): IntegrityMaintenanceLease | null {
  const ownerToken = id("integrity_maintenance");
  const nowIso = clock.toISOString();
  const expiresAt = new Date(clock.getTime() + leaseMs).toISOString();
  const changes = db.transaction(() => db.prepare(`
    INSERT INTO integrity_maintenance_lease(tenant_id,owner_token,lease_expires_at,heartbeat_at,updated_at)
    VALUES (@tenant,@owner,@expires_at,@now,@now)
    ON CONFLICT(tenant_id) DO UPDATE SET
      owner_token=excluded.owner_token,
      lease_expires_at=excluded.lease_expires_at,
      heartbeat_at=excluded.heartbeat_at,
      updated_at=excluded.updated_at
    WHERE integrity_maintenance_lease.lease_expires_at IS NULL
       OR integrity_maintenance_lease.lease_expires_at < @now
  `).run({ tenant, owner: ownerToken, expires_at: expiresAt, now: nowIso }).changes)();
  return changes === 1 ? { ownerToken } : null;
}

function heartbeatIntegrityMaintenanceLease(db: DB, lease: IntegrityMaintenanceLease, clock = new Date()): boolean {
  const nowIso = clock.toISOString();
  const expiresAt = new Date(clock.getTime() + INTEGRITY_MAINTENANCE_LEASE_MS).toISOString();
  return db.prepare(`UPDATE integrity_maintenance_lease
    SET heartbeat_at=?,lease_expires_at=?,updated_at=?
    WHERE tenant_id=? AND owner_token=? AND lease_expires_at >= ?`).run(
    nowIso, expiresAt, nowIso, tenant, lease.ownerToken, nowIso,
  ).changes === 1;
}

export function releaseIntegrityMaintenanceLease(db: DB, lease: IntegrityMaintenanceLease, clock = new Date()): boolean {
  const nowIso = clock.toISOString();
  return db.prepare(`UPDATE integrity_maintenance_lease
    SET owner_token=NULL,lease_expires_at=NULL,heartbeat_at=?,updated_at=?
    WHERE tenant_id=? AND owner_token=?`).run(nowIso, nowIso, tenant, lease.ownerToken).changes === 1;
}
interface StoredAnchorEffect { id: string; generation_effect_id: string; report_id: string; artifact_id: string; artifact_version: string; manifest_hash: string; manifest_canonical: string; content_hash: string; content_length: number; media_type: string; object_key: string; anchor_payload: string; anchor_provider_version_id: string | null; manifest_signature: string | null; manifest_key_id: string | null; manifest_algorithm: string | null; manifest_issued_at: string | null; retain_until: string | null; status: string; retry_count: number; created_at?: string }

function audit(db: DB, input: { effectId?: string; artifactId?: string; artifactVersion?: string; type: "anchor_written_sqlite_uncommitted" | "anchor_reconciled" | "orphan_anchor" | "daily_anchor_missing" | "daily_anchor_conflict" | "daily_anchor_recovered"; severity: "high" | "critical"; details: Record<string, unknown> }): void {
  db.prepare(`INSERT INTO integrity_audit_event(id,tenant_id,effect_id,artifact_id,artifact_version,event_type,severity,details,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id("iae"), tenant, input.effectId ?? null, input.artifactId ?? null, input.artifactVersion ?? null, input.type, input.severity, jcs(input.details), now());
}

function stored(db: DB, effectId: string, manifest: ArtifactManifest): StoredAnchorEffect | undefined {
  return db.prepare(`SELECT id,generation_effect_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,object_key,anchor_payload,anchor_provider_version_id,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until,status,retry_count,created_at
    FROM generation_anchor_effect WHERE tenant_id=? AND generation_effect_id=? AND artifact_id=? AND artifact_version=?`).get(tenant, effectId, manifest.artifact_id, manifest.artifact_version) as StoredAnchorEffect | undefined;
}

function keyMaterial(db: DB, keyId: string): { publicKey: KeyObject; revoked: boolean } {
  const row = db.prepare(`SELECT k.public_key_pem,r.key_id AS revoked_key FROM integrity_signing_key k
    LEFT JOIN integrity_key_revocation r ON r.tenant_id=k.tenant_id AND r.key_id=k.key_id
    WHERE k.tenant_id=? AND k.key_id=?`).get(tenant, keyId) as { public_key_pem: string; revoked_key: string | null } | undefined;
  if (!row) throw new Error("anchor_verification_key_unavailable");
  return { publicKey: createPublicKey(row.public_key_pem), revoked: row.revoked_key != null };
}

/** Revocation never removes a historical public key, but it does stop any
 * publication boundary that would make a new artifact reader-visible. */
export function assertAnchorPublicationKeyActive(db: DB, keyId: string): void {
  if (keyMaterial(db, keyId).revoked) throw new Error("anchor_signing_key_revoked");
}

/** Rotation adds a new immutable key record; revocation never erases history. */
export function registerAnchorSigningKey(db: DB, signer: AnchorSigner): void {
  const publicPem = createPublicKey(signer.private_key).export({ type: "spki", format: "pem" }).toString();
  const existing = db.prepare("SELECT public_key_pem FROM integrity_signing_key WHERE tenant_id=? AND key_id=?").get(tenant, signer.key_id) as { public_key_pem: string } | undefined;
  if (existing && existing.public_key_pem !== publicPem) throw new Error("anchor_signing_key_conflict");
  if (!existing) db.prepare("INSERT INTO integrity_signing_key(tenant_id,key_id,public_key_pem,certificate_pem,created_at) VALUES (?,?,?,?,?)")
    .run(tenant, signer.key_id, publicPem, signer.certificate_pem ?? null, now());
  if (db.prepare("SELECT 1 FROM integrity_key_revocation WHERE tenant_id=? AND key_id=?").get(tenant, signer.key_id)) throw new Error("anchor_signing_key_revoked");
}

export function revokeAnchorSigningKey(db: DB, keyId: string, reason = "revoked", revokedAt = now()): void {
  if (!db.prepare("SELECT 1 FROM integrity_signing_key WHERE tenant_id=? AND key_id=?").get(tenant, keyId)) throw new Error("anchor_verification_key_unavailable");
  db.prepare("INSERT INTO integrity_key_revocation(tenant_id,key_id,revoked_at,reason) VALUES (?,?,?,?)").run(tenant, keyId, revokedAt, reason);
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
  registerAnchorSigningKey(db, signer);
  const candidate = signAnchor(input.manifest, input.issued_at, signer);
  const created = now(); const canonical = jcs(input.manifest); const result = { id: id("anchor_effect"), generation_effect_id: input.generation_effect_id, report_id: input.manifest.report_id, artifact_id: input.manifest.artifact_id, artifact_version: input.manifest.artifact_version, manifest_hash: manifestHash, manifest_canonical: canonical, content_hash: input.manifest.content_hash, content_length: input.manifest.length, media_type: input.manifest.media_type, object_key: input.manifest.external_anchor.object_key, anchor_payload: jcs(candidate), anchor_provider_version_id: null, manifest_signature: sign(null, Buffer.concat([Buffer.from("manifest-v1\0"), Buffer.from(canonical)]), signer.private_key).toString("base64url"), manifest_key_id: signer.key_id, manifest_algorithm: "ed25519", manifest_issued_at: input.issued_at, retain_until: input.retain_until, status: "planned", retry_count: 0, created_at: created };
  db.prepare(`INSERT INTO generation_anchor_effect(id,generation_effect_id,tenant_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,anchor_idempotency_key,object_key,anchor_payload,anchor_provider_version_id,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until,status,retry_count,error,created_at,updated_at)
    VALUES (@id,@generation_effect_id,@tenant,@report_id,@artifact_id,@artifact_version,@manifest_hash,@manifest_canonical,@content_hash,@content_length,@media_type,@anchor_idempotency_key,@object_key,@anchor_payload,NULL,@manifest_signature,@manifest_key_id,@manifest_algorithm,@manifest_issued_at,@retain_until,'planned',0,NULL,@created,@updated)`).run({ ...result, tenant, anchor_idempotency_key: anchorIdempotencyKey(input.manifest), created, updated: created });
  return result;
}

function parseCandidate(db: DB, row: StoredAnchorEffect): SignedAnchor {
  const bytes = new TextEncoder().encode(row.anchor_payload);
  const raw = parseCanonicalJsonBytes(bytes) as SignedAnchor;
  const material = keyMaterial(db, raw.key_id);
  return parseCanonicalAnchorEnvelope(bytes, material.publicKey);
}

function verifyManifestMaterial(db: DB, row: StoredAnchorEffect): void {
  if (row.manifest_algorithm !== "ed25519" || !row.manifest_key_id || !row.manifest_signature || !row.manifest_issued_at || !row.retain_until) {
    throw new Error("manifest_verification_material_unavailable");
  }
  const manifest = parseCanonicalJsonBytes(new TextEncoder().encode(row.manifest_canonical), "anchor_effect_manifest_invalid") as ArtifactManifest;
  if (sha256(utf8(manifest)) !== row.manifest_hash) throw new Error("manifest_mismatch");
  const material = keyMaterial(db, row.manifest_key_id);
  if (!verify(null, Buffer.concat([Buffer.from("manifest-v1\0"), Buffer.from(row.manifest_canonical)]), material.publicKey, Buffer.from(row.manifest_signature, "base64url"))) {
    throw new Error("manifest_mismatch");
  }
}

/**
 * External write only.  It deliberately does not change report visibility;
 * callers must invoke commitAnchoredPublication in their final SQLite tx.
 */
export async function writePlannedAnchor(db: DB, store: AnchorStore, input: AnchorPublication, signer: AnchorSigner): Promise<{ reused: boolean; provider_version_id: string | null }> {
  const row = planAnchorPublication(db, input, signer); const candidate = parseCandidate(db, row);
  assertAnchorPublicationKeyActive(db, candidate.key_id);
  let providerVersion: string | null = null; let reused = false;
  try {
    const result = await store.putIfAbsent(row.object_key, anchorEnvelopeBytes(candidate), input.retain_until);
    providerVersion = result.provider_version_id;
  } catch (error) {
    const existing = await store.get(row.object_key);
    if (!existing) throw error;
    const recorded = parseCandidate(db, { ...row, anchor_payload: new TextDecoder().decode(existing.body) });
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
  db.prepare(`INSERT INTO artifact_manifest(tenant_id,artifact_id,artifact_version,report_id,manifest_canonical,manifest_hash,content_hash,content_length,media_type,anchor_object_key,anchor_provider_version_id,anchor_payload_hash,anchor_signature,anchor_key_id,anchor_issued_at,anchor_algorithm,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenant, row.artifact_id, row.artifact_version, row.report_id, row.manifest_canonical, row.manifest_hash, row.content_hash, row.content_length, row.media_type, row.object_key, row.anchor_provider_version_id, anchor.anchor_payload_hash, anchor.signature, anchor.key_id, anchor.payload.issued_at, anchor.algorithm, row.manifest_signature, row.manifest_key_id, row.manifest_algorithm, row.manifest_issued_at, row.retain_until, committedAt);
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
  verifyManifestMaterial(db, row);
  const anchor = parseCandidate(db, row);
  assertAnchorPublicationKeyActive(db, anchor.key_id);
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
    verifyManifestMaterial(db, row);
    const anchor = parseCandidate(db, row);
    assertAnchorPublicationKeyActive(db, anchor.key_id);
    return { row, anchor, providerVersion: provider_version_id };
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
export async function reconcileAnchoredEffects(db: DB, store: AnchorStore, _publicKey: KeyObject, finalize: (row: { generation_effect_id: string; artifact_id: string; artifact_version: string }) => void, clock = new Date()): Promise<{ reconciled: number; failed: number }> {
  const rows = db.prepare("SELECT id,generation_effect_id,report_id,artifact_id,artifact_version,manifest_hash,manifest_canonical,content_hash,content_length,media_type,object_key,anchor_payload,anchor_provider_version_id,manifest_signature,manifest_key_id,manifest_algorithm,manifest_issued_at,retain_until,status,retry_count,created_at FROM generation_anchor_effect WHERE tenant_id=? AND status='anchor_written'").all(tenant) as StoredAnchorEffect[];
  let reconciled = 0; let failed = 0;
  for (const row of rows) {
    try {
      const manifest = parseCanonicalJsonBytes(new TextEncoder().encode(row.manifest_canonical), "anchor_effect_manifest_invalid") as ArtifactManifest; const candidate = parseCandidate(db, row);
      verifyManifestMaterial(db, row);
      assertAnchorPublicationKeyActive(db, candidate.key_id);
      const object = await store.get(row.object_key, row.anchor_provider_version_id); const candidateBytes = anchorEnvelopeBytes(candidate);
      if (!object || !anchorMatchesManifest(candidate, manifest)) throw new Error("orphan_anchor_conflict");
      if (object.provider_version_id !== row.anchor_provider_version_id) throw new Error("orphan_anchor_conflict");
      if (object.body.byteLength !== candidateBytes.byteLength || object.body.some((byte, index) => byte !== candidateBytes[index])) throw new Error("orphan_anchor_conflict");
      finalizeAnchoredProjection(db, row, candidate, row.anchor_provider_version_id, () => finalize({ generation_effect_id: row.generation_effect_id, artifact_id: row.artifact_id, artifact_version: row.artifact_version }), true);
      reconciled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "anchor_read_failed";
      const terminal = ["orphan_anchor_conflict", "anchor_signature_invalid", "anchor_noncanonical_body", "anchor_provider_version_mismatch", "anchor_signing_key_revoked"].includes(message);
      db.transaction(() => {
        if (terminal) {
          db.prepare("UPDATE generation_anchor_effect SET status='unknown',error=?,updated_at=? WHERE id=? AND status='anchor_written'").run(JSON.stringify({ reason_code: message }), now(), row.id);
          db.prepare("UPDATE generation_effect SET status='unknown',error=?,updated_at=? WHERE id=? AND status <> 'committed'").run(JSON.stringify({ reason_code: message }), now(), row.generation_effect_id);
          audit(db, { effectId: row.generation_effect_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, type: "orphan_anchor", severity: "critical", details: { anchor_effect_id: row.id, retry_count: row.retry_count } });
        } else if (row.created_at && clock.getTime() - Date.parse(row.created_at) >= 15 * 60_000) {
          audit(db, { effectId: row.generation_effect_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, type: "anchor_written_sqlite_uncommitted", severity: "high", details: { anchor_effect_id: row.id, escalation: "unreconciled_over_15_minutes" } });
        }
      })(); failed += 1;
    }
  }
  return { reconciled, failed };
}

export interface DailyRoot { tenant_id: string; utc_date: string; cutoff: string; leaf_count: number; merkle_root: string; sort: "tenant_id,report_id,artifact_id,artifact_version,manifest_hash" }
interface DailyRootEnvelope { payload: DailyRoot; payload_hash: string; signature: string; key_id: string; algorithm: "ed25519"; issued_at: string }
interface StoredDailyRoot { payload: string; signature: string; key_id: string; algorithm: string | null; issued_at: string | null; provider_version_id: string | null; retain_until: string | null }

function exactObject(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(code);
}
function dailyEnvelopeBytes(envelope: DailyRootEnvelope): Uint8Array { return utf8(envelope); }
function parseDailyRootEnvelope(db: DB, bytes: Uint8Array): DailyRootEnvelope {
  const raw = parseCanonicalJsonBytes(bytes, "daily_anchor_noncanonical_body") as DailyRootEnvelope;
  exactObject(raw, ["payload", "payload_hash", "signature", "key_id", "algorithm", "issued_at"], "daily_anchor_schema_invalid");
  exactObject(raw.payload, ["tenant_id", "utc_date", "cutoff", "leaf_count", "merkle_root", "sort"], "daily_anchor_schema_invalid");
  if (raw.algorithm !== "ed25519" || typeof raw.key_id !== "string" || typeof raw.signature !== "string" || typeof raw.issued_at !== "string" || typeof raw.payload_hash !== "string") throw new Error("daily_anchor_schema_invalid");
  if (raw.payload.tenant_id !== tenant || !/^\d{4}-\d{2}-\d{2}$/.test(raw.payload.utc_date) || typeof raw.payload.cutoff !== "string" || !Number.isSafeInteger(raw.payload.leaf_count) || raw.payload.leaf_count < 0 || !/^[0-9a-f]{64}$/.test(raw.payload.merkle_root) || raw.payload.sort !== "tenant_id,report_id,artifact_id,artifact_version,manifest_hash") throw new Error("daily_anchor_schema_invalid");
  const payloadBytes = utf8(raw.payload);
  if (sha256(payloadBytes) !== raw.payload_hash) throw new Error("daily_anchor_payload_hash_mismatch");
  const material = keyMaterial(db, raw.key_id);
  if (!verify(null, Buffer.concat([Buffer.from("daily-root-v1\0"), Buffer.from(payloadBytes)]), material.publicKey, Buffer.from(raw.signature, "base64url"))) throw new Error("daily_anchor_signature_invalid");
  return raw;
}
function dailyRootConflict(db: DB, utcDate: string, objectKey: string, reason: string): never {
  db.transaction(() => audit(db, { type: "daily_anchor_conflict", severity: "critical", details: { utc_date: utcDate, object_key: objectKey, reason } }))();
  throw new Error(reason);
}

export async function writeDailyMerkleRoot(db: DB, store: AnchorStore, utcDate: string, cutoff: string, signer: AnchorSigner, retainUntil: string): Promise<{ status: "committed" | "recovered" | "missing" }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) throw new Error("daily_date_invalid");
  const dayStart = `${utcDate}T00:00:00.000Z`; const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(dayStart)) || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) < Date.parse(dayEnd)) throw new Error("daily_cutoff_invalid");
  // A root is frozen over anchors committed during the named UTC day.  Late
  // commits retain their per-manifest proof and never rewrite an old root.
  const rows = db.prepare(`SELECT tenant_id,report_id,artifact_id,artifact_version,manifest_hash,retain_until FROM artifact_manifest WHERE tenant_id=? AND committed_at >= ? AND committed_at < ? ORDER BY tenant_id,report_id,artifact_id,artifact_version,manifest_hash`).all(tenant, dayStart, dayEnd) as Array<{ report_id: string; artifact_id: string; artifact_version: string; manifest_hash: string; retain_until: string | null }>;
  const payload: DailyRoot = { tenant_id: tenant, utc_date: utcDate, cutoff, leaf_count: rows.length, merkle_root: merkleRoot(rows.map((row) => row.manifest_hash)), sort: "tenant_id,report_id,artifact_id,artifact_version,manifest_hash" };
  const objectKey = `integrity-daily-roots/v1/${tenant}/${utcDate}/root.json`;
  const rootRetention = [retainUntil, ...rows.map((row) => row.retain_until).filter((value): value is string => value != null)].reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
  if (!Number.isFinite(Date.parse(rootRetention))) throw new Error("daily_anchor_retain_until_invalid");
  const existingRoot = db.prepare("SELECT payload,signature,key_id,algorithm,issued_at,provider_version_id,retain_until FROM integrity_daily_root WHERE tenant_id=? AND utc_date=?").get(tenant, utcDate) as StoredDailyRoot | undefined;
  if (existingRoot) {
    if (!existingRoot.algorithm || !existingRoot.issued_at || !existingRoot.retain_until) dailyRootConflict(db, utcDate, objectKey, "daily_verification_material_unavailable");
    const object = await store.get(objectKey, existingRoot.provider_version_id);
    if (!object) dailyRootConflict(db, utcDate, objectKey, "daily_anchor_missing");
    let recorded: DailyRootEnvelope;
    try { recorded = parseDailyRootEnvelope(db, object.body); } catch (error) { dailyRootConflict(db, utcDate, objectKey, error instanceof Error ? error.message : "daily_anchor_conflict"); }
    if (jcs(recorded.payload) !== jcs(payload) || recorded.signature !== existingRoot.signature || recorded.key_id !== existingRoot.key_id || recorded.algorithm !== existingRoot.algorithm || recorded.issued_at !== existingRoot.issued_at || object.provider_version_id !== existingRoot.provider_version_id || existingRoot.payload !== jcs(payload)) dailyRootConflict(db, utcDate, objectKey, "daily_anchor_conflict");
    db.transaction(() => audit(db, { type: "daily_anchor_recovered", severity: "high", details: { utc_date: utcDate, object_key: objectKey } }))();
    return { status: "recovered" };
  }

  registerAnchorSigningKey(db, signer);
  const issuedAt = now(); const bytes = utf8(payload);
  let envelope: DailyRootEnvelope = { payload, payload_hash: sha256(bytes), signature: sign(null, Buffer.concat([Buffer.from("daily-root-v1\0"), Buffer.from(bytes)]), signer.private_key).toString("base64url"), key_id: signer.key_id, algorithm: "ed25519", issued_at: issuedAt };
  let providerVersion: string | null; let recovered = false;
  try { providerVersion = (await store.putIfAbsent(objectKey, dailyEnvelopeBytes(envelope), rootRetention)).provider_version_id; }
  catch {
    const object = await store.get(objectKey);
    if (!object) dailyRootConflict(db, utcDate, objectKey, "daily_anchor_conflict");
    try { envelope = parseDailyRootEnvelope(db, object.body); } catch (error) { dailyRootConflict(db, utcDate, objectKey, error instanceof Error ? error.message : "daily_anchor_conflict"); }
    if (jcs(envelope.payload) !== jcs(payload)) dailyRootConflict(db, utcDate, objectKey, "daily_anchor_conflict");
    providerVersion = object.provider_version_id; recovered = true;
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO integrity_daily_root(tenant_id,utc_date,cutoff,leaf_count,merkle_root,object_key,payload,signature,key_id,status,committed_at,algorithm,issued_at,provider_version_id,retain_until)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenant, utcDate, cutoff, payload.leaf_count, payload.merkle_root, objectKey, jcs(payload), envelope.signature, envelope.key_id, recovered ? "recovered" : "committed", now(), envelope.algorithm, envelope.issued_at, providerVersion, rootRetention);
    const material = db.prepare(`INSERT INTO integrity_daily_root_material(tenant_id,utc_date,report_id,artifact_id,artifact_version,manifest_hash)
      VALUES (?,?,?,?,?,?)`);
    for (const row of rows) {
      material.run(tenant, utcDate, row.report_id, row.artifact_id, row.artifact_version, row.manifest_hash);
    }
    if (recovered) audit(db, { type: "daily_anchor_recovered", severity: "high", details: { utc_date: utcDate, object_key: objectKey } });
  })();
  return { status: recovered ? "recovered" : "committed" };
}

/** UTC scheduler hook: freeze yesterday at 02:00; record a high missing-root audit at 02:15 without touching readers. */
export async function runDailyAnchorSchedule(db: DB, store: AnchorStore, signer: AnchorSigner, retainUntil: string, nowIso = now()): Promise<{ status: "skipped" | "committed" | "recovered" | "missing" }> {
  const clock = new Date(nowIso);
  if (!Number.isFinite(clock.getTime())) throw new Error("daily_schedule_now_invalid");
  const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  if (minutes < 120) return { status: "skipped" };
  const prior = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() - 1));
  const utcDate = prior.toISOString().slice(0, 10);
  const cutoff = `${clock.toISOString().slice(0, 10)}T02:00:00.000Z`;
  // The root attempt is its own 02:00 UTC job.  A later worker must not
  // silently change the frozen cutoff; explicit recovery uses the function
  // below with this exact cutoff.
  if (minutes < 135) {
    try { return await writeDailyMerkleRoot(db, store, utcDate, cutoff, signer, retainUntil); }
    catch { return { status: "missing" }; }
  }
  const root = db.prepare("SELECT status FROM integrity_daily_root WHERE tenant_id=? AND utc_date=?").get(tenant, utcDate) as { status: string } | undefined;
  if (root) return { status: root.status === "recovered" ? "recovered" : "committed" };
  const since = new Date(clock.getTime() - 30 * 60_000).toISOString();
  const alreadyAlerted = db.prepare("SELECT 1 FROM integrity_audit_event WHERE tenant_id=? AND event_type='daily_anchor_missing' AND created_at>=? LIMIT 1").get(tenant, since);
  if (!alreadyAlerted) db.transaction(() => audit(db, { type: "daily_anchor_missing", severity: "high", details: { utc_date: utcDate, reason: "daily_root_absent_at_0215" } }))();
  return { status: "missing" };
}

/** Recovery is independently schedulable and always uses the original cutoff. */
export async function recoverDailyAnchorRoot(db: DB, store: AnchorStore, signer: AnchorSigner, utcDate: string, retainUntil: string): Promise<{ status: "committed" | "recovered" | "missing" }> {
  const next = new Date(`${utcDate}T00:00:00.000Z`);
  if (!Number.isFinite(next.getTime())) throw new Error("daily_date_invalid");
  const cutoff = new Date(next.getTime() + 26 * 60 * 60_000).toISOString();
  return writeDailyMerkleRoot(db, store, utcDate, cutoff, signer, retainUntil);
}

/** Independent maintenance entry point: reconciliation never needs a queued
 * generation dispatch.  Cron invokes this beside the 02:00/02:15 jobs. */
export async function runIntegrityMaintenance(
  db: DB, input: { store: AnchorStore; signer: AnchorSigner; retainUntil: string }, nowIso = now(),
): Promise<{ skipped: boolean; reconciliation: { committed: number; failed: number }; daily: "skipped" | "committed" | "recovered" | "missing"; checks: { checked: number; passed: number; failed: number } }> {
  const lease = claimIntegrityMaintenanceLease(db);
  if (!lease) return {
    skipped: true,
    reconciliation: { committed: 0, failed: 0 },
    daily: "skipped",
    checks: { checked: 0, passed: 0, failed: 0 },
  };
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    try {
      if (!heartbeatIntegrityMaintenanceLease(db, lease)) leaseLost = true;
    } catch {
      // Never leak a timer exception. The next phase boundary fails closed.
      leaseLost = true;
    }
  }, INTEGRITY_MAINTENANCE_HEARTBEAT_MS);
  heartbeatTimer.unref();
  const assertLease = (): void => {
    if (leaseLost || !heartbeatIntegrityMaintenanceLease(db, lease)) throw new Error("integrity_maintenance_lease_lost");
  };
  try {
    const reconciliation = await import("./reports.js").then(({ reconcileAnchoredReportEffects }) => reconcileAnchoredReportEffects(db, input));
    assertLease();
    const checks = await import("./integrity-checks.js").then(async ({ runAutomaticIntegrityChecks }) => {
      const { notifyIntegrityFailure } = await import("../runtime/integrity-alert.js");
      return runAutomaticIntegrityChecks(db, input.store, notifyIntegrityFailure, new Date(nowIso));
    });
    assertLease();
    const daily = await runDailyAnchorSchedule(db, input.store, input.signer, input.retainUntil, nowIso);
    return { skipped: false, reconciliation, daily: daily.status, checks: { checked: checks.checked, passed: checks.passed, failed: checks.failed } };
  } finally {
    clearInterval(heartbeatTimer);
    releaseIntegrityMaintenanceLease(db, lease);
  }
}

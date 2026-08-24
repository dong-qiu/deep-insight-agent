/** P1c artifact revalidation. This module never participates in report reads. */
import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DB } from "./index.js";
import { anchorMatchesManifest, contentHash, manifestHash, parseCanonicalAnchorEnvelope, parseCanonicalJsonBytes, type AnchorStore, type ArtifactManifest } from "./integrity-anchors.js";

const tenant = "default";
const CHECKER_VERSION = "integrity-checker-v1";
const HASH_PREFIX = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60_000;

export type IntegrityCheckOutcome = "pass" | "content_mismatch" | "manifest_mismatch" | "anchor_mismatch" | "verification_material_unavailable" | "missing_artifact" | "unreadable" | "unsupported_algorithm" | "authorization_denied";
export interface IntegrityCheckResult {
  artifact_id: string;
  artifact_version: string;
  outcome: IntegrityCheckOutcome;
  failure_step: string | null;
  expected_hash_prefix: string | null;
  actual_hash_prefix: string | null;
  key_revoked: boolean;
  checked_at: string;
}

interface ManifestRow {
  artifact_id: string; artifact_version: string; report_id: string; manifest_canonical: string; manifest_hash: string;
  content_hash: string; content_length: number; media_type: string; anchor_object_key: string;
  anchor_provider_version_id: string | null; anchor_payload_hash: string | null; anchor_signature: string | null;
  anchor_key_id: string | null; anchor_issued_at: string | null; anchor_algorithm: string | null;
  manifest_signature: string | null; manifest_key_id: string | null; manifest_algorithm: string | null; manifest_issued_at: string | null;
  body_path: string | null;
}

interface KeyMaterial { publicKey: KeyObject }
function keyMaterial(db: DB, keyId: string): KeyMaterial {
  const row = db.prepare(`SELECT public_key_pem FROM integrity_signing_key
    WHERE tenant_id=? AND key_id=?`).get(tenant, keyId) as { public_key_pem: string } | undefined;
  if (!row) throw new Error("verification_material_unavailable");
  try { return { publicKey: createPublicKey(row.public_key_pem) }; }
  catch { throw new Error("verification_material_unavailable"); }
}

function prefix(value: string | null | undefined): string | null { return value ? value.slice(0, HASH_PREFIX) : null; }
function result(row: Pick<ManifestRow, "artifact_id" | "artifact_version">, outcome: IntegrityCheckOutcome, checkedAt: string, keyRevoked: boolean, step: string | null = null, expected?: string, actual?: string): IntegrityCheckResult {
  return { artifact_id: row.artifact_id, artifact_version: row.artifact_version, outcome, failure_step: step, expected_hash_prefix: prefix(expected), actual_hash_prefix: prefix(actual), key_revoked: keyRevoked, checked_at: checkedAt };
}
function persist(db: DB, checked: IntegrityCheckResult): IntegrityCheckResult {
  db.prepare(`INSERT INTO integrity_check(id,tenant_id,artifact_id,artifact_version,outcome,failure_step,expected_hash_prefix,actual_hash_prefix,key_revoked,checker_version,checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`ic_${randomUUID().replaceAll("-", "")}`, tenant, checked.artifact_id, checked.artifact_version, checked.outcome, checked.failure_step, checked.expected_hash_prefix, checked.actual_hash_prefix, Number(checked.key_revoked), CHECKER_VERSION, checked.checked_at);
  return checked;
}
function recordedKeyRevoked(db: DB, keyIds: Array<string | null>): boolean {
  const ids = [...new Set(keyIds.filter((keyId): keyId is string => keyId != null))];
  if (!ids.length) return false;
  const placeholders = ids.map(() => "?").join(",");
  return Boolean(db.prepare(`SELECT 1 FROM integrity_key_revocation WHERE tenant_id=? AND key_id IN (${placeholders}) LIMIT 1`).get(tenant, ...ids));
}
function rowFor(db: DB, artifactId: string, artifactVersion: string): ManifestRow | undefined {
  return db.prepare(`SELECT m.artifact_id,m.artifact_version,m.report_id,m.manifest_canonical,m.manifest_hash,m.content_hash,m.content_length,m.media_type,m.anchor_object_key,m.anchor_provider_version_id,m.anchor_payload_hash,m.anchor_signature,m.anchor_key_id,m.anchor_issued_at,m.anchor_algorithm,m.manifest_signature,m.manifest_key_id,m.manifest_algorithm,m.manifest_issued_at,r.body_path
    FROM artifact_manifest m JOIN report r ON r.id=m.report_id
    WHERE m.tenant_id=? AND m.artifact_id=? AND m.artifact_version=?`).get(tenant, artifactId, artifactVersion) as ManifestRow | undefined;
}
function extension(row: ManifestRow): "md" | "html" {
  if (row.media_type === "text/markdown" && row.artifact_id === `${row.report_id}-md`) return "md";
  if (row.media_type === "text/html" && row.artifact_id === `${row.report_id}-html`) return "html";
  throw new Error("unsupported_artifact_media_type");
}
async function defaultArtifactBytes(row: ManifestRow): Promise<Uint8Array> {
  if (!row.body_path) throw new Error("missing_artifact");
  const path = join(dirname(row.body_path), `${row.report_id}.${extension(row)}`);
  try { return new Uint8Array(await readFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("missing_artifact"); throw new Error("unreadable"); }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("unreadable")), CHECK_TIMEOUT_MS); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface VerifyArtifactInput { artifact_id: string; artifact_version: string; readArtifact?: (input: { artifact_id: string; artifact_version: string }) => Promise<Uint8Array> }

/** Verifies original artifact bytes, manifest material and that artifact's own immutable anchor. */
export async function verifyArtifactIntegrity(db: DB, store: AnchorStore, input: VerifyArtifactInput, checkedAt = new Date().toISOString()): Promise<IntegrityCheckResult> {
  const row = rowFor(db, input.artifact_id, input.artifact_version);
  if (!row) throw new Error("integrity_artifact_not_found");
  // Revocation is a diagnostic property of the recorded verification material,
  // not a reason to reject a historical signature.
  const keyRevoked = recordedKeyRevoked(db, [row.manifest_key_id, row.anchor_key_id]);
  const finish = (outcome: IntegrityCheckOutcome, step?: string | null, expected?: string, actual?: string) => persist(db, result(row, outcome, checkedAt, keyRevoked, step, expected, actual));

  if (row.manifest_algorithm !== "ed25519" || row.anchor_algorithm !== "ed25519") return finish("unsupported_algorithm", "algorithm");
  if (!row.manifest_signature || !row.manifest_key_id || !row.manifest_issued_at || !row.anchor_payload_hash || !row.anchor_signature || !row.anchor_key_id || !row.anchor_issued_at) return finish("verification_material_unavailable", "stored_material");

  let bytes: Uint8Array;
  try { bytes = await within(input.readArtifact ? input.readArtifact(input) : defaultArtifactBytes(row)); }
  catch (error) {
    const code = error instanceof Error ? error.message : "unreadable";
    return finish(code === "missing_artifact" ? "missing_artifact" : "unreadable", "artifact_bytes");
  }
  const actualContentHash = contentHash(bytes);
  if (actualContentHash !== row.content_hash || bytes.byteLength !== row.content_length) return finish("content_mismatch", "artifact_bytes", row.content_hash, actualContentHash);

  let manifest: ArtifactManifest;
  try {
    manifest = parseCanonicalJsonBytes(new TextEncoder().encode(row.manifest_canonical), "manifest_noncanonical") as ArtifactManifest;
    if (manifestHash(manifest) !== row.manifest_hash || manifest.content_hash !== row.content_hash || manifest.length !== row.content_length || manifest.external_anchor.object_key !== row.anchor_object_key) return finish("manifest_mismatch", "manifest_hash", row.manifest_hash, manifestHash(manifest));
    const material = keyMaterial(db, row.manifest_key_id);
    if (!verify(null, Buffer.concat([Buffer.from("manifest-v1\0"), Buffer.from(row.manifest_canonical)]), material.publicKey, Buffer.from(row.manifest_signature, "base64url"))) return finish("manifest_mismatch", "manifest_signature");
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return finish(code === "verification_material_unavailable" ? "verification_material_unavailable" : "manifest_mismatch", code === "verification_material_unavailable" ? "manifest_key" : "manifest");
  }

  try {
    const object = await within(store.get(row.anchor_object_key, row.anchor_provider_version_id));
    if (!object) return finish("verification_material_unavailable", "anchor_object");
    if (object.provider_version_id !== row.anchor_provider_version_id) return finish("anchor_mismatch", "anchor_provider_version");
    const anchor = parseCanonicalAnchorEnvelope(object.body, keyMaterial(db, row.anchor_key_id).publicKey);
    if (!anchorMatchesManifest(anchor, manifest) || anchor.anchor_payload_hash !== row.anchor_payload_hash || anchor.signature !== row.anchor_signature || anchor.key_id !== row.anchor_key_id || anchor.payload.issued_at !== row.anchor_issued_at) return finish("anchor_mismatch", "anchor_binding");
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "verification_material_unavailable") return finish("verification_material_unavailable", "anchor_key");
    if (code === "unreadable") return finish("unreadable", "anchor_object");
    return finish("anchor_mismatch", "anchor");
  }
  return finish("pass");
}

export interface AutomaticIntegrityCheckSummary { checked: number; passed: number; failed: number; notifications: IntegrityCheckResult[] }

/** Atomic, append-only 30-minute alert claim. Concurrent workers can emit at
 * most one external notification for an artifact/version window. */
export function claimIntegrityFailureAlert(db: DB, checked: IntegrityCheckResult): boolean {
  const checkedMs = Date.parse(checked.checked_at);
  const windowStart = new Date(Math.floor(checkedMs / (30 * 60_000)) * (30 * 60_000)).toISOString();
  const inserted = db.prepare(`INSERT OR IGNORE INTO integrity_check_alert_dedup(tenant_id,artifact_id,artifact_version,window_start)
    VALUES (?,?,?,?)`).run(tenant, checked.artifact_id, checked.artifact_version, windowStart);
  return inserted.changes === 1;
}

/** All check entry points use one append-only, atomic claim before notifying. */
export function notifyIntegrityFailureOnce(db: DB, checked: IntegrityCheckResult, notifyFailure: (checked: IntegrityCheckResult) => void): boolean {
  if (checked.outcome === "pass" || !claimIntegrityFailureAlert(db, checked)) return false;
  notifyFailure(checked);
  return true;
}

/** Automatic work stays diagnostic-only: it never changes a reader-visible report. */
export async function runAutomaticIntegrityChecks(
  db: DB, store: AnchorStore, notifyFailure: (checked: IntegrityCheckResult) => void, clock = new Date(),
): Promise<AutomaticIntegrityCheckSummary> {
  const cutoff = new Date(clock.getTime() - DAY_MS).toISOString();
  const rows = db.prepare(`SELECT m.artifact_id,m.artifact_version FROM artifact_manifest m JOIN report r ON r.id=m.report_id
    WHERE m.tenant_id=? AND r.status='done' AND NOT EXISTS (
      SELECT 1 FROM integrity_check c WHERE c.tenant_id=m.tenant_id AND c.artifact_id=m.artifact_id AND c.artifact_version=m.artifact_version AND c.checked_at>=?
    ) ORDER BY m.committed_at ASC LIMIT 32`).all(tenant, cutoff) as Array<{ artifact_id: string; artifact_version: string }>;
  const notifications: IntegrityCheckResult[] = []; let cursor = 0; let checked = 0; let passed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const item = rows[cursor++]!;
      const outcome = await verifyArtifactIntegrity(db, store, item, clock.toISOString());
      checked += 1;
      if (outcome.outcome === "pass") passed += 1;
      else if (notifyIntegrityFailureOnce(db, outcome, notifyFailure)) notifications.push(outcome);
    }
  };
  await Promise.all([worker(), worker()]);
  return { checked, passed, failed: checked - passed, notifications };
}

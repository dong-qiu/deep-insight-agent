/**
 * P1d report-retention state machine. It is intentionally a maintenance
 * boundary: report readers only consult `isReportReaderVisible`; they never
 * run an integrity check, read an anchor, or wait on this module's work.
 */
import { randomUUID, sign } from "node:crypto";
import { rmSync } from "node:fs";
import type { DB } from "./index.js";
import { jcs, sha256, type AnchorSigner } from "./integrity-anchors.js";
import { registerAnchorSigningKey } from "./integrity-publication.js";
import {
  registerRedaction,
  type RedactionRegistryClients,
  type RedactionRegistryConfig,
} from "./redaction-registry-writer.js";

const tenant = "default";
const TOMBSTONE_DOMAIN = "retention-tombstone-v1\0";

type LifecycleState = "active" | "delete_pending" | "purge_pending" | "destroyed";
type HoldAction = "placed" | "released";

interface LifecycleRow { reader_state: LifecycleState; readable_until: string; archive_until: string; artifact_body_path: string | null; destroyed_at: string | null }
interface ArtifactRow {
  artifact_id: string; artifact_version: string; anchor_object_key: string; manifest_hash: string;
  anchor_payload_hash: string | null; retain_until: string | null; last_outcome: string | null;
}

interface RetentionCompletionRow {
  backup_reference: string;
  backup_receipt: string;
  backup_receipt_hash: string;
  backup_receipt_signature: string;
  backup_receipt_key_id: string;
  registry_record_id: string;
  registry_ref: string;
}

export interface BackupRetentionReceipt {
  reference: string;
  receipt: string;
  signature: string;
  key_id: string;
}

/** This verifier is supplied by the backup integration with its configured
 * trust anchor; callers cannot replace it with an unverified DB assertion. */
export interface BackupRetentionReceiptVerifier {
  verify(receipt: BackupRetentionReceipt): boolean;
}

export type RetentionResult =
  | { kind: "not_found" }
  | { kind: "delete_pending" }
  | { kind: "legal_hold" }
  | { kind: "retention_not_eligible" }
  | { kind: "retention_prerequisites_unmet" }
  | { kind: "destroyed" }
  | { kind: "already_destroyed" };

function tableExists(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function lifecycleRow(db: DB, reportId: string): LifecycleRow | undefined {
  return db.prepare(`SELECT reader_state,readable_until,archive_until,artifact_body_path,destroyed_at
    FROM integrity_report_lifecycle WHERE tenant_id=? AND report_id=?`).get(tenant, reportId) as LifecycleRow | undefined;
}

function audit(db: DB, reportId: string, eventType: "deletion_requested" | "deletion_blocked_legal_hold" | "retention_tombstone_written" | "retention_not_eligible", reasonCode: string, now: string, actorId?: string): void {
  db.prepare(`INSERT INTO integrity_lifecycle_audit(id,tenant_id,report_id,event_type,actor_id,reason_code,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(`ila_${randomUUID().replaceAll("-", "")}`, tenant, reportId, eventType, actorId ?? null, reasonCode, now);
}

/** A missing lifecycle table is a pre-P1d database. Its legacy reports remain
 * visible, preserving backwards compatibility until the migration is applied. */
export function isReportReaderVisible(db: DB, reportId: string): boolean {
  if (!tableExists(db, "integrity_report_lifecycle")) return true;
  const row = lifecycleRow(db, reportId);
  return !row || row.reader_state === "active";
}

/** SQL fragment for list/search resolvers. `reportIdColumn` is an internal
 * identifier, never client input. */
export function reportReaderVisibilitySql(db: DB, reportIdColumn: string): string {
  if (!tableExists(db, "integrity_report_lifecycle")) return "1=1";
  return `NOT EXISTS (SELECT 1 FROM integrity_report_lifecycle irl WHERE irl.tenant_id='default' AND irl.report_id=${reportIdColumn} AND irl.reader_state <> 'active')`;
}

function activeHolds(db: DB, reportId: string): string[] {
  const rows = db.prepare(`SELECT hold_id,action FROM integrity_legal_hold_event
    WHERE tenant_id=? AND report_id=? ORDER BY occurred_at ASC,id ASC`).all(tenant, reportId) as Array<{ hold_id: string; action: HoldAction }>;
  const holds = new Set<string>();
  for (const row of rows) {
    if (row.action === "placed") holds.add(row.hold_id);
    else holds.delete(row.hold_id);
  }
  return [...holds];
}

export function recordLegalHold(db: DB, input: { report_id: string; hold_id: string; action: HoldAction; actor_id: string; reason_code: string; occurred_at?: string }): boolean {
  const now = input.occurred_at ?? new Date().toISOString();
  const report = db.prepare("SELECT 1 FROM report WHERE id=?").get(input.report_id);
  if (!report) return false;
  db.prepare(`INSERT OR IGNORE INTO integrity_legal_hold_event(id,tenant_id,report_id,hold_id,action,actor_id,reason_code,occurred_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(`ilh_${randomUUID().replaceAll("-", "")}`, tenant, input.report_id, input.hold_id, input.action, input.actor_id, input.reason_code, now);
  return true;
}

/** Hide a report immediately after an authorised deletion request. The report,
 * artifacts, manifests, anchors and key history remain untouched. */
export function requestReportDeletion(db: DB, input: { report_id: string; actor_id: string; readable_until: string; archive_until: string; now?: string }): RetentionResult {
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(input.readable_until)) || !Number.isFinite(Date.parse(input.archive_until))) throw new Error("retention_window_invalid");
  const report = db.prepare("SELECT body_path FROM report WHERE id=?").get(input.report_id) as { body_path: string | null } | undefined;
  if (!report) return { kind: "not_found" };
  if (activeHolds(db, input.report_id).length) {
    db.transaction(() => audit(db, input.report_id, "deletion_blocked_legal_hold", "legal_hold_active", now, input.actor_id))();
    return { kind: "legal_hold" };
  }
  const existing = lifecycleRow(db, input.report_id);
  if (existing?.reader_state === "destroyed") return { kind: "already_destroyed" };
  // A retry owns the purge_pending state. Do not turn it back into a new
  // deletion request and risk conflicting with its immutable tombstone.
  if (existing?.reader_state === "purge_pending") return { kind: "delete_pending" };
  db.transaction(() => {
    db.prepare(`INSERT INTO integrity_report_lifecycle(tenant_id,report_id,reader_state,readable_until,archive_until,artifact_body_path,delete_requested_at,destroyed_at)
      VALUES (?,?,?,?,?,?,?,NULL)
      ON CONFLICT(tenant_id,report_id) DO UPDATE SET reader_state='delete_pending',readable_until=excluded.readable_until,archive_until=excluded.archive_until,artifact_body_path=excluded.artifact_body_path,delete_requested_at=excluded.delete_requested_at`)
      .run(tenant, input.report_id, "delete_pending", input.readable_until, input.archive_until, report.body_path, now);
    // Withdraw all reader projections in the same transaction. The immutable
    // report row remains for controlled admin lifecycle operations.
    db.prepare("DELETE FROM report_index WHERE report_id=?").run(input.report_id);
    db.prepare("DELETE FROM report_fts WHERE report_id=?").run(input.report_id);
    db.prepare("DELETE FROM ppt_polish_cache WHERE report_id=?").run(input.report_id);
    audit(db, input.report_id, "deletion_requested", "retention_delete_requested", now, input.actor_id);
  })();
  return { kind: "delete_pending" };
}

function receiptHash(receipt: BackupRetentionReceipt): string {
  return sha256(new TextEncoder().encode(jcs(receipt)));
}

/**
 * The controlled completion path. It verifies a backup-provider receipt and
 * uses the conditional-write registry workflow; only its post-write callback
 * can persist the immutable completion proof.
 */
export async function completeRetentionDestruction(
  db: DB,
  input: {
    report_id: string;
    actor_id: string;
    deletion_request_id: string;
    redaction_expiry_at: string;
    backup_receipt: BackupRetentionReceipt;
    completed_at?: string;
  },
  registry: { config: RedactionRegistryConfig; clients: RedactionRegistryClients },
  backupReceiptVerifier: BackupRetentionReceiptVerifier,
): Promise<boolean> {
  const completedAt = input.completed_at ?? new Date().toISOString();
  const receipt = input.backup_receipt;
  if (!receipt.reference.trim() || !receipt.receipt.trim() || !receipt.signature.trim() || !receipt.key_id.trim()) {
    throw new Error("retention_backup_receipt_invalid");
  }
  if (!backupReceiptVerifier.verify(receipt)) throw new Error("retention_backup_receipt_unverified");
  if (!lifecycleRow(db, input.report_id)) return false;
  const existingRedaction = db.prepare(`SELECT record_id,registry_ref FROM provenance_redaction
    WHERE entity_key=? AND scope='report' AND reason_code='retention_expired'`).get(`report:${input.report_id}`) as { record_id: string; registry_ref: string } | undefined;
  if (existingRedaction) {
    const registeredRequest = db.prepare(`SELECT 1 FROM provenance_redaction_request
      WHERE record_id=? AND status='registered' AND ? = 's3://' || ? || '/' || registry_key`).get(
      existingRedaction.record_id, existingRedaction.registry_ref, registry.config.bucket,
    );
    if (!registeredRequest) throw new Error("retention_registry_completion_missing");
  }
  let written = false;
  await registerRedaction(db, {
    deletion_request_id: input.deletion_request_id,
    entity_key: `report:${input.report_id}`,
    scope: "report",
    reason_code: "retention_expired",
    expiry_at: input.redaction_expiry_at,
  }, registry.config, registry.clients, (registered) => {
    const result = db.prepare(`INSERT OR IGNORE INTO integrity_retention_completion(
      tenant_id,report_id,backup_reference,backup_receipt,backup_receipt_hash,backup_receipt_signature,backup_receipt_key_id,
      registry_record_id,registry_ref,actor_id,completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenant, input.report_id, receipt.reference, receipt.receipt, receiptHash(receipt), receipt.signature, receipt.key_id,
      registered.record_id, registered.registry_ref, input.actor_id, completedAt,
    );
    if (result.changes) {
      written = true;
      return;
    }
    const existing = db.prepare(`SELECT backup_reference,backup_receipt,backup_receipt_hash,backup_receipt_signature,backup_receipt_key_id,registry_record_id,registry_ref
      FROM integrity_retention_completion WHERE tenant_id=? AND report_id=?`).get(tenant, input.report_id) as RetentionCompletionRow;
    if (existing.backup_reference !== receipt.reference || existing.backup_receipt !== receipt.receipt ||
      existing.backup_receipt_hash !== receiptHash(receipt) || existing.backup_receipt_signature !== receipt.signature ||
      existing.backup_receipt_key_id !== receipt.key_id || existing.registry_record_id !== registered.record_id || existing.registry_ref !== registered.registry_ref) {
      throw new Error("retention_completion_conflict");
    }
  });
  return written;
}

function artifactRows(db: DB, reportId: string): ArtifactRow[] {
  return db.prepare(`SELECT m.artifact_id,m.artifact_version,m.anchor_object_key,m.manifest_hash,m.anchor_payload_hash,m.retain_until,
    (SELECT c.outcome FROM integrity_check c WHERE c.tenant_id=m.tenant_id AND c.artifact_id=m.artifact_id AND c.artifact_version=m.artifact_version ORDER BY c.checked_at DESC LIMIT 1) AS last_outcome
    FROM artifact_manifest m WHERE m.tenant_id=? AND m.report_id=? ORDER BY m.artifact_id,m.artifact_version`).all(tenant, reportId) as ArtifactRow[];
}

function purgeRetainedMaterial(db: DB, reportId: string, now: string): void {
  db.transaction(() => {
    db.prepare("UPDATE integrity_retention_purge_guard SET enabled=1 WHERE id=1").run();
    try {
      db.prepare(`DELETE FROM integrity_check_alert_dedup WHERE tenant_id=? AND (artifact_id,artifact_version) IN
        (SELECT artifact_id,artifact_version FROM artifact_manifest WHERE tenant_id=? AND report_id=?)`).run(tenant, tenant, reportId);
      db.prepare(`DELETE FROM integrity_check WHERE tenant_id=? AND (artifact_id,artifact_version) IN
        (SELECT artifact_id,artifact_version FROM artifact_manifest WHERE tenant_id=? AND report_id=?)`).run(tenant, tenant, reportId);
      db.prepare(`DELETE FROM integrity_audit_event WHERE tenant_id=? AND (artifact_id,artifact_version) IN
        (SELECT artifact_id,artifact_version FROM artifact_manifest WHERE tenant_id=? AND report_id=?)`).run(tenant, tenant, reportId);
      db.prepare("DELETE FROM generation_anchor_effect WHERE tenant_id=? AND report_id=?").run(tenant, reportId);
      db.prepare("DELETE FROM artifact_manifest WHERE tenant_id=? AND report_id=?").run(tenant, reportId);
      db.prepare("DELETE FROM generation_effect WHERE report_id=?").run(reportId);
      db.prepare("DELETE FROM integrity_daily_root WHERE tenant_id=? AND retain_until IS NOT NULL AND retain_until <= ?").run(tenant, now);
      db.prepare(`DELETE FROM integrity_retention_tombstone WHERE tenant_id=? AND report_id=?`).run(tenant, reportId);
      db.prepare(`DELETE FROM integrity_lifecycle_audit WHERE tenant_id=? AND report_id=?`).run(tenant, reportId);
      db.prepare(`DELETE FROM integrity_legal_hold_event WHERE tenant_id=? AND report_id=?`).run(tenant, reportId);
      db.prepare(`DELETE FROM integrity_key_revocation WHERE tenant_id=? AND key_id NOT IN (
        SELECT manifest_key_id FROM artifact_manifest WHERE tenant_id=? AND manifest_key_id IS NOT NULL
        UNION SELECT anchor_key_id FROM artifact_manifest WHERE tenant_id=? AND anchor_key_id IS NOT NULL
        UNION SELECT key_id FROM integrity_daily_root WHERE tenant_id=?
        UNION SELECT key_id FROM integrity_retention_tombstone WHERE tenant_id=?
      )`).run(tenant, tenant, tenant, tenant, tenant);
      db.prepare(`DELETE FROM integrity_signing_key WHERE tenant_id=? AND key_id NOT IN (
        SELECT manifest_key_id FROM artifact_manifest WHERE tenant_id=? AND manifest_key_id IS NOT NULL
        UNION SELECT anchor_key_id FROM artifact_manifest WHERE tenant_id=? AND anchor_key_id IS NOT NULL
        UNION SELECT key_id FROM integrity_daily_root WHERE tenant_id=?
        UNION SELECT key_id FROM integrity_retention_tombstone WHERE tenant_id=?
      )`).run(tenant, tenant, tenant, tenant, tenant);
      db.prepare("DELETE FROM integrity_retention_completion WHERE tenant_id=? AND report_id=?").run(tenant, reportId);
      db.prepare("UPDATE integrity_report_lifecycle SET reader_state='destroyed',destroyed_at=? WHERE tenant_id=? AND report_id=? AND reader_state='purge_pending'")
        .run(now, tenant, reportId);
    } finally {
      db.prepare("UPDATE integrity_retention_purge_guard SET enabled=0 WHERE id=1").run();
    }
  })();
}

/** Complete destruction only after report/archive, verification-material and
 * durable backup/registry retention obligations have all ended. */
export function destroyRetainedReport(db: DB, input: { report_id: string; actor_id: string; signer: AnchorSigner; backupReceiptVerifier: BackupRetentionReceiptVerifier; now?: string; deleteFiles?: (bodyPath: string) => void }): RetentionResult {
  const now = input.now ?? new Date().toISOString();
  const lifecycle = lifecycleRow(db, input.report_id);
  if (!lifecycle) return db.prepare("SELECT 1 FROM report WHERE id=?").get(input.report_id) ? { kind: "retention_not_eligible" } : { kind: "not_found" };
  if (lifecycle.reader_state === "destroyed") return { kind: "already_destroyed" };
  if (activeHolds(db, input.report_id).length) {
    db.transaction(() => audit(db, input.report_id, "deletion_blocked_legal_hold", "legal_hold_active", now, input.actor_id))();
    return { kind: "legal_hold" };
  }
  const artifacts = artifactRows(db, input.report_id);
  const eligible = Date.parse(lifecycle.readable_until) <= Date.parse(now)
    && Date.parse(lifecycle.archive_until) <= Date.parse(now)
    && artifacts.length > 0
    && artifacts.every((artifact) => artifact.retain_until != null && Date.parse(artifact.retain_until) <= Date.parse(now));
  if (!eligible) {
    db.transaction(() => audit(db, input.report_id, "retention_not_eligible", "retention_window_active", now, input.actor_id))();
    return { kind: "retention_not_eligible" };
  }
  const completion = db.prepare(`SELECT backup_reference,backup_receipt,backup_receipt_hash,backup_receipt_signature,backup_receipt_key_id,registry_record_id,registry_ref
    FROM integrity_retention_completion WHERE tenant_id=? AND report_id=?`).get(tenant, input.report_id) as RetentionCompletionRow | undefined;
  const receipt = completion && {
    reference: completion.backup_reference,
    receipt: completion.backup_receipt,
    signature: completion.backup_receipt_signature,
    key_id: completion.backup_receipt_key_id,
  };
  if (!completion || !receipt || completion.backup_receipt_hash !== receiptHash(receipt) || !input.backupReceiptVerifier.verify(receipt)) {
    db.transaction(() => audit(db, input.report_id, "retention_not_eligible", "retention_prerequisites_unmet", now, input.actor_id))();
    return { kind: "retention_prerequisites_unmet" };
  }
  if (!db.prepare("SELECT 1 FROM report WHERE id=?").get(input.report_id)) return { kind: "not_found" };
  if (lifecycle.reader_state === "delete_pending") {
    const payload = {
      tombstone_schema_version: "retention-tombstone-v1",
      report_id: input.report_id,
      destroyed_at: now,
      artifacts: artifacts.map(({ artifact_id, artifact_version, anchor_object_key, manifest_hash, anchor_payload_hash, last_outcome }) => ({ artifact_id, artifact_version, locator: anchor_object_key, manifest_hash, anchor_payload_hash, last_check_outcome: last_outcome })),
    };
    const canonical = jcs(payload);
    const payloadHash = sha256(new TextEncoder().encode(canonical));
    const signature = sign(null, Buffer.concat([Buffer.from(TOMBSTONE_DOMAIN), Buffer.from(canonical)]), input.signer.private_key).toString("base64url");
    // A rotated tombstone signer must have public verification material retained
    // before its signature becomes the only record of a destroyed report.
    registerAnchorSigningKey(db, input.signer);
    db.transaction(() => {
      const written = db.prepare(`INSERT OR IGNORE INTO integrity_retention_tombstone(tenant_id,report_id,payload,payload_hash,signature,key_id,algorithm,destroyed_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(tenant, input.report_id, canonical, payloadHash, signature, input.signer.key_id, "ed25519", now).changes === 1;
      if (!written) throw new Error("retention_tombstone_conflict");
      db.prepare("UPDATE integrity_report_lifecycle SET reader_state='purge_pending' WHERE tenant_id=? AND report_id=? AND reader_state='delete_pending'")
        .run(tenant, input.report_id);
      audit(db, input.report_id, "retention_tombstone_written", "retention_expired", now, input.actor_id);
    })();
  }
  if (lifecycle.artifact_body_path) {
    const remove = input.deleteFiles ?? ((bodyPath: string) => {
      for (const ext of [".md", ".html"]) rmSync(`${bodyPath}${ext}`, { force: true });
    });
    remove(lifecycle.artifact_body_path);
  }
  purgeRetainedMaterial(db, input.report_id, now);
  return { kind: "destroyed" };
}

/** The only reader-safe admin conclusion after destruction. It intentionally
 * omits the signed payload, object locator, hashes, and signature. */
export function retentionConclusionForAdmin(db: DB, reportId: string): { conclusion: string; destroyed_at: string } | null {
  if (!tableExists(db, "provenance_redaction")) return null;
  const row = db.prepare(`SELECT effective_at AS destroyed_at FROM provenance_redaction
    WHERE entity_key=? AND scope='report' AND reason_code='retention_expired'`).get(`report:${reportId}`) as { destroyed_at: string } | undefined;
  return row ? { conclusion: "内容保留期已结束，原始内容不再可验证", destroyed_at: row.destroyed_at } : null;
}

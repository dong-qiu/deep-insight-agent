/** Deterministic P1c gate: canonical bytes, retention and recovery must not drift. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { anchorPayload, contentHash, jcs, manifestForArtifact, manifestHash, MemoryAnchorStore, sha256 } from "../src/lib/db/integrity-anchors.js";
import { commitAnchoredPublication, writeDailyMerkleRoot, writePlannedAnchor } from "../src/lib/db/integrity-publication.js";
import { verifyArtifactIntegrity } from "../src/lib/db/integrity-checks.js";
import { completeRetentionDestruction, destroyRetainedReport, recordLegalHold, requestReportDeletion, retentionConclusionForAdmin } from "../src/lib/db/integrity-lifecycle.js";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { getReport } from "../src/lib/db/reports.js";
import { insertTopic } from "../src/lib/db/repos.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult } from "../src/lib/db/p1-metrics-facts.js";
import { readP1DashboardMetrics } from "../src/lib/db/p1-dashboard.js";
import { deploymentAnchorPublication } from "../src/lib/runtime/integrity-anchor-runtime.js";

const backupKeys = generateKeyPairSync("ed25519");
const backupKeyId = "eval-backup-key";
process.env.RETENTION_BACKUP_RECEIPT_KEY_ID = backupKeyId;
process.env.RETENTION_BACKUP_RECEIPT_PUBLIC_KEY_PEM = backupKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.REDACTION_REGISTRY_BUCKET = "redaction-registry";
process.env.REDACTION_REGISTRY_KMS_KEY_ID = "redaction-kms";
process.env.REDACTION_HMAC_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:redaction";
process.env.REDACTION_HMAC_KEY_VERSION = "v1";
Object.defineProperty(SecretsManagerClient.prototype, "send", { value: async () => ({ SecretString: "a".repeat(32) }) });
Object.defineProperty(KMSClient.prototype, "send", { value: async () => ({ Plaintext: Buffer.alloc(32, 1), CiphertextBlob: Buffer.from("encrypted-data-key") }) });
Object.defineProperty(S3Client.prototype, "send", { value: async () => ({}) });
function signedReceipt() {
  const payload = { report_id: "check-report", deletion_request_id: "eval-retention-check-report", scope: "report" as const, reference: "backup://eval/check-report", receipt: "eval backup receipt", redaction_expiry_at: "2037-01-02T00:00:00.000Z", key_id: backupKeyId };
  return { ...payload, signature: sign(null, Buffer.from(jcs(payload)), backupKeys.privateKey).toString("base64url") };
}

const content = new TextEncoder().encode("abc");
const manifest = manifestForArtifact({
  tenant_id: "default", report_id: "report-0001", artifact_id: "artifact-0001", artifact_version: "v1",
  length: content.byteLength, media_type: "text/plain", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-0001", content,
});
assert.equal(contentHash(content), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(manifestHash(manifest), "85b88d5667e4e5e36dc461ff25b6f2b225354623774baddd9b3fddb6dae04907");
assert.equal(sha256(new TextEncoder().encode(jcs(anchorPayload(manifest, "2026-08-21T00:00:01Z")))), "e9c15e12b101ae5d11b7f778e1ea27e6722569f813e324026d305260157a7bb0");

const db = openDb(":memory:");
applyProvenanceMigrations(db);
const store = new MemoryAnchorStore();
const oldKeys = generateKeyPairSync("ed25519");
const oldSigner = { key_id: "eval-root-old", private_key: oldKeys.privateKey };
assert.deepEqual(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00.000Z", oldSigner, "2027-01-01T00:00:00.000Z"), { status: "committed" });
const rotatedSigner = { key_id: "eval-root-next", private_key: generateKeyPairSync("ed25519").privateKey };
assert.deepEqual(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00.000Z", rotatedSigner, "2027-01-01T00:00:00.000Z"), { status: "recovered" });
assert.equal((db.prepare("SELECT key_id FROM integrity_daily_root WHERE utc_date='2026-08-21'").get() as { key_id: string }).key_id, oldSigner.key_id);

const pem = oldKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
assert.throws(
  () => deploymentAnchorPublication({ INTEGRITY_ANCHOR_BUCKET: "bucket", INTEGRITY_ANCHOR_KEY_ID: "eval-key", INTEGRITY_ANCHOR_PRIVATE_KEY_PEM: pem }, new Date("2026-08-21T00:00:00.000Z")),
  /integrity_anchor_retention_policy_required/,
);

// The checker vector is deliberately separate from the daily-root fixture: it
// fixes the terminal outcomes for a signed artifact and a one-byte tamper.
insertTopic(db, { id: "check-topic", name: "check", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('check-report','brief','check-topic','generating','2026-08-21T00:00:00Z','check',NULL,'[]','[]',NULL,0,'{}')").run();
db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('check-effect',NULL,NULL,'check-report','report_file','check-effect','[]','{}','planned',NULL,'2026-08-21T00:00:00Z','2026-08-21T00:00:00Z')").run();
const checkKeys = generateKeyPairSync("ed25519");
const checkSigner = { key_id: "eval-check-key", private_key: checkKeys.privateKey };
const checkManifest = manifestForArtifact({ tenant_id: "default", report_id: "check-report", artifact_id: "check-report-md", artifact_version: "v1", length: content.byteLength, media_type: "text/markdown", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-check", content });
await writePlannedAnchor(db, store, { generation_effect_id: "check-effect", manifest: checkManifest, issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" }, checkSigner);
commitAnchoredPublication(db, { manifest: checkManifest, generation_effect_id: "check-effect", provider_version_id: null, public_key: checkKeys.publicKey, finalize: () => db.prepare("UPDATE report SET status='done' WHERE id='check-report'").run() });
assert.equal((await verifyArtifactIntegrity(db, store, { artifact_id: "check-report-md", artifact_version: "v1", readArtifact: async () => content }, "2026-08-22T01:00:00.000Z")).outcome, "pass");
assert.equal((await verifyArtifactIntegrity(db, store, { artifact_id: "check-report-md", artifact_version: "v1", readArtifact: async () => new TextEncoder().encode("abd") }, "2026-08-22T01:01:00.000Z")).outcome, "content_mismatch");

// P1d lifecycle fixture: legal hold dominates deletion, a delete request
// immediately withdraws reader visibility, and evidence cannot be destroyed
// before retain_until. The reader path only resolves the committed snapshot.
assert.equal(await recordLegalHold(db, { report_id: "check-report", hold_id: "eval-hold", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-08-22T01:02:00.000Z", store, retain_until: "2036-08-22T01:02:00.000Z" }), true);
assert.deepEqual(requestReportDeletion(db, { report_id: "check-report", actor_id: "admin", readable_until: "2026-08-23T00:00:00.000Z", archive_until: "2026-08-24T00:00:00.000Z", now: "2026-08-22T01:03:00.000Z" }), { kind: "legal_hold" });
assert.equal(await recordLegalHold(db, { report_id: "check-report", hold_id: "eval-hold", action: "released", actor_id: "counsel", reason_code: "legal_released", occurred_at: "2026-08-22T01:04:00.000Z" }), true);
assert.deepEqual(requestReportDeletion(db, { report_id: "check-report", actor_id: "admin", readable_until: "2026-08-23T00:00:00.000Z", archive_until: "2026-08-24T00:00:00.000Z", now: "2026-08-22T01:05:00.000Z" }), { kind: "delete_pending" });
assert.equal(getReport(db, "check-report"), null);
assert.deepEqual(destroyRetainedReport(db, { report_id: "check-report", actor_id: "admin", signer: checkSigner, now: "2026-08-25T00:00:00.000Z" }), { kind: "retention_not_eligible" });
assert.deepEqual(destroyRetainedReport(db, { report_id: "check-report", actor_id: "admin", signer: checkSigner, now: "2027-01-02T00:00:00.000Z" }), { kind: "retention_prerequisites_unmet" });
assert.equal(await completeRetentionDestruction(db, {
  report_id: "check-report",
  actor_id: "admin",
  deletion_request_id: "eval-retention-check-report",
  backup_receipt: signedReceipt(),
  completed_at: "2027-01-02T00:00:00.000Z",
}), true);
assert.deepEqual(destroyRetainedReport(db, { report_id: "check-report", actor_id: "admin", signer: checkSigner, now: "2027-01-02T00:00:00.000Z" }), { kind: "destroyed" });
assert.equal(retentionConclusionForAdmin(db, "check-report")?.conclusion, "内容保留期已结束，原始内容不再可验证");
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='check-report'").get() as { n: number }).n, 0);

// P1 dashboard vector: the administrator read model remains fact-backed,
// bounded and independent of the published-report resolver.
const metricAt = "2026-08-21T01:00:00.000Z";
appendFunnelEvent(db, { event_id: "eval-received", trace_id: "eval-trace", stage: "received", pipeline_version: "eval-v1", occurred_at: metricAt, ingested_at: metricAt });
appendFunnelEvent(db, { event_id: "eval-failed", trace_id: "eval-trace", stage: "failed", pipeline_version: "eval-v1", reason_code: "quote_not_in_source", occurred_at: "2026-08-21T01:00:01.000Z", ingested_at: "2026-08-21T01:00:01.000Z" });
appendCostLedger(db, { entry_id: "eval-cost", trace_id: "eval-trace", stage: "processed", pipeline_version: "eval-v1", provider: "eval", model: "eval-model", currency: "USD", amount_minor: 3, cost_status: "known", occurred_at: metricAt, ingested_at: metricAt });
appendValidatorResult(db, { result_id: "eval-validator", trace_id: "eval-trace", stage: "validated", pipeline_version: "eval-v1", validator: "citation", rule_version: "eval-v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: metricAt, ingested_at: metricAt });
const dashboard = readP1DashboardMetrics(db, { from: "2026-08-21T00:00:00.000Z", to: "2026-08-22T00:00:00.000Z" });
assert.equal(dashboard.funnel.find((row) => row.stage === "received")?.received_traces, 1);
assert.equal(dashboard.funnel_loss_reasons[0]?.reason_code, "quote_not_in_source");
assert.equal(dashboard.validator_reasons[0]?.rule_version, "eval-v1");

console.log(JSON.stringify({ gate: "provenance-dashboard-integrity-v1", result: "pass", vectors: 18, content_hash: manifest.content_hash, manifest_hash: manifestHash(manifest) }));

import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jcs, MemoryAnchorStore, manifestForArtifact, type AnchorSigner } from "./integrity-anchors.js";
import { completeRetentionDestruction, destroyRetainedReport, isReportReaderVisible, purgeExpiredRetentionTombstones, recordLegalHold, requestReportDeletion, retentionConclusionForAdmin } from "./integrity-lifecycle.js";
import { commitAnchoredPublication, writeDailyMerkleRoot, writePlannedAnchor } from "./integrity-publication.js";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { applyRedactionTombstone } from "./redaction.js";
import { getReport, queryReportIndex } from "./reports.js";
import { insertTopic } from "./repos.js";
import { KmsEd25519AnchorSigner } from "../runtime/integrity-anchor-runtime.js";

const encoder = new TextEncoder();
const cleanup: string[] = [];
type Ed25519KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

const backupKeys = generateKeyPairSync("ed25519") as Ed25519KeyPair;
const backupKeyId = "backup-key-v1";
process.env.RETENTION_BACKUP_RECEIPT_KEY_ID = backupKeyId;
process.env.RETENTION_BACKUP_RECEIPT_PUBLIC_KEY_PEM = backupKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.REDACTION_REGISTRY_BUCKET = "redaction-registry";
process.env.REDACTION_REGISTRY_KMS_KEY_ID = "redaction-kms";
process.env.REDACTION_HMAC_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:redaction";
process.env.REDACTION_HMAC_KEY_VERSION = "v1";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-02T00:00:00.000Z"));
  vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: "a".repeat(32) } as never);
  vi.spyOn(KMSClient.prototype, "send").mockResolvedValue({ Plaintext: Buffer.alloc(32, 1), CiphertextBlob: Buffer.from("encrypted-data-key") } as never);
  vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function signedReceipt(report_id = "report", deletion_request_id = "retention-report-2026-02-02") {
  const payload = { report_id, deletion_request_id, scope: "report" as const, reference: `backup://retention/${report_id}`, receipt: "backup receipt body", redaction_expiry_at: "2036-02-02T00:00:00.000Z", key_id: backupKeyId };
  return { ...payload, signature: sign(null, Buffer.from(jcs(payload)), backupKeys.privateKey).toString("base64url") };
}

async function completeRetention(db: DB, backupReceipt = signedReceipt()): Promise<boolean> {
  return completeRetentionDestruction(db, {
    report_id: backupReceipt.report_id,
    actor_id: "admin",
    deletion_request_id: backupReceipt.deletion_request_id,
    backup_receipt: backupReceipt,
    completed_at: "2026-02-02T00:00:00.000Z",
  });
}

async function seeded(retainUntil = "2026-02-01T00:00:00.000Z"): Promise<{ db: DB; signer: AnchorSigner; reportPath: string; store: MemoryAnchorStore }> {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  insertTopic(db, { id: "topic", name: "Topic", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
  const dir = await mkdtemp(join(tmpdir(), "integrity-lifecycle-")); cleanup.push(dir);
  const reportPath = join(dir, "report");
  await writeFile(`${reportPath}.md`, "# retained", "utf8"); await writeFile(`${reportPath}.html`, "<h1>retained</h1>", "utf8");
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('report','brief','topic','generating','2026-01-01T00:00:00.000Z','R',?,'[]','[]',NULL,0,'{}')").run(reportPath);
  db.prepare("INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count) VALUES ('report','brief','topic','[]','2026-01-01','[]','R','retained','[]','[]','[]',0,'[]',0)").run();
  db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES ('report','R','retained','retained')").run();
  db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('effect',NULL,NULL,'report','report_file','effect','[]','{}','planned',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
  const keys = generateKeyPairSync("ed25519") as Ed25519KeyPair;
  const signer: AnchorSigner = { key_id: "retention-key", private_key: keys.privateKey };
  const content = encoder.encode("retained");
  const manifest = manifestForArtifact({ tenant_id: "default", report_id: "report", artifact_id: "report-md", artifact_version: "v1", length: content.byteLength, media_type: "text/markdown", created_at: "2026-01-01T00:00:00.000Z", upstream_trace_id: "trace", content });
  const store = new MemoryAnchorStore();
  await writePlannedAnchor(db, store, { generation_effect_id: "effect", manifest, issued_at: "2026-01-01T00:00:01.000Z", retain_until: retainUntil }, signer);
  commitAnchoredPublication(db, { manifest, generation_effect_id: "effect", provider_version_id: null, public_key: keys.publicKey, finalize: () => db.prepare("UPDATE report SET status='done' WHERE id='report'").run() });
  return { db, signer, reportPath, store };
}

function held(db: DB, store: MemoryAnchorStore, hold_id: string, action: "placed" | "released", occurred_at: string) {
  return recordLegalHold(db, { report_id: "report", hold_id, action, actor_id: "counsel", reason_code: action === "placed" ? "legal_request" : "legal_release", occurred_at,
    ...(action === "placed" ? { store, retain_until: "2036-02-02T00:00:00.000Z" } : {}) });
}

function restorePreExternalHoldRootSchema(db: DB): void {
  db.exec(`
    DROP TABLE integrity_daily_root_material;
    DROP TABLE integrity_legal_hold_external_proof;
    DROP TABLE integrity_legal_hold_extension_failure;
  `);
  db.prepare("DELETE FROM schema_migration WHERE version IN ('20260825_30_integrity_lifecycle_external_hold','20260825_31_integrity_daily_root_material_backfill')").run();
}

describe("integrity retention lifecycle", () => {
  it("uses delete_pending as a reader-only withdrawal while keeping every verification material row", async () => {
    const { db } = await seeded();
    expect(requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" })).toEqual({ kind: "delete_pending" });
    expect(isReportReaderVisible(db, "report")).toBe(false);
    expect(getReport(db, "report")).toBeNull();
    expect(queryReportIndex(db, { topic: "topic" })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 1 });
  });

  it("rejects deletion and writes a locator-free audit while a legal hold is active", async () => {
    const { db, store } = await seeded();
    await expect(held(db, store, "hold-1", "placed", "2026-01-02T00:00:00.000Z")).resolves.toBe(true);
    expect(requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:01.000Z" })).toEqual({ kind: "legal_hold" });
    expect(db.prepare("SELECT event_type,reason_code FROM integrity_lifecycle_audit").get()).toEqual({ event_type: "deletion_blocked_legal_hold", reason_code: "legal_hold_active" });
    expect(db.prepare("SELECT reason_code FROM integrity_lifecycle_audit").get()).not.toHaveProperty("anchor_object_key");
  });

  it("extends every external anchor before recording a hold and fences cleanup on extension failure", async () => {
    const { db } = await seeded();
    const calls: Array<{ key: string; version: string | null; retainUntil: string }> = [];
    const provider = {
      async putIfAbsent() { throw new Error("unused"); }, async get() { return null; },
      async extendRetention(key: string, version: string | null, retainUntil: string) { calls.push({ key, version, retainUntil }); return { retain_until: retainUntil }; },
    };
    await expect(recordLegalHold(db, { report_id: "report", hold_id: "hold-external", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-01-02T00:00:00.000Z", store: provider, retain_until: "2036-02-02T00:00:00.000Z" })).resolves.toBe(true);
    expect(calls).toEqual([{ key: expect.stringContaining("integrity-anchors/"), version: null, retainUntil: "2036-02-02T00:00:00.000Z" }]);
    expect(db.prepare("SELECT object_key,retain_until FROM integrity_legal_hold_external_proof WHERE hold_id='hold-external'").get()).toEqual({ object_key: calls[0]!.key, retain_until: "2036-02-02T00:00:00.000Z" });

    const failing = { ...provider, async extendRetention() { throw new Error("object_lock_unavailable"); } };
    await expect(recordLegalHold(db, { report_id: "report", hold_id: "hold-failed", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-01-02T00:00:01.000Z", store: failing, retain_until: "2036-02-02T00:00:00.000Z" })).rejects.toThrow("object_lock_unavailable");
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_legal_hold_event WHERE hold_id='hold-failed'").get()).toEqual({ n: 0 });
    expect(requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:02.000Z" })).toEqual({ kind: "legal_hold" });
  });

  it("does not open cleanup before a verification-material retention longer than 100 days ends", async () => {
    const { db, signer } = await seeded("2026-08-01T00:00:00.000Z");
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-06-01T00:00:00.000Z" })).toEqual({ kind: "retention_not_eligible" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT reason_code FROM integrity_lifecycle_audit ORDER BY created_at DESC LIMIT 1").get()).toEqual({ reason_code: "retention_window_active" });
  });

  it("retains a verifiable signed tombstone and public key after destruction", async () => {
    const { db, signer, reportPath } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-01-12T00:00:00.000Z" })).toEqual({ kind: "retention_not_eligible" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });

    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "retention_prerequisites_unmet" });
    expect(db.prepare("SELECT reader_state FROM integrity_report_lifecycle WHERE report_id='report'").get()).toEqual({ reader_state: "delete_pending" });
    await expect(readFile(`${reportPath}.md`, "utf8")).resolves.toBe("# retained");
    expect(await completeRetention(db)).toBe(true);
    let durableTombstoneObserved = false;
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z", deleteFiles: (bodyPath) => {
      const tombstone = db.prepare("SELECT payload,payload_hash,signature FROM integrity_retention_tombstone WHERE report_id='report'").get() as { payload: string; payload_hash: string; signature: string };
      expect(tombstone.payload_hash).toHaveLength(64);
      expect(verify(null, Buffer.concat([Buffer.from("retention-tombstone-v1\0"), Buffer.from(tombstone.payload)]), signer.private_key!, Buffer.from(tombstone.signature, "base64url"))).toBe(true);
      durableTombstoneObserved = true;
      rmSync(`${bodyPath}.md`, { force: true }); rmSync(`${bodyPath}.html`, { force: true });
    } })).toEqual({ kind: "destroyed" });
    expect(durableTombstoneObserved).toBe(true);
    await expect(readFile(`${reportPath}.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(retentionConclusionForAdmin(db, "report")).toEqual({ conclusion: "内容保留期已结束，原始内容不再可验证", destroyed_at: "2026-02-02T00:00:00.000Z" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_check").get()).toEqual({ n: 0 });
    const retained = db.prepare("SELECT payload,payload_hash,signature,key_id,retain_until FROM integrity_retention_tombstone WHERE report_id='report'").get() as { payload: string; payload_hash: string; signature: string; key_id: string; retain_until: string };
    const key = db.prepare("SELECT public_key_pem FROM integrity_signing_key WHERE key_id=?").get(retained.key_id) as { public_key_pem: string };
    expect(retained.payload_hash).toHaveLength(64);
    expect(retained.retain_until).toBe("2036-02-02T00:00:00.000Z");
    expect(verify(null, Buffer.concat([Buffer.from("retention-tombstone-v1\0"), Buffer.from(retained.payload)]), createPublicKey(key.public_key_pem), Buffer.from(retained.signature, "base64url"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM provenance_redaction WHERE entity_key='report:report'").get()).toEqual({ n: 1 });
    expect(getReport(db, "report")).toBeNull();
    expect(purgeExpiredRetentionTombstones(db, "2036-02-01T23:59:59.999Z")).toBe(0);
    expect(purgeExpiredRetentionTombstones(db, "2036-02-02T00:00:00.000Z")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM provenance_redaction WHERE entity_key='report:report'").get()).toEqual({ n: 1 });
  });

  it("writes a verifiable retention tombstone through a mocked KMS signer", async () => {
    const { db } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    const keys = generateKeyPairSync("ed25519");
    const kms = { send: async (command: unknown) => {
      const input = command as { input: { Message?: Uint8Array } };
      return input.input.Message
        ? { Signature: sign(null, input.input.Message, keys.privateKey) }
        : { PublicKey: keys.publicKey.export({ type: "spki", format: "der" }), SigningAlgorithms: ["EDDSA"] };
    } };
    const signer = await KmsEd25519AnchorSigner.create("alias/deep-insight-integrity-signing", kms);
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    const tombstone = db.prepare("SELECT payload,signature FROM integrity_retention_tombstone WHERE report_id='report'").get() as { payload: string; signature: string };
    expect(verify(null, Buffer.concat([Buffer.from("retention-tombstone-v1\0"), Buffer.from(tombstone.payload)]), keys.publicKey, Buffer.from(tombstone.signature, "base64url"))).toBe(true);
  });

  it("lets a legal hold placed while KMS signs fence destruction", async () => {
    const { db, store } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    const keys = generateKeyPairSync("ed25519");
    let started!: () => void;
    const startedSigning = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releaseSigning = new Promise<void>((resolve) => { release = resolve; });
    const signer: AnchorSigner = {
      key_id: "delayed-kms-key", public_key: keys.publicKey,
      sign: async (message) => { started(); await releaseSigning; return sign(null, message, keys.privateKey); },
    };
    const destruction = destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" });
    await startedSigning;
    await expect(held(db, store, "hold-during-kms", "placed", "2026-02-02T00:00:00.000Z")).resolves.toBe(true);
    release();
    expect(await destruction).toEqual({ kind: "legal_hold" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone WHERE report_id='report'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });
  });

  it("retains a destroyed report's tombstone proof through hold release", async () => {
    const { db, signer, store } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });

    await expect(held(db, store, "hold-after-destruction", "placed", "2030-01-01T00:00:00.000Z")).resolves.toBe(true);
    expect(db.prepare("SELECT material_kind,material_id,retain_until FROM integrity_legal_hold_material WHERE hold_id=? ORDER BY material_kind").all("hold-after-destruction")).toEqual(expect.arrayContaining([
      { material_kind: "retention_tombstone", material_id: "report", retain_until: "2036-02-02T00:00:00.000Z" },
      { material_kind: "signing_key", material_id: "retention-key", retain_until: null },
    ]));
    expect(purgeExpiredRetentionTombstones(db, "2036-02-02T00:00:00.000Z")).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone WHERE report_id='report'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key WHERE key_id='retention-key'").get()).toEqual({ n: 1 });

    await expect(held(db, store, "hold-after-destruction", "released", "2036-02-03T00:00:00.000Z")).resolves.toBe(true);
    expect(purgeExpiredRetentionTombstones(db, "2036-02-03T00:00:00.000Z")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone WHERE report_id='report'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key WHERE key_id='retention-key'").get()).toEqual({ n: 0 });
  });

  it("does not let a local tombstone or backup reference claim external completion", async () => {
    const { db, signer } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    applyRedactionTombstone(db, { record_id: "forged-local-record", entity_key: "report:report", scope: "report", reason_code: "retention_expired", effective_at: "2026-02-02T00:00:00.000Z", expiry_at: "2036-02-02T00:00:00.000Z", registry_ref: "backup://forged-reference" });
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "retention_prerequisites_unmet" });
    await expect(completeRetention(db)).rejects.toThrow("retention_registry_completion_missing");
  });

  it("keeps every snapshot material through an expired retention window until the legal hold is released", async () => {
    const { db, signer, store } = await seeded("2026-01-15T00:00:00.000Z");
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    await expect(held(db, store, "hold-1", "placed", "2026-01-12T00:00:00.000Z")).resolves.toBe(true);
    expect(db.prepare("SELECT material_kind,COUNT(*) AS n FROM integrity_legal_hold_material GROUP BY material_kind ORDER BY material_kind").all()).toEqual(expect.arrayContaining([
      { material_kind: "anchor", n: 1 }, { material_kind: "artifact_manifest", n: 1 }, { material_kind: "signing_key", n: 1 },
    ]));
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "legal_hold" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 1 });
    await expect(held(db, store, "hold-1", "released", "2026-02-03T00:00:00.000Z")).resolves.toBe(true);
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-03T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
  });

  it("backfills pre-external-hold daily roots so a hold extends and preserves shared material", async () => {
    const { db, signer, store } = await seeded("2026-02-01T00:00:00.000Z");
    db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('report-b','brief','topic','generating','2026-01-01T00:00:00.000Z','B',NULL,'[]','[]',NULL,0,'{}')").run();
    db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('effect-b',NULL,NULL,'report-b','report_file','effect-b','[]','{}','planned',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
    const content = encoder.encode("other");
    const manifest = manifestForArtifact({ tenant_id: "default", report_id: "report-b", artifact_id: "report-b-md", artifact_version: "v1", length: content.byteLength, media_type: "text/markdown", created_at: "2026-01-01T00:00:00.000Z", upstream_trace_id: "trace", content });
    await writePlannedAnchor(db, store, { generation_effect_id: "effect-b", manifest, issued_at: "2026-01-01T00:00:01.000Z", retain_until: "2026-02-01T00:00:00.000Z" }, signer);
    commitAnchoredPublication(db, { manifest, generation_effect_id: "effect-b", provider_version_id: null, public_key: createPublicKey(signer.private_key!) });
    await writeDailyMerkleRoot(db, store, "2026-02-02", "2026-02-03T02:00:00.000Z", signer, "2026-02-01T00:00:00.000Z");
    // The root was committed before v30 created its leaf-material table. Run
    // the real v29 -> v30 -> v31 upgrade path over that legacy root.
    restorePreExternalHoldRootSchema(db);
    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT report_id FROM integrity_daily_root_material WHERE utc_date='2026-02-02' ORDER BY report_id").all()).toEqual([
      { report_id: "report" }, { report_id: "report-b" },
    ]);
    const extended: string[] = [];
    const holdStore = {
      async putIfAbsent() { throw new Error("unused"); },
      async get() { return null; },
      async extendRetention(objectKey: string, _providerVersionId: string | null, retainUntil: string) {
        extended.push(objectKey);
        return { retain_until: retainUntil };
      },
    };
    await expect(recordLegalHold(db, { report_id: "report", hold_id: "hold-a", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-02-02T00:00:00.000Z", store: holdStore, retain_until: "2036-02-02T00:00:00.000Z" })).resolves.toBe(true);
    expect(extended).toContain("integrity-daily-roots/v1/default/2026-02-02/root.json");
    requestReportDeletion(db, { report_id: "report-b", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db, signedReceipt("report-b", "retention-report-b"));
    expect(await destroyRetainedReport(db, { report_id: "report-b", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_daily_root WHERE utc_date='2026-02-02'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT key_id FROM integrity_daily_root WHERE utc_date='2026-02-02'").get()).toEqual(expect.any(Object));
    await held(db, store, "hold-a", "released", "2026-02-03T00:00:00.000Z");
    // A controlled later destruction/retry is now allowed to clean expired root material.
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-03T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_daily_root WHERE utc_date='2026-02-02'").get()).toEqual({ n: 0 });
  });

  it("fails closed when surviving same-day leaves cannot reproduce a legacy root", async () => {
    const { db, signer, store } = await seeded("2026-02-01T00:00:00.000Z");
    await writeDailyMerkleRoot(db, store, "2026-02-02", "2026-02-03T02:00:00.000Z", signer, "2026-02-01T00:00:00.000Z");
    restorePreExternalHoldRootSchema(db);
    // A missing historic leaf replaced by another same-day candidate can keep
    // the count unchanged, so the migration must also verify the Merkle root.
    db.exec("DROP TRIGGER artifact_manifest_no_update");
    db.prepare("UPDATE artifact_manifest SET manifest_hash=? WHERE report_id='report'").run("f".repeat(64));
    db.exec("CREATE TRIGGER artifact_manifest_no_update BEFORE UPDATE ON artifact_manifest BEGIN SELECT RAISE(ABORT, 'artifact_manifest is append-only'); END");
    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_daily_root_material WHERE utc_date='2026-02-02'").get()).toEqual({ n: 0 });

    const extended: string[] = [];
    const holdStore = {
      async putIfAbsent() { throw new Error("unused"); },
      async get() { return null; },
      async extendRetention(objectKey: string, _providerVersionId: string | null, retainUntil: string) {
        extended.push(objectKey);
        return { retain_until: retainUntil };
      },
    };
    await expect(recordLegalHold(db, { report_id: "report", hold_id: "legacy-hold", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-02-02T00:00:00.000Z", store: holdStore, retain_until: "2036-02-02T00:00:00.000Z" })).resolves.toBe(true);
    expect(extended).not.toContain("integrity-daily-roots/v1/default/2026-02-02/root.json");
    await expect(recordLegalHold(db, { report_id: "report", hold_id: "legacy-hold", action: "released", actor_id: "counsel", reason_code: "legal_release", occurred_at: "2026-02-02T00:00:01.000Z" })).resolves.toBe(true);
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "retention-worker", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_daily_root WHERE utc_date='2026-02-02'").get()).toEqual({ n: 1 });
  });

  it("requires a signed backup receipt and a retention-specific registry record", async () => {
    const receiptDb = await seeded();
    requestReportDeletion(receiptDb.db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await expect(completeRetention(receiptDb.db, { ...signedReceipt(), receipt: "forged backup receipt" })).rejects.toThrow("retention_backup_receipt_unverified");
    expect(receiptDb.db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_completion").get()).toEqual({ n: 0 });

    const redactionDb = await seeded();
    requestReportDeletion(redactionDb.db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    applyRedactionTombstone(redactionDb.db, { record_id: "privacy-record", entity_key: "report:report", scope: "report", reason_code: "privacy_request", effective_at: "2026-01-02T00:00:00.000Z", expiry_at: "2036-01-02T00:00:00.000Z", registry_ref: "s3://redaction-registry/records/2026/01/privacy-record.json" });
    await expect(completeRetention(redactionDb.db)).rejects.toThrow("redaction_existing_tombstone_conflict");
    expect(redactionDb.db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_completion").get()).toEqual({ n: 0 });
  });

  it("keeps cleanup retryable after file deletion or database purge failures", async () => {
    const { db, signer, reportPath } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(db);

    await expect(destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z", deleteFiles: () => { throw new Error("disk unavailable"); } })).rejects.toThrow("disk unavailable");
    expect(db.prepare("SELECT reader_state FROM integrity_report_lifecycle WHERE report_id='report'").get()).toEqual({ reader_state: "purge_pending" });
    expect(await destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    await expect(readFile(`${reportPath}.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const second = await seeded();
    requestReportDeletion(second.db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    await completeRetention(second.db);
    second.db.exec("CREATE TRIGGER fail_retention_purge BEFORE DELETE ON generation_effect BEGIN SELECT RAISE(ABORT, 'purge failed'); END");
    await expect(destroyRetainedReport(second.db, { report_id: "report", actor_id: "admin", signer: second.signer, now: "2026-02-02T00:00:00.000Z" })).rejects.toThrow("purge failed");
    expect(second.db.prepare("SELECT reader_state FROM integrity_report_lifecycle WHERE report_id='report'").get()).toEqual({ reader_state: "purge_pending" });
    second.db.exec("DROP TRIGGER fail_retention_purge");
    expect(await destroyRetainedReport(second.db, { report_id: "report", actor_id: "admin", signer: second.signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "destroyed" });
    expect(second.db.prepare("SELECT reader_state FROM integrity_report_lifecycle WHERE report_id='report'").get()).toEqual({ reader_state: "destroyed" });
    expect(await destroyRetainedReport(second.db, { report_id: "report", actor_id: "admin", signer: second.signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "already_destroyed" });
  });
});

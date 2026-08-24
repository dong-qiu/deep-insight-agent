import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAnchorStore, manifestForArtifact } from "./integrity-anchors.js";
import { destroyRetainedReport, isReportReaderVisible, recordLegalHold, recordRetentionDestructionCompletion, requestReportDeletion, retentionConclusionForAdmin } from "./integrity-lifecycle.js";
import { commitAnchoredPublication, writePlannedAnchor } from "./integrity-publication.js";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { applyRedactionTombstone } from "./redaction.js";
import { getReport, queryReportIndex } from "./reports.js";
import { insertTopic } from "./repos.js";

const encoder = new TextEncoder();
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function seeded(retainUntil = "2026-02-01T00:00:00.000Z"): Promise<{ db: DB; signer: { key_id: string; private_key: ReturnType<typeof generateKeyPairSync>["privateKey"] }; reportPath: string }> {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  insertTopic(db, { id: "topic", name: "Topic", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
  const dir = await mkdtemp(join(tmpdir(), "integrity-lifecycle-")); cleanup.push(dir);
  const reportPath = join(dir, "report");
  await writeFile(`${reportPath}.md`, "# retained", "utf8"); await writeFile(`${reportPath}.html`, "<h1>retained</h1>", "utf8");
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('report','brief','topic','generating','2026-01-01T00:00:00.000Z','R',?,'[]','[]',NULL,0,'{}')").run(reportPath);
  db.prepare("INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count) VALUES ('report','brief','topic','[]','2026-01-01','[]','R','retained','[]','[]','[]',0,'[]',0)").run();
  db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES ('report','R','retained','retained')").run();
  db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('effect',NULL,NULL,'report','report_file','effect','[]','{}','planned',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
  const keys = generateKeyPairSync("ed25519"); const signer = { key_id: "retention-key", private_key: keys.privateKey };
  const content = encoder.encode("retained");
  const manifest = manifestForArtifact({ tenant_id: "default", report_id: "report", artifact_id: "report-md", artifact_version: "v1", length: content.byteLength, media_type: "text/markdown", created_at: "2026-01-01T00:00:00.000Z", upstream_trace_id: "trace", content });
  const store = new MemoryAnchorStore();
  await writePlannedAnchor(db, store, { generation_effect_id: "effect", manifest, issued_at: "2026-01-01T00:00:01.000Z", retain_until: retainUntil }, signer);
  commitAnchoredPublication(db, { manifest, generation_effect_id: "effect", provider_version_id: null, public_key: keys.publicKey, finalize: () => db.prepare("UPDATE report SET status='done' WHERE id='report'").run() });
  return { db, signer, reportPath };
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
    const { db } = await seeded();
    expect(recordLegalHold(db, { report_id: "report", hold_id: "hold-1", action: "placed", actor_id: "counsel", reason_code: "legal_request", occurred_at: "2026-01-02T00:00:00.000Z" })).toBe(true);
    expect(requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:01.000Z" })).toEqual({ kind: "legal_hold" });
    expect(db.prepare("SELECT event_type,reason_code FROM integrity_lifecycle_audit").get()).toEqual({ event_type: "deletion_blocked_legal_hold", reason_code: "legal_hold_active" });
    expect(db.prepare("SELECT reason_code FROM integrity_lifecycle_audit").get()).not.toHaveProperty("anchor_object_key");
  });

  it("requires durable backup/registry completion, then purges expired verification material after its signed tombstone", async () => {
    const { db, signer, reportPath } = await seeded();
    requestReportDeletion(db, { report_id: "report", actor_id: "admin", readable_until: "2026-01-10T00:00:00.000Z", archive_until: "2026-01-11T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z" });
    expect(destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-01-12T00:00:00.000Z" })).toEqual({ kind: "retention_not_eligible" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 1 });

    expect(destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z" })).toEqual({ kind: "retention_prerequisites_unmet" });
    expect(db.prepare("SELECT reader_state FROM integrity_report_lifecycle WHERE report_id='report'").get()).toEqual({ reader_state: "delete_pending" });
    await expect(readFile(`${reportPath}.md`, "utf8")).resolves.toBe("# retained");
    applyRedactionTombstone(db, { record_id: "redaction-report", entity_key: "report:report", scope: "report", reason_code: "retention_expired", effective_at: "2026-02-02T00:00:00.000Z", expiry_at: "2036-02-02T00:00:00.000Z", registry_ref: "records/2026/02/redaction-report.json" });
    expect(recordRetentionDestructionCompletion(db, { report_id: "report", actor_id: "admin", backup_reference: "backup://retention/report", registry_record_id: "redaction-report", registry_ref: "records/2026/02/redaction-report.json", completed_at: "2026-02-02T00:00:00.000Z" })).toBe(true);
    let durableTombstoneObserved = false;
    expect(destroyRetainedReport(db, { report_id: "report", actor_id: "admin", signer, now: "2026-02-02T00:00:00.000Z", deleteFiles: (bodyPath) => {
      const tombstone = db.prepare("SELECT payload,payload_hash,signature FROM integrity_retention_tombstone WHERE report_id='report'").get() as { payload: string; payload_hash: string; signature: string };
      expect(tombstone.payload_hash).toHaveLength(64);
      expect(verify(null, Buffer.concat([Buffer.from("retention-tombstone-v1\0"), Buffer.from(tombstone.payload)]), signer.private_key, Buffer.from(tombstone.signature, "base64url"))).toBe(true);
      durableTombstoneObserved = true;
      rmSync(`${bodyPath}.md`, { force: true }); rmSync(`${bodyPath}.html`, { force: true });
    } })).toEqual({ kind: "destroyed" });
    expect(durableTombstoneObserved).toBe(true);
    await expect(readFile(`${reportPath}.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(retentionConclusionForAdmin(db, "report")).toEqual({ conclusion: "内容保留期已结束，原始内容不再可验证", destroyed_at: "2026-02-02T00:00:00.000Z" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest WHERE report_id='report'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_check").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_signing_key").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_retention_tombstone").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM provenance_redaction WHERE entity_key='report:report'").get()).toEqual({ n: 1 });
    expect(getReport(db, "report")).toBeNull();
  });
});

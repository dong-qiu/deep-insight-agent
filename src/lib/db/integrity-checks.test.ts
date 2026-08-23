import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAnchorStore, manifestForArtifact } from "./integrity-anchors.js";
import { commitAnchoredPublication, revokeAnchorSigningKey, writePlannedAnchor } from "./integrity-publication.js";
import { claimIntegrityFailureAlert, runAutomaticIntegrityChecks, verifyArtifactIntegrity } from "./integrity-checks.js";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertTopic } from "./repos.js";

const encoder = new TextEncoder();
const keys = generateKeyPairSync("ed25519");
const signer = { key_id: "check-key", private_key: keys.privateKey };
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function seeded(): DB {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  insertTopic(db, { id: "t1", name: "topic", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('report-1','brief','t1','generating','2026-08-21T00:00:00Z','x',NULL,'[]','[]',NULL,0,'{}')").run();
  db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('effect-1',NULL,NULL,'report-1','report_file','effect-1','[]','{}','planned',NULL,'2026-08-21T00:00:00Z','2026-08-21T00:00:00Z')").run();
  return db;
}
async function committed(db: DB, store = new MemoryAnchorStore()) {
  const content = encoder.encode("abc");
  const manifest = manifestForArtifact({ tenant_id: "default", report_id: "report-1", artifact_id: "report-1-md", artifact_version: "v1", length: content.byteLength, media_type: "text/markdown", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-1", content });
  await writePlannedAnchor(db, store, { generation_effect_id: "effect-1", manifest, issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" }, signer);
  commitAnchoredPublication(db, { manifest, generation_effect_id: "effect-1", provider_version_id: null, public_key: keys.publicKey, finalize: () => db.prepare("UPDATE report SET status='done' WHERE id='report-1'").run() });
  return { store, content };
}

describe("integrity_check revalidation", () => {
  it("records pass using original bytes and continues to verify with a revoked historical key", async () => {
    const db = seeded(); const { store, content } = await committed(db);
    revokeAnchorSigningKey(db, signer.key_id, "rotation", "2026-08-22T00:00:00Z");
    await expect(verifyArtifactIntegrity(db, store, { artifact_id: "report-1-md", artifact_version: "v1", readArtifact: async () => content }, "2026-08-22T01:00:00Z"))
      .resolves.toMatchObject({ outcome: "pass", failure_step: null });
    expect(db.prepare("SELECT outcome,checker_version FROM integrity_check").get()).toEqual({ outcome: "pass", checker_version: "integrity-checker-v1" });
  });

  it("records deterministic outcomes for tampered content and unavailable verification material", async () => {
    const db = seeded(); const { store } = await committed(db);
    const tampered = await verifyArtifactIntegrity(db, store, { artifact_id: "report-1-md", artifact_version: "v1", readArtifact: async () => encoder.encode("abd") }, "2026-08-22T01:00:00Z");
    expect(tampered).toMatchObject({ outcome: "content_mismatch", failure_step: "artifact_bytes", expected_hash_prefix: "ba7816bf8f01" });
    const missing = await verifyArtifactIntegrity(db, { putIfAbsent: (key, body, _retainUntil) => store.putIfAbsent(key, body), get: async () => null }, { artifact_id: "report-1-md", artifact_version: "v1", readArtifact: async () => encoder.encode("abc") }, "2026-08-22T02:00:00Z");
    expect(missing).toMatchObject({ outcome: "verification_material_unavailable", failure_step: "anchor_object" });
    expect(db.prepare("SELECT outcome FROM integrity_check ORDER BY checked_at").all()).toEqual([{ outcome: "content_mismatch" }, { outcome: "verification_material_unavailable" }]);
  });

  it("detects a forged manifest or anchor even when artifact bytes still match", async () => {
    const manifestDb = seeded(); const { store, content } = await committed(manifestDb);
    manifestDb.exec("DROP TRIGGER artifact_manifest_no_update");
    manifestDb.prepare("UPDATE artifact_manifest SET manifest_canonical='{}' WHERE artifact_id='report-1-md'").run();
    await expect(verifyArtifactIntegrity(manifestDb, store, { artifact_id: "report-1-md", artifact_version: "v1", readArtifact: async () => content }, "2026-08-22T01:00:00Z"))
      .resolves.toMatchObject({ outcome: "manifest_mismatch" });

    const anchorDb = seeded(); const anchored = await committed(anchorDb);
    const forgedStore = { putIfAbsent: (key: string, body: Uint8Array, _retainUntil: string) => anchored.store.putIfAbsent(key, body), get: async () => ({ body: encoder.encode("{}"), provider_version_id: null }) };
    await expect(verifyArtifactIntegrity(anchorDb, forgedStore, { artifact_id: "report-1-md", artifact_version: "v1", readArtifact: async () => anchored.content }, "2026-08-22T01:00:00Z"))
      .resolves.toMatchObject({ outcome: "anchor_mismatch" });
  });

  it("limits automatic checks to once per 24 hours and deduplicates notifications", async () => {
    const db = seeded(); const { store } = await committed(db);
    const dir = await mkdtemp(join(tmpdir(), "integrity-check-")); cleanup.push(dir);
    await writeFile(join(dir, "report-1.md"), "tampered", "utf8");
    db.prepare("UPDATE report SET body_path=? WHERE id='report-1'").run(join(dir, "report-1"));
    const notify = vi.fn(); const clock = new Date("2026-08-22T01:00:00Z");
    await expect(runAutomaticIntegrityChecks(db, store, notify, clock)).resolves.toMatchObject({ checked: 1, failed: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(runAutomaticIntegrityChecks(db, store, notify, new Date("2026-08-22T01:05:00Z"))).resolves.toMatchObject({ checked: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("atomically claims only one failure notification in a 30 minute window", async () => {
    const db = seeded(); const check = { artifact_id: "report-1-md", artifact_version: "v1", outcome: "anchor_mismatch" as const, failure_step: "anchor", expected_hash_prefix: null, actual_hash_prefix: null, checked_at: "2026-08-22T01:05:00.000Z" };
    expect(claimIntegrityFailureAlert(db, check)).toBe(true);
    expect(claimIntegrityFailureAlert(db, check)).toBe(false);
    expect(claimIntegrityFailureAlert(db, { ...check, checked_at: "2026-08-22T01:30:00.000Z" })).toBe(true);
  });
});

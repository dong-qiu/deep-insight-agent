import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AnchorObject, type AnchorStore, manifestForArtifact, MemoryAnchorStore } from "./integrity-anchors.js";
import { commitAnchoredPublication, planAnchorPublication, reconcileAnchoredEffects, runDailyAnchorSchedule, writeDailyMerkleRoot, writePlannedAnchor } from "./integrity-publication.js";
import { openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { insertTopic } from "./repos.js";

const keys = generateKeyPairSync("ed25519");
const signer = { key_id: "test-key-v1", private_key: keys.privateKey };
const encoder = new TextEncoder();
function manifest() { return manifestForArtifact({ tenant_id: "default", report_id: "report-1", artifact_id: "report-1-md", artifact_version: "v1", length: 3, media_type: "text/markdown", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-1", content: encoder.encode("abc") }); }
function seeded(): DB {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  insertTopic(db, { id: "t1", name: "topic", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
  db.prepare("INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost) VALUES ('report-1','brief','t1','generating','2026-08-21T00:00:00Z','x',NULL,'[]','[]',NULL,0,'{}')").run();
  db.prepare("INSERT INTO generation_effect(id,trace_id,event_id,report_id,kind,idempotency_key,artifact_manifest,publication_payload,status,error,created_at,updated_at) VALUES ('effect-1',NULL,NULL,'report-1','report_file','effect-1','[]','{}','planned',NULL,'2026-08-21T00:00:00Z','2026-08-21T00:00:00Z')").run();
  return db;
}

describe("P1c publication visibility and recovery", () => {
  it("keeps reports invisible when the final SQLite transaction fails, then reconciles the same anchor", async () => {
    const db = seeded(); const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" }; const store = new MemoryAnchorStore();
    await writePlannedAnchor(db, store, input, signer);
    expect(() => commitAnchoredPublication(db, { manifest: input.manifest, generation_effect_id: input.generation_effect_id, provider_version_id: null, public_key: keys.publicKey, finalize: () => { throw new Error("sqlite_commit_failure"); } })).toThrow("sqlite_commit_failure");
    expect(db.prepare("SELECT status FROM generation_anchor_effect").get()).toEqual({ status: "anchor_written" });
    expect(db.prepare("SELECT status FROM report WHERE id='report-1'").get()).toEqual({ status: "generating" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest").get()).toEqual({ n: 0 });
    expect(await reconcileAnchoredEffects(db, store, keys.publicKey, () => undefined)).toEqual({ reconciled: 1, failed: 0 });
    expect(db.prepare("SELECT status FROM generation_effect WHERE id='effect-1'").get()).toEqual({ status: "committed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_manifest").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT event_type FROM integrity_audit_event ORDER BY created_at").all()).toEqual(expect.arrayContaining([{ event_type: "anchor_written_sqlite_uncommitted" }, { event_type: "anchor_reconciled" }]));
  });

  it("treats a network-unknown write as an exact retry and detects orphan conflicts", async () => {
    const db = seeded(); const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" };
    const objects = new Map<string, AnchorObject>();
    const store: AnchorStore = { async putIfAbsent(key, body) { objects.set(key, { body, provider_version_id: "v1" }); throw new Error("network_unknown"); }, async get(key) { return objects.get(key) ?? null; } };
    await expect(writePlannedAnchor(db, store, input, signer)).resolves.toEqual({ reused: true, provider_version_id: "v1" });
    objects.set(input.manifest.external_anchor.object_key, { body: encoder.encode("{}"), provider_version_id: "v1" });
    expect(await reconcileAnchoredEffects(db, store, keys.publicKey, () => undefined)).toEqual({ reconciled: 0, failed: 1 });
    expect(db.prepare("SELECT status FROM generation_anchor_effect").get()).toEqual({ status: "unknown" });
  });

  it("builds a daily root without changing already committed reader state", async () => {
    const db = seeded(); const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" }; const store = new MemoryAnchorStore();
    await writePlannedAnchor(db, store, input, signer);
    commitAnchoredPublication(db, { manifest: input.manifest, generation_effect_id: "effect-1", provider_version_id: null, public_key: keys.publicKey, finalize: () => db.prepare("UPDATE report SET status='done' WHERE id='report-1'").run() });
    expect(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", signer)).toEqual({ status: "committed" });
    expect(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", signer)).toEqual({ status: "recovered" });
    expect(db.prepare("SELECT status FROM report WHERE id='report-1'").get()).toEqual({ status: "done" });
  });

  it("runs the UTC daily schedule at 02:00 and records a high missing-root audit after 02:15", async () => {
    const db = seeded(); const unavailable: AnchorStore = { async putIfAbsent() { throw new Error("store_unavailable"); }, async get() { return null; } };
    await expect(runDailyAnchorSchedule(db, new MemoryAnchorStore(), signer, "2026-08-22T02:00:00.000Z")).resolves.toEqual({ status: "committed" });
    await expect(runDailyAnchorSchedule(db, unavailable, signer, "2026-08-23T02:15:00.000Z")).resolves.toEqual({ status: "missing" });
    expect(db.prepare("SELECT event_type,severity FROM integrity_audit_event WHERE event_type='daily_anchor_missing'").get()).toEqual({ event_type: "daily_anchor_missing", severity: "high" });
  });
});

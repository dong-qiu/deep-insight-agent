import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AnchorObject, type AnchorStore, manifestForArtifact, MemoryAnchorStore } from "./integrity-anchors.js";
import { claimIntegrityMaintenanceLease, commitAnchoredPublication, planAnchorPublication, reconcileAnchoredEffects, registerAnchorSigningKey, releaseIntegrityMaintenanceLease, revokeAnchorSigningKey, runDailyAnchorSchedule, writeDailyMerkleRoot, writePlannedAnchor } from "./integrity-publication.js";
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
  it("allows exactly one integrity maintenance owner and safely recovers an expired owner", () => {
    const db = seeded();
    const first = claimIntegrityMaintenanceLease(db, new Date("2026-08-22T00:00:00.000Z"));
    expect(first).not.toBeNull();
    expect(claimIntegrityMaintenanceLease(db, new Date("2026-08-22T00:00:01.000Z"))).toBeNull();
    expect(releaseIntegrityMaintenanceLease(db, first!, new Date("2026-08-22T00:00:02.000Z"))).toBe(true);
    const second = claimIntegrityMaintenanceLease(db, new Date("2026-08-22T00:00:03.000Z"));
    expect(second).not.toBeNull();
    expect(claimIntegrityMaintenanceLease(db, new Date("2026-08-22T00:15:02.000Z"))).toBeNull();
    expect(claimIntegrityMaintenanceLease(db, new Date("2026-08-22T00:15:04.000Z"))).not.toBeNull();
  });

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
    expect(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", signer, "2027-01-01T00:00:00Z")).toEqual({ status: "committed" });
    expect(await writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", signer, "2027-01-01T00:00:00Z")).toEqual({ status: "recovered" });
    expect(db.prepare("SELECT status FROM report WHERE id='report-1'").get()).toEqual({ status: "done" });
  });

  it("recovers a canonical daily root with its historical key after signer rotation", async () => {
    const db = seeded(); const store = new MemoryAnchorStore(); const oldKeys = generateKeyPairSync("ed25519");
    const old = { key_id: "daily-old", private_key: oldKeys.privateKey };
    await expect(writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", old, "2027-01-01T00:00:00Z")).resolves.toEqual({ status: "committed" });
    const next = { key_id: "daily-next", private_key: generateKeyPairSync("ed25519").privateKey };
    await expect(writeDailyMerkleRoot(db, store, "2026-08-21", "2026-08-22T02:00:00Z", next, "2027-01-01T00:00:00Z")).resolves.toEqual({ status: "recovered" });
    expect(db.prepare("SELECT key_id,algorithm,issued_at FROM integrity_daily_root WHERE utc_date='2026-08-21'").get()).toMatchObject({ key_id: "daily-old", algorithm: "ed25519" });
  });

  it("rejects non-canonical daily-root bytes instead of JSON-normalizing them", async () => {
    const db = seeded(); const store = new MemoryAnchorStore(); const date = "2026-08-21";
    await writeDailyMerkleRoot(db, store, date, "2026-08-22T02:00:00Z", signer, "2027-01-01T00:00:00Z");
    const key = `integrity-daily-roots/v1/default/${date}/root.json`;
    const original = await store.get(key);
    if (!original) throw new Error("expected daily root");
    store.replaceForTest(key, encoder.encode(` ${new TextDecoder().decode(original.body)}`));
    await expect(writeDailyMerkleRoot(db, store, date, "2026-08-22T02:00:00Z", signer, "2027-01-01T00:00:00Z")).rejects.toThrow("daily_anchor_noncanonical_body");
  });

  it("runs the UTC daily schedule at 02:00 and records a high missing-root audit after 02:15", async () => {
    const db = seeded(); const unavailable: AnchorStore = { async putIfAbsent() { throw new Error("store_unavailable"); }, async get() { return null; } };
    await expect(runDailyAnchorSchedule(db, new MemoryAnchorStore(), signer, "2027-01-01T00:00:00Z", "2026-08-22T02:00:00.000Z")).resolves.toEqual({ status: "committed" });
    await expect(runDailyAnchorSchedule(db, unavailable, signer, "2027-01-01T00:00:00Z", "2026-08-23T02:15:00.000Z")).resolves.toEqual({ status: "missing" });
    expect(db.prepare("SELECT event_type,severity FROM integrity_audit_event WHERE event_type='daily_anchor_missing'").get()).toEqual({ event_type: "daily_anchor_missing", severity: "high" });
  });

  it("retains historical key material but blocks a planned publication after key revocation", async () => {
    const db = seeded(); const oldKeys = generateKeyPairSync("ed25519"); const old = { key_id: "old-key", private_key: oldKeys.privateKey };
    const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" };
    const store = new MemoryAnchorStore();
    planAnchorPublication(db, input, old);
    registerAnchorSigningKey(db, { key_id: "new-key", private_key: generateKeyPairSync("ed25519").privateKey });
    revokeAnchorSigningKey(db, "old-key", "rotation", "2026-08-22T00:00:00Z");
    await expect(writePlannedAnchor(db, store, input, old)).rejects.toThrow("anchor_signing_key_revoked");
    expect(db.prepare("SELECT revoked_at FROM integrity_key_revocation WHERE key_id='old-key'").get()).toEqual({ revoked_at: "2026-08-22T00:00:00Z" });
    expect(() => db.prepare("DELETE FROM integrity_signing_key WHERE key_id='old-key'").run()).toThrow("integrity_signing_key is append-only");
  });

  it("keeps transient versioned reads retryable and escalates only after fifteen minutes", async () => {
    const db = seeded(); const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" };
    const store: AnchorStore = { async putIfAbsent() { return { provider_version_id: "version-a" }; }, async get() { throw new Error("temporary_read_failure"); } };
    await writePlannedAnchor(db, store, input, signer);
    const created = db.prepare("SELECT created_at FROM generation_anchor_effect").get() as { created_at: string };
    await expect(reconcileAnchoredEffects(db, store, keys.publicKey, () => undefined, new Date(Date.parse(created.created_at) + 10 * 60_000))).resolves.toEqual({ reconciled: 0, failed: 1 });
    expect(db.prepare("SELECT status FROM generation_anchor_effect").get()).toEqual({ status: "anchor_written" });
    await reconcileAnchoredEffects(db, store, keys.publicKey, () => undefined, new Date(Date.parse(created.created_at) + 16 * 60_000));
    expect(db.prepare("SELECT COUNT(*) AS n FROM integrity_audit_event WHERE event_type='anchor_written_sqlite_uncommitted' AND severity='high'").get()).toEqual({ n: 1 });
  });

  it("rejects a response whose returned immutable VersionId differs from the recorded one", async () => {
    const db = seeded(); const input = { generation_effect_id: "effect-1", manifest: manifest(), issued_at: "2026-08-21T00:00:01Z", retain_until: "2027-01-01T00:00:00Z" };
    const body = new Map<string, Uint8Array>();
    const store: AnchorStore = { async putIfAbsent(key, bytes) { body.set(key, bytes); return { provider_version_id: "version-a" }; }, async get(key) { return { body: body.get(key)!, provider_version_id: "version-b" }; } };
    await writePlannedAnchor(db, store, input, signer);
    expect(await reconcileAnchoredEffects(db, store, keys.publicKey, () => undefined)).toEqual({ reconciled: 0, failed: 1 });
    expect(db.prepare("SELECT status FROM generation_anchor_effect").get()).toEqual({ status: "unknown" });
  });
});

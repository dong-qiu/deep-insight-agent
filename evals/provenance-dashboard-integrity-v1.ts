/** Deterministic P1c gate: canonical bytes, retention and recovery must not drift. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { anchorPayload, contentHash, jcs, manifestForArtifact, manifestHash, MemoryAnchorStore, sha256 } from "../src/lib/db/integrity-anchors.js";
import { commitAnchoredPublication, writeDailyMerkleRoot, writePlannedAnchor } from "../src/lib/db/integrity-publication.js";
import { verifyArtifactIntegrity } from "../src/lib/db/integrity-checks.js";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { insertTopic } from "../src/lib/db/repos.js";
import { deploymentAnchorPublication } from "../src/lib/runtime/integrity-anchor-runtime.js";

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

console.log(JSON.stringify({ gate: "provenance-dashboard-integrity-v1", result: "pass", vectors: 8, content_hash: manifest.content_hash, manifest_hash: manifestHash(manifest) }));

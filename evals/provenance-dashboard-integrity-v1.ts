/** Deterministic P1c gate: canonical bytes, retention and recovery must not drift. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { anchorPayload, contentHash, jcs, manifestForArtifact, manifestHash, MemoryAnchorStore, sha256 } from "../src/lib/db/integrity-anchors.js";
import { writeDailyMerkleRoot } from "../src/lib/db/integrity-publication.js";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
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

console.log(JSON.stringify({ gate: "provenance-dashboard-integrity-v1", result: "pass", vectors: 6, content_hash: manifest.content_hash, manifest_hash: manifestHash(manifest) }));

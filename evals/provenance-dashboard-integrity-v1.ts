/** Deterministic P1c gate: canonical bytes and raw-byte hashing must not drift. */
import assert from "node:assert/strict";
import { anchorPayload, contentHash, jcs, manifestForArtifact, manifestHash, sha256 } from "../src/lib/db/integrity-anchors.js";

const content = new TextEncoder().encode("abc");
const manifest = manifestForArtifact({
  tenant_id: "default", report_id: "report-0001", artifact_id: "artifact-0001", artifact_version: "v1",
  length: content.byteLength, media_type: "text/plain", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-0001", content,
});
assert.equal(contentHash(content), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(manifestHash(manifest), "85b88d5667e4e5e36dc461ff25b6f2b225354623774baddd9b3fddb6dae04907");
assert.equal(sha256(new TextEncoder().encode(jcs(anchorPayload(manifest, "2026-08-21T00:00:01Z")))), "e9c15e12b101ae5d11b7f778e1ea27e6722569f813e324026d305260157a7bb0");
console.log(JSON.stringify({ gate: "provenance-dashboard-integrity-v1", result: "pass", content_hash: manifest.content_hash, manifest_hash: manifestHash(manifest) }));

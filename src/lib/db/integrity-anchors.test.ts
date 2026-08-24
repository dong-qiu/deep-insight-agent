import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anchorEnvelopeBytes, anchorMatchesManifest, anchorPayload, contentHash, jcs, manifestForArtifact, manifestHash, MemoryAnchorStore, parseCanonicalAnchorEnvelope, sha256, verifySignedAnchor, writeAnchor } from "./integrity-anchors.js";

const keys = generateKeyPairSync("ed25519");
const signer = { key_id: "test-key-v1", private_key: keys.privateKey };
const text = new TextEncoder();

function fixture() {
  return manifestForArtifact({ tenant_id: "default", report_id: "report-0001", artifact_id: "artifact-0001", artifact_version: "v1", length: 3, media_type: "text/plain", created_at: "2026-08-21T00:00:00Z", upstream_trace_id: "trace-0001", content: text.encode("abc") });
}

describe("P1c manifest and anchor canonical vectors", () => {
  it("matches the signed specification's M and A SHA-256 vectors exactly", () => {
    const manifest = fixture();
    expect(contentHash(text.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(jcs(manifest)).toBe('{"artifact_id":"artifact-0001","artifact_version":"v1","content_hash":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","content_hash_algorithm":"sha-256","created_at":"2026-08-21T00:00:00Z","external_anchor":{"anchor_schema_version":"anchor-v1","object_key":"integrity-anchors/v1/default/report-0001/artifact-0001/v1/anchor-v1.json"},"length":3,"manifest_schema_version":"manifest-v1","media_type":"text/plain","report_id":"report-0001","tenant_id":"default","upstream_trace_id":"trace-0001"}');
    expect(manifestHash(manifest)).toBe("85b88d5667e4e5e36dc461ff25b6f2b225354623774baddd9b3fddb6dae04907");
    expect(sha256(text.encode(jcs(anchorPayload(manifest, "2026-08-21T00:00:01Z"))))).toBe("e9c15e12b101ae5d11b7f778e1ea27e6722569f813e324026d305260157a7bb0");
  });

  it("rejects tampered bindings and reuses only byte-identical conditional-write retries", async () => {
    const manifest = fixture(); const store = new MemoryAnchorStore();
    const first = await writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer);
    expect(first.reused).toBe(false); expect(verifySignedAnchor(first.anchor, keys.publicKey)).toBe(true);
    expect(anchorMatchesManifest(first.anchor, manifest)).toBe(true);
    const replay = await writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer);
    expect(replay.reused).toBe(true);
    const tampered = structuredClone(first.anchor); tampered.payload.binding.manifest_hash = "0".repeat(64);
    expect(anchorMatchesManifest(tampered, manifest)).toBe(false);
    store.replaceForTest(manifest.external_anchor.object_key, text.encode(jcs(tampered)));
    await expect(writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer)).rejects.toThrow("anchor_conflict");
  });

  it("rejects non-canonical, duplicate-key, unknown-schema, and invalid-signature read-backs", async () => {
    const manifest = fixture(); const store = new MemoryAnchorStore();
    const first = await writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer);
    const body = new TextDecoder().decode(anchorEnvelopeBytes(first.anchor));
    await expect(writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer)).resolves.toMatchObject({ reused: true });
    store.replaceForTest(manifest.external_anchor.object_key, text.encode(` ${body}`));
    await expect(writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer)).rejects.toThrow("anchor_conflict");
    store.replaceForTest(manifest.external_anchor.object_key, text.encode(body.replace('{"algorithm"', '{"algorithm":"ed25519","algorithm"')));
    await expect(writeAnchor(store, manifest, "2026-08-21T00:00:01Z", "2027-01-01T00:00:00Z", signer)).rejects.toThrow("anchor_conflict");
    const unknown = structuredClone(first.anchor) as unknown as Record<string, unknown>; unknown.extra = "nope";
    expect(() => parseCanonicalAnchorEnvelope(text.encode(jcs(unknown)), keys.publicKey)).toThrow("anchor_schema_invalid");
    const badSignature = structuredClone(first.anchor); badSignature.signature = "invalid";
    expect(() => parseCanonicalAnchorEnvelope(anchorEnvelopeBytes(badSignature), keys.publicKey)).toThrow("anchor_signature_invalid");
  });
});

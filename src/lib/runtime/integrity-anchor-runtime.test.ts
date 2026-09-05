import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deploymentAnchorLegalHold, deploymentAnchorPublication, deploymentAnchorPublicationIfEnabled, deploymentAnchorVerificationStore, integrityAnchorEnabled } from "./integrity-anchor-runtime.js";

describe("deployment anchor publication", () => {
  it("defaults P1 anchors off and does not construct an unanchored substitute", async () => {
    expect(integrityAnchorEnabled({})).toBe(false);
    await expect(deploymentAnchorPublicationIfEnabled({})).resolves.toBeUndefined();
  });

  it("accepts only explicit boolean enablement", () => {
    expect(integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "true" })).toBe(true);
    expect(integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "1" })).toBe(true);
    expect(integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "TRUE" })).toBe(true);
    expect(integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "false" })).toBe(false);
    expect(() => integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "yes" })).toThrow("integrity_anchor_enabled_invalid");
    expect(() => integrityAnchorEnabled({ INTEGRITY_ANCHOR_ENABLED: "true " })).toThrow("integrity_anchor_enabled_invalid");
  });

  it("keeps an enabled deployment strict about all anchor material", async () => {
    await expect(deploymentAnchorPublicationIfEnabled({ INTEGRITY_ANCHOR_ENABLED: "true" })).rejects.toThrow("integrity_anchor_admission_required");
    await expect(deploymentAnchorPublicationIfEnabled({
      INTEGRITY_ANCHOR_ENABLED: "true", INTEGRITY_ANCHOR_ADMISSION_REF: "INSI-25:evidence-123",
    })).rejects.toThrow("integrity_anchor_admission_required");
  });

  it("blocks every externally reachable P1 composition seam until INSI-25 admission", () => {
    expect(() => deploymentAnchorVerificationStore({ INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket" }))
      .toThrow("integrity_anchor_admission_required");
    expect(() => deploymentAnchorLegalHold({
      INTEGRITY_ANCHOR_ENABLED: "true", INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket",
      INTEGRITY_LEGAL_HOLD_RETAIN_UNTIL: "2027-01-01T00:00:00.000Z",
    })).toThrow("integrity_anchor_admission_required");
  });

  it("fails closed when the deployment-owned signer/store contract is absent", async () => {
    await expect(deploymentAnchorPublication({})).rejects.toThrow("integrity_anchor_not_configured");
  });

  it("accepts an Ed25519 deployment signer without contacting object storage", async () => {
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publication = await deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket",
      INTEGRITY_ANCHOR_KEY_ID: "anchor-key-v1",
      INTEGRITY_ANCHOR_PRIVATE_KEY_PEM: key.replace(/\n/g, "\\n"),
      INTEGRITY_ANCHOR_RETAIN_DAYS: "30",
      INTEGRITY_REPORT_READABLE_UNTIL: "2027-01-01T00:00:00.000Z",
      INTEGRITY_REPORT_ARCHIVE_UNTIL: "2027-02-01T00:00:00.000Z",
      INTEGRITY_ARTIFACT_RETAIN_UNTIL: "2027-03-01T00:00:00.000Z",
    }, new Date("2026-08-24T00:00:00.000Z"));
    expect(publication.signer.key_id).toBe("anchor-key-v1");
    expect(publication.retainUntil).toBe("2026-09-23T00:00:00.000Z");
  });

  it("fails closed when any report-retention horizon is absent", async () => {
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket", INTEGRITY_ANCHOR_KEY_ID: "anchor-key-v1",
      INTEGRITY_ANCHOR_PRIVATE_KEY_PEM: key,
    }, new Date("2026-08-24T00:00:00.000Z"))).rejects.toThrow("integrity_anchor_retention_policy_required");
  });

  it("uses KMS Sign/EDDSA with non-exported private material and fetched public verification material", async () => {
    const keys = generateKeyPairSync("ed25519");
    const calls: unknown[] = [];
    const kms = { send: async (command: unknown) => {
      calls.push(command);
      const input = command as { input: { Message?: Uint8Array } };
      if (input.input.Message) return { Signature: sign(null, input.input.Message, keys.privateKey) };
      return { PublicKey: keys.publicKey.export({ type: "spki", format: "der" }), SigningAlgorithms: ["EDDSA"] };
    } };
    const publication = await deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket", INTEGRITY_ANCHOR_KEY_ID: "alias/deep-insight-integrity-signing",
      INTEGRITY_ANCHOR_SIGNER: "aws-kms", INTEGRITY_REPORT_READABLE_UNTIL: "2027-01-01T00:00:00.000Z",
      INTEGRITY_REPORT_ARCHIVE_UNTIL: "2027-02-01T00:00:00.000Z", INTEGRITY_ARTIFACT_RETAIN_UNTIL: "2027-03-01T00:00:00.000Z",
    }, new Date("2026-08-24T00:00:00.000Z"), { kms });
    expect(publication.signer.private_key).toBeUndefined();
    await publication.signer.sign!(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(2);
  });

  it("fails closed when KMS cannot supply Ed25519 verification material", async () => {
    await expect(deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket", INTEGRITY_ANCHOR_KEY_ID: "alias/deep-insight-integrity-signing",
      INTEGRITY_ANCHOR_SIGNER: "aws-kms", INTEGRITY_REPORT_READABLE_UNTIL: "2027-01-01T00:00:00.000Z",
      INTEGRITY_REPORT_ARCHIVE_UNTIL: "2027-02-01T00:00:00.000Z", INTEGRITY_ARTIFACT_RETAIN_UNTIL: "2027-03-01T00:00:00.000Z",
    }, new Date("2026-08-24T00:00:00.000Z"), { kms: { send: async () => ({ SigningAlgorithms: [] }) } }))
      .rejects.toThrow("integrity_anchor_kms_verification_material_unavailable");
  });

  it("returns a stable non-sensitive error when KMS Sign fails", async () => {
    const keys = generateKeyPairSync("ed25519");
    const kms = { send: async (command: unknown) => {
      const input = command as { input: { Message?: Uint8Array } };
      if (input.input.Message) throw new Error("provider request detail must not escape");
      return { PublicKey: keys.publicKey.export({ type: "spki", format: "der" }), SigningAlgorithms: ["EDDSA"] };
    } };
    const publication = await deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket", INTEGRITY_ANCHOR_KEY_ID: "alias/deep-insight-integrity-signing",
      INTEGRITY_ANCHOR_SIGNER: "aws-kms", INTEGRITY_REPORT_READABLE_UNTIL: "2027-01-01T00:00:00.000Z",
      INTEGRITY_REPORT_ARCHIVE_UNTIL: "2027-02-01T00:00:00.000Z", INTEGRITY_ARTIFACT_RETAIN_UNTIL: "2027-03-01T00:00:00.000Z",
    }, new Date("2026-08-24T00:00:00.000Z"), { kms });
    await expect(publication.signer.sign!(new Uint8Array([1]))).rejects.toThrow("integrity_anchor_kms_sign_failed");
  });
});

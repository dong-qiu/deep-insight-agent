import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deploymentAnchorPublication } from "./integrity-anchor-runtime.js";

describe("deployment anchor publication", () => {
  it("fails closed when the deployment-owned signer/store contract is absent", () => {
    expect(() => deploymentAnchorPublication({})).toThrow("integrity_anchor_not_configured");
  });

  it("accepts an Ed25519 deployment signer without contacting object storage", () => {
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publication = deploymentAnchorPublication({
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

  it("fails closed when any report-retention horizon is absent", () => {
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => deploymentAnchorPublication({
      INTEGRITY_ANCHOR_BUCKET: "immutable-anchor-bucket", INTEGRITY_ANCHOR_KEY_ID: "anchor-key-v1",
      INTEGRITY_ANCHOR_PRIVATE_KEY_PEM: key,
    }, new Date("2026-08-24T00:00:00.000Z"))).toThrow("integrity_anchor_retention_policy_required");
  });
});

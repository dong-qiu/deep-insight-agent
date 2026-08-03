import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptEntityKey,
  entityKeyHmac,
  redactionRecordId,
  verifyRedactionRecord,
  type RedactionRegistryRecord,
} from "./redaction-registry.js";

function fixture(): { key: Buffer; entityKey: string; record: RedactionRegistryRecord } {
  const key = randomBytes(32);
  const entityKey = "report:r_123";
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(entityKey, "utf8"), cipher.final()]);
  const record: RedactionRegistryRecord = {
    schema_version: 1,
    record_id: redactionRecordId(key, { entity_key: entityKey, scope: "report", deletion_request_id: "del_123" }),
    entity_key_hmac: entityKeyHmac(key, entityKey),
    encrypted_entity_key: {
      algorithm: "AES-256-GCM",
      encrypted_data_key_b64url: dataKey.toString("base64url"),
      iv_b64url: iv.toString("base64url"),
      ciphertext_b64url: ciphertext.toString("base64url"),
      tag_b64url: cipher.getAuthTag().toString("base64url"),
    },
    kms_key_id: "arn:aws:kms:ap-southeast-1:123:key/example",
    hmac_key_version: "v1",
    scope: "report",
    reason_code: "privacy_request",
    deletion_request_id: "del_123",
    effective_at: "2026-08-03T00:00:00.000Z",
    expiry_at: "2027-08-03T00:00:00.000Z",
  };
  return { key, entityKey, record };
}

describe("redaction registry record", () => {
  it("decrypts and HMAC-verifies a valid record", () => {
    const { key, entityKey, record } = fixture();
    const decrypted = decryptEntityKey(record.encrypted_entity_key, Buffer.from(record.encrypted_entity_key.encrypted_data_key_b64url, "base64url"));
    expect(decrypted).toBe(entityKey);
    expect(verifyRedactionRecord(record, decrypted, key).entity_key).toBe(entityKey);
  });

  it("rejects modified identity fields", () => {
    const { key, entityKey, record } = fixture();
    expect(() => verifyRedactionRecord({ ...record, scope: "content" }, entityKey, key)).toThrow("registry_hmac_mismatch");
  });
});

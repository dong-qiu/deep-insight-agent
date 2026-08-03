/**
 * Redaction registry record 的无副作用编解码原语。
 *
 * registry 永不保存明文 entity key：S3 对象包含经 KMS data key 加密的 locator，
 * record_id / entity_key_hmac 使用 Secret Manager 中的版本化 HMAC key。这里刻意
 * 不依赖 AWS SDK，便于删除端与恢复端使用完全相同、可单测的验证逻辑。
 */
import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

export interface EncryptedEntityKey {
  algorithm: "AES-256-GCM";
  encrypted_data_key_b64url: string;
  iv_b64url: string;
  ciphertext_b64url: string;
  tag_b64url: string;
}

export interface RedactionRegistryRecord {
  schema_version: 1;
  record_id: string;
  entity_key_hmac: string;
  encrypted_entity_key: EncryptedEntityKey;
  kms_key_id: string;
  hmac_key_version: string;
  scope: string;
  reason_code: string;
  deletion_request_id: string;
  effective_at: string;
  expiry_at: string;
}

export interface VerifiedRedactionRecord extends RedactionRegistryRecord {
  entity_key: string;
}

export function canonicalRedactionIdentity(input: {
  entity_key: string;
  scope: string;
  deletion_request_id: string;
}): string {
  // 固定字段顺序，避免 JSON key insertion order 使 HMAC 在语言/实现间漂移。
  return JSON.stringify({
    deletion_request_id: input.deletion_request_id,
    entity_key: input.entity_key,
    scope: input.scope,
  });
}

export function hmacBase64Url(secret: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\u0000${value}`, "utf8").digest("base64url");
}

export function redactionRecordId(secret: Buffer, input: {
  entity_key: string;
  scope: string;
  deletion_request_id: string;
}): string {
  return hmacBase64Url(secret, "redaction-record:v1", canonicalRedactionIdentity(input));
}

export function entityKeyHmac(secret: Buffer, entityKey: string): string {
  return hmacBase64Url(secret, "redaction-entity:v1", entityKey);
}

function equalBase64Url(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function decryptEntityKey(encrypted: EncryptedEntityKey, dataKey: Buffer): string {
  if (encrypted.algorithm !== "AES-256-GCM" || dataKey.length !== 32) {
    throw new Error("registry_crypto_parameters_invalid");
  }
  const iv = Buffer.from(encrypted.iv_b64url, "base64url");
  const ciphertext = Buffer.from(encrypted.ciphertext_b64url, "base64url");
  const tag = Buffer.from(encrypted.tag_b64url, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("registry_ciphertext_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("registry_decrypt_failed");
  }
}

export function verifyRedactionRecord(
  record: RedactionRegistryRecord,
  entityKey: string,
  hmacKey: Buffer,
): VerifiedRedactionRecord {
  if (
    record.schema_version !== 1 ||
    !record.scope ||
    !record.reason_code ||
    !record.deletion_request_id ||
    !record.kms_key_id ||
    !record.hmac_key_version ||
    !record.effective_at ||
    !record.expiry_at
  ) {
    throw new Error("registry_record_invalid");
  }
  const expectedId = redactionRecordId(hmacKey, {
    entity_key: entityKey,
    scope: record.scope,
    deletion_request_id: record.deletion_request_id,
  });
  if (!equalBase64Url(record.record_id, expectedId) || !equalBase64Url(record.entity_key_hmac, entityKeyHmac(hmacKey, entityKey))) {
    throw new Error("registry_hmac_mismatch");
  }
  if (Date.parse(record.effective_at) >= Date.parse(record.expiry_at)) {
    throw new Error("registry_time_window_invalid");
  }
  return { ...record, entity_key: entityKey };
}

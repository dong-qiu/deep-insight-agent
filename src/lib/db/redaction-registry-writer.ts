/** 应用侧 append-only redaction registry 写入。此模块不提供删除 HTTP 入口；调用方须在 commit 回调里原子写业务 tombstone/audit。 */
import { GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createCipheriv, randomBytes } from "node:crypto";
import type { DB } from "./index.js";
import { applyRedactionTombstone } from "./redaction.js";
import {
  entityKeyHmac,
  redactionRecordId,
  type RedactionRegistryRecord,
} from "./redaction-registry.js";

type AwsSender = { send(command: unknown): Promise<Record<string, unknown>> };

export interface RedactionRegistryClients {
  s3: AwsSender;
  kms: AwsSender;
  secrets: AwsSender;
}

export interface RegisterRedactionInput {
  deletion_request_id: string;
  entity_key: string;
  scope: string;
  reason_code: string;
  expiry_at: string;
}

export interface RedactionRegistryConfig {
  bucket: string;
  kms_key_id: string;
  hmac_secret_arn: string;
  hmac_key_version: string;
  prefix?: string;
  now?: () => Date;
}

export interface RegisteredRedaction {
  record_id: string;
  registry_ref: string;
  already_registered: boolean;
}

export interface RedactionCommitContext {
  record_id: string;
  registry_ref: string;
  effective_at: string;
}

interface PendingRequest extends RegisterRedactionInput {
  record_id: string;
  effective_at: string;
  registry_key: string;
  registry_payload: string;
  status: "pending" | "registered";
}

function registryError(code: string): never {
  throw new Error(code);
}

function requireNonEmpty(value: string, code: string): string {
  if (!value || value.trim() !== value) registryError(code);
  return value;
}

function registryKey(prefix: string, effectiveAt: string, recordId: string): string {
  const date = new Date(effectiveAt);
  if (Number.isNaN(date.valueOf())) registryError("redaction_expiry_invalid");
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${yyyy}/${mm}/${recordId}.json`;
}

function asBuffer(value: unknown, code: string): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  registryError(code);
}

function isPreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === "PreconditionFailed" || candidate?.$metadata?.httpStatusCode === 412;
}

function loadPending(db: DB, deletionRequestId: string): PendingRequest | undefined {
  return db.prepare(`SELECT deletion_request_id,record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_key,registry_payload,status
    FROM provenance_redaction_request WHERE deletion_request_id=?`).get(deletionRequestId) as PendingRequest | undefined;
}

function sameRequest(pending: PendingRequest, input: RegisterRedactionInput): boolean {
  return pending.entity_key === input.entity_key && pending.scope === input.scope &&
    pending.reason_code === input.reason_code && pending.expiry_at === input.expiry_at;
}

async function buildPending(
  db: DB,
  input: RegisterRedactionInput,
  config: RedactionRegistryConfig,
  clients: RedactionRegistryClients,
): Promise<PendingRequest> {
  const secretResult = await clients.secrets.send(new GetSecretValueCommand({ SecretId: config.hmac_secret_arn }));
  if (typeof secretResult.SecretString !== "string") registryError("redaction_hmac_secret_unreadable");
  const hmacKey = Buffer.from(secretResult.SecretString, "utf8");
  if (hmacKey.length < 32) registryError("redaction_hmac_secret_weak");
  const dataKeyResult = await clients.kms.send(new GenerateDataKeyCommand({ KeyId: config.kms_key_id, KeySpec: "AES_256" }));
  const dataKey = asBuffer(dataKeyResult.Plaintext, "redaction_data_key_unreadable");
  const encryptedDataKey = asBuffer(dataKeyResult.CiphertextBlob, "redaction_data_key_unreadable");
  if (dataKey.length !== 32) registryError("redaction_data_key_invalid");

  const effectiveAt = (config.now ?? (() => new Date()))().toISOString();
  if (Date.parse(input.expiry_at) <= Date.parse(effectiveAt)) registryError("redaction_expiry_invalid");
  const recordId = redactionRecordId(hmacKey, input);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(input.entity_key, "utf8"), cipher.final()]);
  const record: RedactionRegistryRecord = {
    schema_version: 1,
    record_id: recordId,
    entity_key_hmac: entityKeyHmac(hmacKey, input.entity_key),
    encrypted_entity_key: {
      algorithm: "AES-256-GCM",
      encrypted_data_key_b64url: encryptedDataKey.toString("base64url"),
      iv_b64url: iv.toString("base64url"),
      ciphertext_b64url: ciphertext.toString("base64url"),
      tag_b64url: cipher.getAuthTag().toString("base64url"),
    },
    kms_key_id: config.kms_key_id,
    hmac_key_version: config.hmac_key_version,
    scope: input.scope,
    reason_code: input.reason_code,
    deletion_request_id: input.deletion_request_id,
    effective_at: effectiveAt,
    expiry_at: input.expiry_at,
  };
  const pending: PendingRequest = {
    ...input,
    record_id: recordId,
    effective_at: effectiveAt,
    registry_key: registryKey(config.prefix ?? "records", effectiveAt, recordId),
    registry_payload: JSON.stringify(record),
    status: "pending",
  };
  db.transaction(() => {
    db.prepare(`INSERT INTO provenance_redaction_request
      (deletion_request_id,record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_key,registry_payload,status,created_at)
      VALUES (@deletion_request_id,@record_id,@entity_key,@scope,@reason_code,@effective_at,@expiry_at,@registry_key,@registry_payload,'pending',@created_at)`).run({
      ...pending,
      created_at: new Date().toISOString(),
    });
  })();
  return pending;
}

/**
 * 先持久化 payload，再 If-None-Match 条件写 S3；412 只表示同 record_id 的既有对象，可安全继续。
 * callback 与本地 redaction/status 同一 SQLite transaction 运行，供未来业务硬删除和 audit 使用。
 */
export async function registerRedaction(
  db: DB,
  input: RegisterRedactionInput,
  config: RedactionRegistryConfig,
  clients: RedactionRegistryClients,
  onRegistered?: (context: RedactionCommitContext) => void,
): Promise<RegisteredRedaction> {
  for (const [field, value] of Object.entries(input)) requireNonEmpty(value, `redaction_${field}_invalid`);
  for (const [field, value] of Object.entries(config)) {
    if (field !== "now" && field !== "prefix" && typeof value === "string") requireNonEmpty(value, `redaction_config_${field}_invalid`);
  }
  // provenance_redaction 对 (entity_key,scope) 也是 append-only 唯一约束；实体已经脱敏时不得再写一个
  // 永久不可删除的外部对象，直接复用已登记的事实即可。
  const existingTombstone = db.prepare("SELECT record_id,registry_ref,effective_at FROM provenance_redaction WHERE entity_key=? AND scope=?")
    .get(input.entity_key, input.scope) as { record_id: string; registry_ref: string; effective_at: string } | undefined;
  if (existingTombstone) {
    const durableRequest = db.prepare(`SELECT 1 FROM provenance_redaction_request
      WHERE record_id=? AND status='registered' AND ? = 's3://' || ? || '/' || registry_key`).get(
      existingTombstone.record_id, existingTombstone.registry_ref, config.bucket,
    );
    if (onRegistered && durableRequest) db.transaction(() => onRegistered(existingTombstone))();
    return { record_id: existingTombstone.record_id, registry_ref: existingTombstone.registry_ref, already_registered: true };
  }
  let pending = loadPending(db, input.deletion_request_id);
  if (pending && !sameRequest(pending, input)) registryError("redaction_request_conflict");
  if (pending?.status === "registered") {
    const registered = pending;
    if (onRegistered) db.transaction(() => onRegistered({
      record_id: registered.record_id,
      registry_ref: `s3://${config.bucket}/${registered.registry_key}`,
      effective_at: registered.effective_at,
    }))();
    return { record_id: registered.record_id, registry_ref: `s3://${config.bucket}/${registered.registry_key}`, already_registered: true };
  }
  if (!pending) pending = await buildPending(db, input, config, clients);

  try {
    await clients.s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: pending.registry_key,
      Body: pending.registry_payload,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
  } catch (error) {
    if (!isPreconditionFailed(error)) registryError("redaction_registry_write_failed");
  }
  const ref = `s3://${config.bucket}/${pending.registry_key}`;
  db.transaction(() => {
    applyRedactionTombstone(db, {
      record_id: pending.record_id,
      entity_key: pending.entity_key,
      scope: pending.scope,
      reason_code: pending.reason_code,
      effective_at: pending.effective_at,
      expiry_at: pending.expiry_at,
      registry_ref: ref,
    });
    onRegistered?.({ record_id: pending.record_id, registry_ref: ref, effective_at: pending.effective_at });
    db.prepare("UPDATE provenance_redaction_request SET status='registered', registered_at=? WHERE deletion_request_id=? AND status='pending'")
      .run(new Date().toISOString(), pending.deletion_request_id);
  })();
  return { record_id: pending.record_id, registry_ref: ref, already_registered: false };
}

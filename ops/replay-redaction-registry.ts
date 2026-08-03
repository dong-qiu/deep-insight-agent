/**
 * 从 Object-Lock redaction registry 回放 tombstone 到一个已恢复的 SQLite 数据库。
 *
 * 此程序只读 AWS，任何对象不可读、验签/解密失败或时间窗无法判定时一律退出非零；
 * 调用方必须在启动 app/worker 前完成它，避免恢复点泄露已删除主体。
 *
 * 运行：npm run redaction:replay -- --restore-time 2026-08-03T00:00:00.000Z
 */
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { applyRedactionTombstone } from "../src/lib/db/redaction.js";
import {
  decryptEntityKey,
  verifyRedactionRecord,
  type RedactionRegistryRecord,
} from "../src/lib/db/redaction-registry.js";

interface Args { restoreTime: string }

function fail(code: string): never {
  // 不输出 entity key、S3 object body、secret ARN 以外的身份数据。
  throw new Error(code);
}

function parseArgs(argv: string[]): Args {
  const index = argv.indexOf("--restore-time");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || index + 2 !== argv.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail("usage: --restore-time <RFC3339 UTC timestamp>");
  }
  return { restoreTime: new Date(value).toISOString() };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing_${name.toLowerCase()}`);
  return value;
}

function parseHmacSecretArns(): Record<string, string> {
  const directArn = process.env.REDACTION_HMAC_SECRET_ARN?.trim();
  const directVersion = process.env.REDACTION_HMAC_KEY_VERSION?.trim();
  const encoded = process.env.REDACTION_HMAC_SECRET_ARNS_JSON?.trim();
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("redaction_hmac_secret_arns_invalid");
      const entries = Object.entries(parsed).filter(([version, arn]) => typeof version === "string" && version && typeof arn === "string" && arn);
      if (entries.length === 0) fail("redaction_hmac_secret_arns_invalid");
      return Object.fromEntries(entries);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("redaction_hmac_")) throw error;
      fail("redaction_hmac_secret_arns_invalid");
    }
  }
  if (!directArn || !directVersion) fail("missing_redaction_hmac_secret_mapping");
  return { [directVersion]: directArn };
}

function parseRecord(body: string): RedactionRegistryRecord {
  try {
    const record = JSON.parse(body) as RedactionRegistryRecord;
    if (
      !record ||
      typeof record !== "object" ||
      !record.encrypted_entity_key ||
      typeof record.encrypted_entity_key !== "object" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.effective_at) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.expiry_at) ||
      Number.isNaN(Date.parse(record.effective_at)) ||
      Number.isNaN(Date.parse(record.expiry_at))
    ) {
      fail("registry_record_invalid");
    }
    return record;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("registry_")) throw error;
    fail("registry_record_invalid");
  }
}

async function objectText(output: Awaited<ReturnType<S3Client["send"]>>): Promise<string> {
  const body = (output as { Body?: { transformToString?: (encoding?: string) => Promise<string> } }).Body;
  if (!body?.transformToString) fail("registry_object_body_unreadable");
  return body.transformToString("utf8");
}

async function main(): Promise<void> {
  const { restoreTime } = parseArgs(process.argv.slice(2));
  const bucket = requiredEnv("REDACTION_REGISTRY_BUCKET");
  requiredEnv("REDACTION_RECOVERY_ROLE_ARN");
  const prefix = process.env.REDACTION_REGISTRY_PREFIX?.trim() || "records/";
  const secretArns = parseHmacSecretArns();
  // recovery runner 必须以独立 recovery identity 启动（临时凭据/专用 profile/受控 runner）。
  // 绝不让 app instance role AssumeRole 到拥有 GetObject/Decrypt 的角色，否则遭攻陷的
  // web/worker 可以间接读取 registry，显式 Deny 形同虚设。
  const s3 = new S3Client({});
  const kms = new KMSClient({});
  const secrets = new SecretsManagerClient({});
  const hmacKeys = new Map<string, Buffer>();
  const dataKeys = new Map<string, Buffer>();
  const records: { key: string; record: RedactionRegistryRecord }[] = [];

  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    if (!page.Contents) fail("registry_list_incomplete");
    for (const object of page.Contents) {
      if (!object.Key || object.Key.endsWith("/")) fail("registry_object_key_invalid");
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      records.push({ key: object.Key, record: parseRecord(await objectText(result)) });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) fail("registry_list_incomplete");
  } while (token);

  const db = openDb(process.env.DB_PATH ?? ".data/insight.db");
  try {
    applyProvenanceMigrations(db);
    const verifiedTombstones: { record_id: string; entity_key: string; scope: string; reason_code: string; effective_at: string; expiry_at: string; registry_ref: string }[] = [];
    for (const { key, record } of records) {
      if (record.effective_at > restoreTime || record.expiry_at <= restoreTime) continue;
      const secretArn = secretArns[record.hmac_key_version];
      if (!secretArn) fail("registry_hmac_key_version_unavailable");
      let hmacKey = hmacKeys.get(record.hmac_key_version);
      if (!hmacKey) {
        const secret = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
        if (!secret.SecretString) fail("registry_hmac_secret_unreadable");
        hmacKey = Buffer.from(secret.SecretString, "utf8");
        if (hmacKey.length < 32) fail("registry_hmac_secret_weak");
        hmacKeys.set(record.hmac_key_version, hmacKey);
      }
      let dataKey = dataKeys.get(record.encrypted_entity_key.encrypted_data_key_b64url);
      if (!dataKey) {
        const decrypted = await kms.send(new DecryptCommand({
          CiphertextBlob: Buffer.from(record.encrypted_entity_key.encrypted_data_key_b64url, "base64url"),
          KeyId: record.kms_key_id,
        }));
        if (!decrypted.Plaintext) fail("registry_data_key_unreadable");
        dataKey = Buffer.from(decrypted.Plaintext);
        dataKeys.set(record.encrypted_entity_key.encrypted_data_key_b64url, dataKey);
      }
      const entityKey = decryptEntityKey(record.encrypted_entity_key, dataKey);
      const verified = verifyRedactionRecord(record, entityKey, hmacKey);
      verifiedTombstones.push({
        record_id: verified.record_id,
        entity_key: verified.entity_key,
        scope: verified.scope,
        reason_code: verified.reason_code,
        effective_at: verified.effective_at,
        expiry_at: verified.expiry_at,
        registry_ref: `s3://${bucket}/${key}`,
      });
    }
    db.transaction(() => {
      for (const tombstone of verifiedTombstones) applyRedactionTombstone(db, tombstone);
    })();
    console.info(JSON.stringify({
      event: "redaction_registry_replayed",
      restore_time: restoreTime,
      records_seen: records.length,
      records_applied: verifiedTombstones.length,
      hmac_key_versions: [...hmacKeys.keys()].sort(),
    }));
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "redaction_registry_replay_failed");
  process.exitCode = 1;
});

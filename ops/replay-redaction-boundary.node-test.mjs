import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Characterization only: replacing AWS transport, NOT runner filtering, crypto or SQLite.
// The snapshot-after/before distinction below records a known acceptance failure.
test("recovery time boundary characterization with synthetic transport", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "insight-replay-boundary-"));
  t.after(() => rmSync(root, { recursive: true }));
  const bundle = join(root, "replay.cjs");
  await build({ entryPoints: [resolve("ops/replay-redaction-registry.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", external: ["better-sqlite3"], logLevel: "silent",
    plugins: [{ name: "synthetic-aws-transport", setup(builder) {
      builder.onResolve({ filter: /^@aws-sdk\/client-(s3|kms|secrets-manager)$/ }, () => ({ path: "transport", namespace: "synthetic" }));
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: `
        import { readFileSync } from 'node:fs';
        const fixture = JSON.parse(readFileSync(process.env.SYNTHETIC_FIXTURE, 'utf8'));
        export class ListObjectsV2Command {} export class GetObjectCommand {}
        export class DecryptCommand {} export class GetSecretValueCommand {}
        export class PutObjectCommand {} export class PutObjectRetentionCommand {} export class GenerateDataKeyCommand {}
        class Client { async send(command) {
          if (fixture.transportFailure) throw new Error('synthetic_transport_failed');
          if (command instanceof ListObjectsV2Command) return {Contents:[{Key:'records/synthetic.json'}]};
          if (command instanceof GetObjectCommand) return {Body:{transformToString:async()=>JSON.stringify(fixture.record)}};
          if (command instanceof DecryptCommand) return {Plaintext:Buffer.from(fixture.dataKey,'base64url')};
          if (command instanceof GetSecretValueCommand) return {SecretString:fixture.hmacKey};
          throw new Error('unexpected_synthetic_command');
        }}
        export { Client as S3Client, Client as KMSClient, Client as SecretsManagerClient };
      `, loader: "js" }));
    } }] });
  const dataKey = randomBytes(32), hmacKey = randomBytes(32).toString("hex");
  const entityKey = "report:rep_synthetic", requestId = "synthetic-request";
  const hmac = (purpose, value) => createHmac("sha256", hmacKey).update(`${purpose}\u0000${value}`).digest("base64url");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(entityKey, "utf8"), cipher.final()]);
  const record = { schema_version: 1,
    record_id: hmac("redaction-record:v1", JSON.stringify({ deletion_request_id: requestId, entity_key: entityKey, scope: "report" })),
    entity_key_hmac: hmac("redaction-entity:v1", entityKey),
    encrypted_entity_key: { algorithm: "AES-256-GCM", encrypted_data_key_b64url: "synthetic", iv_b64url: iv.toString("base64url"),
      ciphertext_b64url: ciphertext.toString("base64url"), tag_b64url: cipher.getAuthTag().toString("base64url") },
    kms_key_id: "synthetic-kms", hmac_key_version: "v1", scope: "report", reason_code: "user_request",
    deletion_request_id: requestId, effective_at: "2026-10-01T00:00:00.000Z", expiry_at: "2099-01-01T00:00:00.000Z" };
  const Database = createRequire(import.meta.url)("better-sqlite3");
  for (const scenario of [
    { name: "later snapshot time replays once across two runs", time: "2026-10-02T00:00:00.000Z", count: 1, repeat: true },
    { name: "KNOWN GAP: earlier snapshot time reports success but skips later deletion", time: "2026-09-30T00:00:00.000Z", count: 0 },
    { name: "bad signature refuses replay", time: "2026-10-02T00:00:00.000Z", badSignature: true, reason: "registry_hmac_mismatch" },
    { name: "missing key version refuses replay", time: "2026-10-02T00:00:00.000Z", missingVersion: true, reason: "registry_hmac_key_version_unavailable" },
    { name: "transport failure refuses replay", time: "2026-10-02T00:00:00.000Z", transportFailure: true, reason: "synthetic_transport_failed" },
  ]) await t.test(scenario.name, () => {
    const dir = join(root, scenario.name.split(":")[0].replaceAll(" ", "-")); mkdirSync(dir);
    const fixture = join(dir, "fixture.json"), dbPath = join(dir, "insight.db");
    writeFileSync(fixture, JSON.stringify({ record: { ...record, ...(scenario.badSignature ? { record_id: "invalid" } : {}) },
      dataKey: dataKey.toString("base64url"), hmacKey, transportFailure: Boolean(scenario.transportFailure) }), { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [bundle, "--restore-time", scenario.time], { cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { NODE_PATH: resolve("node_modules"), DB_PATH: dbPath, DATA_DIR: dir, SYNTHETIC_FIXTURE: fixture,
        REDACTION_REGISTRY_BUCKET: "synthetic", REDACTION_RECOVERY_ROLE_ARN: "synthetic",
        REDACTION_HMAC_SECRET_ARNS_JSON: JSON.stringify({ [scenario.missingVersion ? "v2" : "v1"]: "synthetic-secret" }) } });
    const result = run(); assert.equal(result.error, undefined);
    assert.equal(result.status, scenario.reason ? 1 : 0, result.stderr);
    if (scenario.reason) {
      assert.ok(result.stderr.includes(scenario.reason), result.stderr);
      assert.equal(result.stdout.includes("redaction_registry_replayed"), false);
    } else {
      assert.equal(JSON.parse(result.stdout.trim()).records_applied, scenario.count);
      if (scenario.repeat) assert.equal(run().status, 0);
    }
    if (scenario.transportFailure) {
      for (const suffix of ["", "-wal", "-shm"]) assert.equal(existsSync(dbPath + suffix), false);
    } else {
      const db = new Database(dbPath, { readonly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provenance_redaction").get().n, scenario.count ?? 0); }
      finally { db.close(); }
    }
  });
});

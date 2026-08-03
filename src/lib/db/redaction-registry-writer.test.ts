import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { registerRedaction, type RedactionRegistryClients } from "./redaction-registry-writer.js";

function clients(options: { firstPutFails?: boolean; firstPutPreconditionFails?: boolean } = {}): { clients: RedactionRegistryClients; puts: unknown[]; counts: { secret: number; kms: number } } {
  const puts: unknown[] = [];
  const counts = { secret: 0, kms: 0 };
  let first = true;
  return {
    puts,
    counts,
    clients: {
      secrets: { send: async () => { counts.secret += 1; return { SecretString: "x".repeat(32) }; } },
      kms: { send: async () => { counts.kms += 1; return { Plaintext: randomBytes(32), CiphertextBlob: randomBytes(48) }; } },
      s3: { send: async (command) => {
        puts.push(command);
        if (options.firstPutPreconditionFails && first) {
          first = false;
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        }
        if (options.firstPutFails && first) {
          first = false;
          throw new Error("network");
        }
        return {};
      } },
    },
  };
}

const config = {
  bucket: "registry-bucket",
  kms_key_id: "kms-key",
  hmac_secret_arn: "secret-arn",
  hmac_key_version: "v1",
  now: () => new Date("2026-08-03T00:00:00.000Z"),
};
const input = {
  deletion_request_id: "del_123",
  entity_key: "report:r_123",
  scope: "report",
  reason_code: "privacy_request",
  expiry_at: "2027-08-03T00:00:00.000Z",
};

describe("redaction registry writer", () => {
  it("persists stable pending payload before conditional write and commits tombstone", async () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const fake = clients();
    const result = await registerRedaction(db, input, config, fake.clients);
    expect(result.already_registered).toBe(false);
    expect(fake.puts).toHaveLength(1);
    expect(db.prepare("SELECT status FROM provenance_redaction_request WHERE deletion_request_id=?").get(input.deletion_request_id)).toEqual({ status: "registered" });
    expect(db.prepare("SELECT entity_key FROM provenance_redaction WHERE record_id=?").get(result.record_id)).toEqual({ entity_key: input.entity_key });

    const retry = await registerRedaction(db, input, config, fake.clients);
    expect(retry).toEqual({ ...result, already_registered: true });
    expect(fake.puts).toHaveLength(1);
  });

  it("reuses the persisted payload after an external write failure", async () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const fake = clients({ firstPutFails: true });
    await expect(registerRedaction(db, input, config, fake.clients)).rejects.toThrow("redaction_registry_write_failed");
    const pending = db.prepare("SELECT registry_payload FROM provenance_redaction_request WHERE deletion_request_id=?").get(input.deletion_request_id) as { registry_payload: string };

    await registerRedaction(db, input, config, fake.clients);
    expect(fake.counts).toEqual({ secret: 1, kms: 1 });
    expect((fake.puts[1] as { input: { Body: string } }).input.Body).toBe(pending.registry_payload);
  });

  it("does not allow a deletion request id to change its target", async () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const fake = clients();
    await registerRedaction(db, input, config, fake.clients);
    await expect(registerRedaction(db, { ...input, entity_key: "report:other" }, config, fake.clients))
      .rejects.toThrow("redaction_request_conflict");
  });

  it("treats S3 412 as the stable record's idempotent success", async () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const fake = clients({ firstPutPreconditionFails: true });
    const result = await registerRedaction(db, input, config, fake.clients);
    expect(result.already_registered).toBe(false);
    expect(db.prepare("SELECT status FROM provenance_redaction_request WHERE deletion_request_id=?").get(input.deletion_request_id)).toEqual({ status: "registered" });
  });

  it("does not create another immutable registry object for an already redacted entity", async () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const fake = clients();
    const first = await registerRedaction(db, input, config, fake.clients);
    const second = await registerRedaction(db, { ...input, deletion_request_id: "del_456" }, config, fake.clients);
    expect(second).toEqual({ ...first, already_registered: true });
    expect(fake.puts).toHaveLength(1);
  });
});

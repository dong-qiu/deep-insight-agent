import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { entityKeyHmac, redactionRecordId } from "../src/lib/db/redaction-registry.js";
import { getReport, queryReportIndex, searchReports } from "../src/lib/db/reports.js";
import { permanentlyHidden, replaySynthetic, SyntheticAuthority, utc } from "../experiments/c1-recovery/core.js";

function fixture() {
  const issuer = generateKeyPairSync("ed25519"), recovery = generateKeyPairSync("ed25519");
  const authority = new SyntheticAuthority("2026-01-01T00:00:00Z", issuer.privateKey);
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','Synthetic','[]','en','daily',1)").run();
  db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
    VALUES ('r','brief','t','done','2026-01-02T00:00:00Z','Synthetic','synthetic-only','[]','[]',0,'{}')`).run();
  db.prepare(`INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
    VALUES ('r','brief','t','[]','2026-01-02','[]','Synthetic','synthetic','[]','[]','[]',0,'[]',0)`).run();
  db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES ('r','Synthetic','synthetic','synthetic')").run();
  const hmac = randomBytes(32), dataKey = randomBytes(32);
  const backup = authority.backup(db, "2026-01-02T00:00:00Z");
  const object = (overrides: Record<string, unknown> = {}, id = "r") => {
    const entity = `report:${id}`, scope = typeof overrides.scope === "string" ? overrides.scope : "report";
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(entity), cipher.final()]);
    const record = { schema_version: 1, record_id: redactionRecordId(hmac, { entity_key: entity, scope, deletion_request_id: id }),
      entity_key_hmac: entityKeyHmac(hmac, entity), encrypted_entity_key: { algorithm: "AES-256-GCM", encrypted_data_key_b64url: "synthetic-data-key",
        iv_b64url: iv.toString("base64url"), ciphertext_b64url: ciphertext.toString("base64url"), tag_b64url: cipher.getAuthTag().toString("base64url") },
      kms_key_id: "synthetic", hmac_key_version: "v1", scope, reason_code: "user_erasure", deletion_request_id: id,
      effective_at: "2026-01-03T00:00:00Z", expiry_at: "2026-02-01T00:00:00Z", ...overrides };
    return { key: `records/${id}`, version: "1", body: JSON.stringify(record) };
  };
  const commit = (o = object()) => authority.commit(authority.begin(), o);
  const options = () => ({ authority, trustedIssuer: issuer.publicKey, recoverySigner: recovery.privateKey, trustedRecovery: recovery.publicKey,
    backup, checkpoint: authority.freeze("2026-03-01T00:00:00Z"), objects: authority.objects(),
    hmacKeys: new Map([["v1", hmac]]), dataKeys: new Map([["synthetic-data-key", dataKey]]), now: "2026-03-01T00:00:00Z", image: `sha256:${"a".repeat(64)}` });
  return { db, authority, backup, object, commit, options, issuer };
}

describe("C1 isolated synthetic recovery core (not production restore)", () => {
  it("replays post-snapshot deletion after expiry, removes real report/index/FTS, persists constraint and repeats safely", () => {
    const f = fixture(); try {
      f.commit(); const input = f.options(), receipt = replaySynthetic(f.db, input);
      expect(receipt.payload.applied).toBe(1);
      expect(getReport(f.db, "r")).toBeNull(); expect(queryReportIndex(f.db, { topic: "t" })).toEqual([]);
      expect(searchReports(f.db, "synthetic")).toEqual([]); expect(permanentlyHidden(f.db, "r")).toBe(true);
      const again = replaySynthetic(f.db, { ...input, previousReceipt: receipt });
      expect(again.payload.resultHash).toBe(receipt.payload.resultHash);
      expect(f.db.prepare("SELECT COUNT(*) n FROM c1_synthetic_deletion").get()).toEqual({ n: 1 });
      expect(() => f.db.exec("DELETE FROM c1_synthetic_deletion")).toThrow("immutable");
    } finally { f.db.close(); }
  });
  it("accepts authenticated empty checkpoint, rejects missing objects", () => {
    const f = fixture(); try { expect(replaySynthetic(f.db, f.options()).payload.applied).toBe(0); } finally { f.db.close(); }
    const g = fixture(); try { g.commit(); expect(() => replaySynthetic(g.db, { ...g.options(), objects: [] })).toThrow("objects_incomplete"); } finally { g.db.close(); }
  });
  it.each(["signature", "scope", "version", "missing-key", "future", "cutoff", "trust", "backup", "duplicate"])("rejects %s without changing any DB bytes", (scenario) => {
    const f = fixture(); try {
      f.commit();
      if (scenario === "signature") f.commit(f.object({ record_id: "bad" }, "other"));
      if (scenario === "scope") f.commit(f.object({ scope: "entity" }, "other"));
      if (scenario === "cutoff") f.commit(f.object({ effective_at: "2026-03-02T00:00:00Z", expiry_at: "2026-04-01T00:00:00Z" }, "other"));
      const input = f.options();
      if (scenario === "version") input.objects[0].version = "wrong";
      if (scenario === "missing-key") input.hmacKeys.clear();
      if (scenario === "future") input.now = "2026-02-28T00:00:00Z";
      if (scenario === "trust") input.trustedIssuer = generateKeyPairSync("ed25519").publicKey;
      if (scenario === "backup") f.db.exec("UPDATE report SET title='changed'");
      if (scenario === "duplicate") input.objects.push(input.objects[0]);
      const before = f.db.serialize();
      expect(() => replaySynthetic(f.db, input)).toThrow(); expect(f.db.serialize()).toEqual(before);
      expect(getReport(f.db, "r")).not.toBeNull();
    } finally { f.db.close(); }
  });
  it("freezing requires drained commits and blocks all subsequent commits including old pending tokens", () => {
    const f = fixture(); try {
      const pending = f.authority.begin(); expect(() => f.authority.freeze("2026-03-01T00:00:00Z")).toThrow("freeze_invalid");
      f.authority.commit(pending, f.object()); f.options();
      expect(() => f.authority.begin()).toThrow("maintenance_closed");
      expect(() => f.authority.commit(pending, f.object())).toThrow("commit_fenced");
    } finally { f.db.close(); }
  });
  it("does not add experimental tables through real schema bootstrap or production migrations", () => {
    const f = fixture(); try {
      expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='c1_synthetic_deletion'").get()).toBeUndefined();
    } finally { f.db.close(); }
  });
  it("rolls back an earlier valid report deletion when a later record conflicts with an existing tombstone", () => {
    const f = fixture(); try {
      f.db.prepare(`INSERT INTO provenance_redaction(record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref,created_at)
        VALUES ('existing','report:other','report','different','2026-01-03T00:00:00Z','2026-02-01T00:00:00Z','synthetic','2026-01-03T00:00:00Z')`).run();
      const backup = f.authority.backup(f.db, "2026-01-02T00:00:00Z");
      f.commit(); f.commit(f.object({}, "other")); const input = { ...f.options(), backup }, before = f.db.serialize();
      expect(() => replaySynthetic(f.db, input)).toThrow("record_conflict");
      expect(f.db.serialize()).toEqual(before); expect(getReport(f.db, "r")).not.toBeNull();
    } finally { f.db.close(); }
  });
  it("rejects mismatched receipt signing keys before mutating the DB", () => {
    const f = fixture(); try {
      f.commit(); const input = f.options(), before = f.db.serialize();
      input.trustedRecovery = generateKeyPairSync("ed25519").publicKey;
      expect(() => replaySynthetic(f.db, input)).toThrow("signature_invalid"); expect(f.db.serialize()).toEqual(before);
    } finally { f.db.close(); }
  });
  it("cannot attest sampling before the synthetic origin or while a write is pending", () => {
    const f = fixture(); try {
      expect(() => f.authority.backup(f.db, "2025-12-31T00:00:00Z")).toThrow("sample_invalid");
      const pending = f.authority.begin();
      expect(() => f.authority.backup(f.db, "2026-01-02T00:00:00Z")).toThrow("sample_invalid");
      f.authority.abort(pending);
    } finally { f.db.close(); }
  });
  it("rejects a changed DB or image even when replay already has a signed receipt", () => {
    const f = fixture(); try {
      f.commit(); const input = f.options(), receipt = replaySynthetic(f.db, input);
      expect(() => replaySynthetic(f.db, { ...input, previousReceipt: receipt, image: `sha256:${"b".repeat(64)}` })).toThrow("receipt_mismatch");
      f.db.exec("UPDATE topic SET name='changed'");
      expect(() => replaySynthetic(f.db, { ...input, previousReceipt: receipt })).toThrow("receipt_mismatch");
    } finally { f.db.close(); }
  });
  it.each(["2026-02-30T00:00:00Z", "2026-01-01T00:00:00+08:00", "not-time"])("rejects noncanonical or invalid UTC %s", (time) => expect(() => utc(time)).toThrow("time_invalid"));
  it("normalizes second and millisecond UTC values numerically", () => expect(utc("2026-01-01T00:00:00Z")).toBe(utc("2026-01-01T00:00:00.000Z")));
});

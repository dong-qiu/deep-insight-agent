import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { redactReport } from "./report-redaction.js";

const config = {
  bucket: "registry-bucket", kms_key_id: "kms-key", hmac_secret_arn: "secret-arn", hmac_key_version: "v1",
  now: () => new Date("2026-08-03T00:00:00.000Z"),
};
const clients = {
  secrets: { send: async () => ({ SecretString: "x".repeat(32) }) },
  kms: { send: async () => ({ Plaintext: randomBytes(32), CiphertextBlob: randomBytes(48) }) },
  s3: { send: async () => ({}) },
};

function seededDb() {
  const db = openDb(":memory:");
  applyProvenanceMigrations(db);
  db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1)").run();
  db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
    VALUES ('r','brief','t','done','2026-08-03T00:00:00.000Z','R','/tmp/r','[]','[]',NULL,0,'{}',NULL)`).run();
  db.prepare(`INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
    VALUES ('r','brief','t','[]','2026-08-03','[]','R','summary','[]','[]','[]',0,'[]',0)`).run();
  db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES ('r','R','summary','body')").run();
  return db;
}

describe("report redaction", () => {
  it("does not withdraw the published report when immutable registry write fails", async () => {
    const db = seededDb();
    await expect(redactReport(db, {
      report_id: "r", deletion_request_id: "del_123", reason_code: "privacy_request", expiry_at: "2027-08-03T00:00:00.000Z", actor_id: "admin",
    }, config, { ...clients, s3: { send: async () => { throw new Error("network"); } } })).rejects.toThrow("redaction_registry_write_failed");
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
    expect(db.prepare("SELECT 1 FROM report_index WHERE report_id='r'").get()).toBeTruthy();
  });

  it("withdraws report, index and FTS atomically after registration", async () => {
    const db = seededDb();
    const result = await redactReport(db, {
      report_id: "r", deletion_request_id: "del_123", reason_code: "privacy_request", expiry_at: "2027-08-03T00:00:00.000Z", actor_id: "user:admin",
    }, config, clients);
    expect(result.kind).toBe("redacted");
    expect(db.prepare("SELECT status,body_path FROM report WHERE id='r'").get()).toEqual({ status: "deleted", body_path: null });
    expect(db.prepare("SELECT 1 FROM report_index WHERE report_id='r'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM report_fts WHERE report_id='r'").get()).toBeUndefined();
    expect(db.prepare("SELECT action,target FROM audit_log").get()).toEqual({ action: "report_redacted", target: "r" });
  });
});

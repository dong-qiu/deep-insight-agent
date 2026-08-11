import { describe, expect, it } from "vitest";
import { closeDb, getDb, openDb } from "./index.js";
import { applyProvenanceMigrations, assertProvenanceSchema } from "./provenance-migrations.js";

describe("provenance migration runner", () => {
  it("applies once, records its checksum, and is safe to rerun", () => {
    const db = openDb(":memory:");
    expect(() => assertProvenanceSchema(db)).toThrow("has not been applied");
    applyProvenanceMigrations(db);
    applyProvenanceMigrations(db);
    expect(() => assertProvenanceSchema(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migration").get()).toEqual({ count: 8 });
    expect((db.prepare("PRAGMA table_info(run)").all() as { name: string }[]).some((row) => row.name === "trace_id")).toBe(true);
    const reportColumns = db.prepare("PRAGMA table_info(report)").all() as { name: string; notnull: number }[];
    expect(reportColumns.find((column) => column.name === "body_path")?.notnull).toBe(0);
    expect(reportColumns.some((column) => column.name === "failure")).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_effect'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_redaction'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_redaction_request'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_event'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA table_info(generation_trace)").all() as { name: string }[]).some((row) => row.name === "source_id")).toBe(true);
  });

  it("rejects a production writer when the runner has not applied the ledger", () => {
    const original = process.env.PROVENANCE_SCHEMA_REQUIRED;
    process.env.PROVENANCE_SCHEMA_REQUIRED = "1";
    process.env.DB_PATH = ":memory:";
    closeDb();
    expect(() => getDb()).toThrow("has not been applied");
    closeDb();
    if (original == null) delete process.env.PROVENANCE_SCHEMA_REQUIRED;
    else process.env.PROVENANCE_SCHEMA_REQUIRED = original;
    delete process.env.DB_PATH;
  });

  it("rebuilds a legacy NOT NULL body_path table without losing a published report", () => {
    const checksumDb = openDb(":memory:");
    applyProvenanceMigrations(checksumDb);
    const core = checksumDb.prepare("SELECT checksum FROM schema_migration WHERE version=?")
      .get("20260803_01_provenance_core") as { checksum: string };

    const db = openDb(":memory:");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE report;
      CREATE TABLE report (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topic(id), status TEXT NOT NULL,
        generated_at TEXT NOT NULL, title TEXT NOT NULL, body_path TEXT NOT NULL, insight_ids TEXT NOT NULL DEFAULT '[]',
        event_ids TEXT NOT NULL DEFAULT '[]', prev_report_id TEXT, citation_count INTEGER NOT NULL, cost TEXT NOT NULL
      );
    `);
    db.pragma("foreign_keys = ON");
    // 该 fixture 的 core migration ledger 已人为标记为完成；补最小父表以模拟其存在，
    // 让后续 P0b 的 source_id ALTER 与本测试关注的 report rebuild 在同一遗留形态下运行。
    db.exec("CREATE TABLE generation_trace (id TEXT PRIMARY KEY, started_at TEXT NOT NULL)");
    db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1)").run();
    db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost)
      VALUES ('r','brief','t','done','2026-08-03T00:00:00Z','R','/data/reports/r','[]','[]',NULL,0,'{}')`).run();
    db.exec("CREATE TABLE schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_migration(version,checksum,applied_at) VALUES (?,?,?)")
      .run("20260803_01_provenance_core", core.checksum, "2026-08-03T00:00:00Z");

    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT body_path, failure FROM report WHERE id='r'").get()).toEqual({ body_path: "/data/reports/r", failure: null });
    expect((db.prepare("PRAGMA table_info(report)").all() as { name: string; notnull: number }[])
      .find((column) => column.name === "body_path")?.notnull).toBe(0);
  });
});

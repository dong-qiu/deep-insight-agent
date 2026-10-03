import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "./index.js";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { applyRedactionTombstone } from "./redaction.js";
import { isReportReaderVisible } from "./integrity-lifecycle.js";
import { getReport, listReportIndex, searchReports, previousReportForTopic, reportNeighbors, topicHasReport, saveReport, reportStatusCounts, listRecentReports } from "./reports.js";
import { reportLinksByInsight } from "./graph.js";
import { getFreshness } from "../runtime/staleness.js";
import { REPORT_REDACTION_BOUNDARY_SCHEMA_SQL } from "./schema.js";
import { createHash } from "node:crypto";

const databases: DB[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const record = {
  record_id: "erased", entity_key: "report:r", scope: "report", reason_code: "user_erasure",
  effective_at: "2020-01-01T00:00:00.000Z", expiry_at: "2020-02-01T00:00:00.000Z", registry_ref: "records/erased.json",
};
function fixture(): DB {
  const db = openDb(":memory:"); databases.push(db); applyProvenanceMigrations(db);
  db.exec(`INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1);
    INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
      VALUES ('r','brief','t','done','2020-01-01T00:00:00Z','secret','/missing/r','[]','[]',0,'{}');
    INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
      VALUES ('r','brief','t','[]','2020-01-01','[]','secret','secret','[]','[]','[]',0,'[]',0);
    INSERT INTO report_fts(report_id,title,summary,body) VALUES ('r','secret','secret','secret');`);
  return db;
}
function insertFact(db: DB, input = record): void {
  db.prepare(`INSERT INTO provenance_redaction(record_id,entity_key,scope,reason_code,effective_at,expiry_at,registry_ref,created_at)
    VALUES (@record_id,@entity_key,@scope,@reason_code,@effective_at,@expiry_at,@registry_ref,'2020-01-01T00:00:00.000Z')`).run(input);
}
describe("production report deletion boundary", () => {
  it("an expired deletion hides a dirty done report and stale index/FTS without a lifecycle row", () => {
    const db = fixture(); insertFact(db);
    expect(isReportReaderVisible(db, "r")).toBe(false);
    expect(getReport(db, "r")).toBeNull();
    expect(listReportIndex(db)).toEqual([]);
    expect(searchReports(db, "secret")).toEqual([]);
  });
  it("navigation, graph links, cold-start and freshness cannot use a withdrawn report", () => {
    const db = fixture(); db.exec(`UPDATE report SET insight_ids='["i"]' WHERE id='r'`);
    expect(reportLinksByInsight(db, "t").get("i")).toHaveLength(1);
    insertFact(db);
    expect(previousReportForTopic(db, "t", "brief")).toBeNull();
    expect(reportNeighbors(db, { id: "other", prev_report_id: "r" }).prev).toBeNull();
    expect(reportLinksByInsight(db, "t").size).toBe(0);
    expect(topicHasReport(db, "t")).toBe(false);
    expect(getFreshness(db).latestReportAt).toBeNull();
  });
  it("publication is refused before body-file side effects for a deleted report ID", () => {
    const db = fixture(); insertFact(db);
    // The initial guard must run even before any report/index fields are consumed.
    expect(() => saveReport(db, { id: "r", status: "done" } as Parameters<typeof saveReport>[1], {} as Parameters<typeof saveReport>[2], { dir: "/must-not-create-c1" })).toThrow("report_redacted");
  });
  it("administrator lifecycle counts retain deleted history without returning its body", () => {
    const db = fixture(); applyRedactionTombstone(db, record);
    expect(reportStatusCounts(db).deleted).toBe(1);
    expect(listRecentReports(db)[0]).toMatchObject({ id: "r", status: "deleted" });
    expect(listRecentReports(db)[0]).not.toHaveProperty("body_md");
    expect(getReport(db, "r")).toBeNull();
  });
  it("a valid duplicate repairs dirty projections rather than treating INSERT changes=0 as success", () => {
    const db = fixture(); insertFact(db);
    applyRedactionTombstone(db, record);
    expect(db.prepare("SELECT status,body_path FROM report WHERE id='r'").get()).toEqual({ status: "deleted", body_path: null });
    expect(db.prepare("SELECT count(*) n FROM report_index").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM report_fts").get()).toEqual({ n: 0 });
  });
  it("same ID with conflicting immutable fields is rejected before cleanup", () => {
    const db = fixture(); insertFact(db);
    expect(() => applyRedactionTombstone(db, { ...record, registry_ref: "different" })).toThrow("redaction_record_conflict");
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
  });
  it("cleanup failure rolls back a new fact and earlier report updates", () => {
    const db = fixture();
    db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON report_index BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(() => applyRedactionTombstone(db, record)).toThrow("injected");
    expect(db.prepare("SELECT count(*) n FROM provenance_redaction").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
  });
  it("a future deletion does not withdraw the report before its effective time", () => {
    const db = fixture(); applyRedactionTombstone(db, { ...record, effective_at: "2090-01-01T00:00:00.000Z", expiry_at: "2091-01-01T00:00:00.000Z" });
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
    expect(isReportReaderVisible(db, "r")).toBe(true);
  });
  it.each(["2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00+00:00", "not-time"])("rejects invalid report effective time %s", (effective_at) => {
    const db = fixture(); expect(() => applyRedactionTombstone(db, { ...record, effective_at })).toThrow("redaction_time_invalid");
    expect(db.prepare("SELECT count(*) n FROM provenance_redaction").get()).toEqual({ n: 0 });
  });
  it("migration freezes the same DDL as the schema fact source", () => {
    const db = fixture();
    expect(db.prepare("SELECT checksum FROM schema_migration WHERE version='20261003_47_report_redaction_boundary'").get())
      .toEqual({ checksum: createHash("sha256").update(REPORT_REDACTION_BOUNDARY_SCHEMA_SQL).digest("hex") });
  });
  it("DDL prevents status/identity resurrection, replacement and projection rebinding", () => {
    const db = fixture(); insertFact(db);
    expect(() => db.exec("UPDATE report SET status='done' WHERE id='r'")).toThrow("report_redacted");
    expect(() => db.exec("UPDATE report SET id='other' WHERE id='r'")).toThrow("report_redacted");
    expect(() => db.exec("INSERT OR REPLACE INTO report SELECT * FROM report WHERE id='r'")).toThrow("report_redacted");
    expect(() => db.exec("UPDATE report_index SET report_id='other' WHERE report_id='r'")).toThrow("report_redacted");
    expect(() => db.exec("INSERT OR REPLACE INTO report_index SELECT * FROM report_index WHERE report_id='r'")).toThrow("report_redacted");
    expect(() => db.exec("INSERT OR REPLACE INTO provenance_redaction SELECT * FROM provenance_redaction")).toThrow("redaction_record_conflict");
  });
  it("an absent report ID cannot subsequently be inserted as done", () => {
    const db = fixture(); insertFact(db, { ...record, entity_key: "report:missing" });
    expect(() => db.exec(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,citation_count,cost)
      VALUES ('missing','brief','t','done','2020-01-01T00:00:00Z','secret','/missing/r','[]','[]',0,'{}')`)).toThrow("report_redacted");
  });
  it("a future record activates reader and writer protection when the DB clock passes effective_at", () => {
    const db = fixture(); let clock = "2089-01-01T00:00:00.000Z";
    // Same connection executes real reader SQL and real triggers; override only the clock.
    db.function("julianday", (value: unknown) => Date.parse(value === "now" ? clock : String(value)));
    insertFact(db, { ...record, effective_at: "2090-01-01T00:00:00.000Z", expiry_at: "2091-01-01T00:00:00.000Z" });
    expect(isReportReaderVisible(db, "r")).toBe(true);
    clock = "2090-01-01T00:00:00.000Z";
    expect(isReportReaderVisible(db, "r")).toBe(false);
    expect(() => db.exec("UPDATE report SET status='done' WHERE id='r'")).toThrow("report_redacted");
  });
  function downgrade(db: DB): void {
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'redacted_%' OR name IN ('redaction_no_replace','redaction_report_valid'))").all() as { name: string }[];
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
    db.exec("DROP VIEW report_redaction_boundary; DELETE FROM schema_migration WHERE version='20261003_47_report_redaction_boundary';");
  }
  it("the real migration repairs an expired dirty snapshot and keeps immutable fields", () => {
    const db = fixture(); downgrade(db); insertFact(db);
    applyProvenanceMigrations(db);
    expect(db.prepare("SELECT status,body_path FROM report WHERE id='r'").get()).toEqual({ status: "deleted", body_path: null });
    expect(db.prepare("SELECT expiry_at FROM provenance_redaction").get()).toEqual({ expiry_at: record.expiry_at });
    expect(searchReports(db, "secret")).toEqual([]);
  });
  it("migration failure rolls back cleanup, constraints and ledger", () => {
    const db = fixture(); downgrade(db); insertFact(db);
    db.exec("CREATE TRIGGER fail_migration BEFORE DELETE ON report_index BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(() => applyProvenanceMigrations(db)).toThrow("injected");
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='report_redaction_boundary'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM schema_migration WHERE version='20261003_47_report_redaction_boundary'").get()).toBeUndefined();
  });
  it("migration rejects invalid legacy records rather than silently excluding them", () => {
    const db = fixture(); downgrade(db); insertFact(db, { ...record, effective_at: "2020-02-30T00:00:00.000Z" });
    expect(() => applyProvenanceMigrations(db)).toThrow("redaction_time_invalid");
    expect(db.prepare("SELECT status FROM report WHERE id='r'").get()).toEqual({ status: "done" });
  });
});

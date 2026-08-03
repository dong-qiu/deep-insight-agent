import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { activeRedaction, applyRedactionTombstone } from "./redaction.js";
import { getReport, queryReportIndex, searchReports } from "./reports.js";

describe("provenance redaction tombstones", () => {
  it("is idempotent, append-only, and only resolves during its effective interval", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    const tombstone = {
      record_id: "record_1", entity_key: "report:v1:abc", scope: "entity", reason_code: "user_erasure",
      effective_at: "2026-08-03T00:00:00.000Z", expiry_at: "2026-11-11T00:00:00.000Z", registry_ref: "records/2026/08/record_1.json",
    };
    applyRedactionTombstone(db, tombstone);
    applyRedactionTombstone(db, tombstone);
    expect(activeRedaction(db, tombstone.entity_key, "2026-08-02T23:59:59.000Z")).toBeNull();
    expect(activeRedaction(db, tombstone.entity_key, "2026-08-03T00:00:00.000Z")).toMatchObject({ reason_code: "user_erasure" });
    expect(activeRedaction(db, tombstone.entity_key, "2026-11-11T00:00:00.000Z")).toBeNull();
    expect(() => db.prepare("DELETE FROM provenance_redaction WHERE record_id='record_1'").run()).toThrow("append-only");
  });

  it("replay 到删除前快照时同步撤下报告正文、索引与 FTS", () => {
    const db = openDb(":memory:");
    applyProvenanceMigrations(db);
    db.prepare("INSERT INTO topic(id,name,keywords,language,brief_schedule,enabled) VALUES ('t','T','[]','en','daily',1)").run();
    db.prepare(`INSERT INTO report(id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
      VALUES ('r','brief','t','done','2026-08-03T00:00:00Z','R','/tmp/r','[]','[]',NULL,0,'{}',NULL)`).run();
    db.prepare(`INSERT INTO report_index(report_id,type,topic_id,facets,date,source_ids,title,summary,highlights,tags,entity_names,importance,event_ids,milestone_count)
      VALUES ('r','brief','t','[]','2026-08-03','[]','R','deleted replay','[]','[]','[]',0,'[]',0)`).run();
    db.prepare("INSERT INTO report_fts(report_id,title,summary,body) VALUES ('r','R','deleted replay','deleted replay')").run();

    applyRedactionTombstone(db, { record_id: "record_r", entity_key: "report:r", scope: "report", reason_code: "user_erasure", effective_at: "2026-08-03T00:00:00.000Z", expiry_at: "2026-11-11T00:00:00.000Z", registry_ref: "records/2026/08/record_r.json" });
    expect(getReport(db, "r")).toBeNull();
    expect(queryReportIndex(db, { topic: "t" })).toEqual([]);
    expect(searchReports(db, "deleted")).toEqual([]);
  });
});

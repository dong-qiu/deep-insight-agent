/** Eval-Gate scoped：真实 runReportGen → saveReport 双 artifact/索引 → reader 的生产路径回归。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReport, queryReportIndex } from "../db/reports.js";
import { openDb, type DB } from "../db/index.js";
import { insertTopic, listRuns } from "../db/repos.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import type { AnalysisBatch, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";

const { buildReportMock } = vi.hoisted(() => ({ buildReportMock: vi.fn() }));
vi.mock("./report-gen.js", async (orig) => ({
  ...(await orig<typeof import("./report-gen.js")>()),
  buildReport: buildReportMock,
}));
import { runReportGen } from "./pipeline.js";

let db: DB;
let dataDir: string;
const originalDataDir = process.env.DATA_DIR;
const topic: Topic = { id: "t1", name: "Topic", keywords: [], language: "en", brief_schedule: "daily", enabled: true, facets: [] };
const batch: AnalysisBatch = {
  id: "b1", topic_id: topic.id, time_window: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" },
  status: "done", no_significant_event: false, insights: [{
    id: "i1", topic_id: topic.id, type: "aggregation", event_id: null, statement: "A validated statement", importance: 3,
    importance_basis: "test", citations: [], source_count: 0, multi_source: false,
    time_window: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" }, confidence: "high", language: "en", is_followup: false, entities: [], tags: [],
  }],
};
const validation: ValidationResult = {
  checks: [], report: { total: 0, pass: 0, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true },
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "insight-reportgen-"));
  process.env.DATA_DIR = dataDir;
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertTopic(db, topic);
  buildReportMock.mockReset();
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir == null) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("runReportGen production persistence path", () => {
  it("publishes a validated report that the normal reader and index can consume", async () => {
    const report: Report = {
      id: "rep_1", type: "brief", topic_id: topic.id, status: "done", generated_at: "2026-08-02T00:00:00Z", title: "Brief",
      body_md: "# Brief\nvalidated", body_html: "<h1>Brief</h1><p>validated</p>", insight_ids: ["i1"], event_ids: [], prev_report_id: null, citation_count: 0, cost: { tokens: 0, amount: 0 },
    };
    const index: ReportIndexEntry = { report_id: report.id, type: report.type, topic_id: topic.id, facets: [], date: "2026-08-02", source_ids: [], title: report.title, summary: "validated", highlights: [], tags: [], entity_names: [], importance: 3, event_ids: [], milestone_count: 0 };
    buildReportMock.mockReturnValue({ report, index });

    await expect(runReportGen(db, { topic, batch, validation, type: "brief" })).resolves.toMatchObject({ id: report.id });
    expect(getReport(db, report.id)).toEqual(report);
    expect(queryReportIndex(db, { topic: topic.id }).map((row) => row.report_id)).toEqual([report.id]);
    expect(listRuns(db, { kind: "report-gen" })[0]?.status).toBe("done");
  });

  it("does not publish an unreleasable batch to the normal reader or index", async () => {
    const unreleasable: ValidationResult = { ...validation, report: { ...validation.report, releasable: false, insights_includable: 0 } };
    await expect(runReportGen(db, { topic, batch, validation: unreleasable, type: "brief" })).rejects.toThrow("no_releasable_insight");
    expect(queryReportIndex(db, { topic: topic.id })).toEqual([]);
    expect(db.prepare("SELECT status,body_path FROM report").all()).toEqual([{ status: "failed", body_path: null }]);
  });
});

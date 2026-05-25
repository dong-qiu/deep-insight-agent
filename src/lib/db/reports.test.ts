import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import type { Report, ReportIndexEntry, Topic } from "../types.js";
import { type DB, openDb } from "./index.js";
import { getReport, saveReport, searchReports } from "./reports.js";
import { insertTopic } from "./repos.js";

const dir = mkdtempSync(join(tmpdir(), "ia-reports-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let db: DB;
const topic: Topic = {
  id: "t1", name: "T", keywords: ["k"], industry: "ai-swe", language: "zh",
  brief_schedule: "daily", enabled: true,
};
beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
});

const report: Report = {
  id: "rep_test1", type: "brief", topic_id: "t1", status: "done", generated_at: "2026-05-07T08:00:00Z",
  title: "Code Agent Brief",
  body_md: "# Code Agent Brief\n\nReward hacking persists in coding agents.",
  body_html: "<h1>Code Agent Brief</h1>",
  insight_ids: ["i1"], event_ids: ["e1"], prev_report_id: null, citation_count: 2,
  cost: { tokens: 0, amount: 0 },
};
const index: ReportIndexEntry = {
  report_id: "rep_test1", type: "brief", topic_id: "t1", industry: "ai-swe", date: "2026-05-07",
  source_ids: ["s_a"], title: "Code Agent Brief", summary: "Reward hacking persists.", tags: ["t-x"],
  entity_names: [], importance: 5, event_ids: ["e1"],
};

it("saveReport → getReport 往返（正文走 FS）", () => {
  saveReport(db, report, index, { dir });
  expect(getReport(db, "rep_test1")).toEqual(report);
});

it("FTS5 全文检索命中正文/标题", () => {
  saveReport(db, report, index, { dir });
  expect(searchReports(db, "reward hacking")).toEqual(["rep_test1"]);
  expect(searchReports(db, "coding")).toEqual(["rep_test1"]);
  expect(searchReports(db, "nonexistentword")).toEqual([]);
});

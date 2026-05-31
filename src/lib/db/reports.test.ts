import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import type { AnalysisBatch, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { getReport, listBlockedChecksForReport, saveReport, searchReports } from "./reports.js";
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

it("listBlockedChecksForReport：按报告下钻 validator 屏蔽的引用 + 真实理由（reachability fail / consistency not_support 分流）", () => {
  saveReport(db, report, index, { dir });
  const win = { start: "2026-05-01", end: "2026-05-07" };
  const batch: AnalysisBatch = {
    id: "b_for_test1", topic_id: "t1", time_window: win, status: "done", no_significant_event: false,
    insights: [
      {
        id: "i1", topic_id: "t1", type: "aggregation", event_id: "e1", statement: "S1 long",
        importance: 4, importance_basis: "x",
        citations: [
          { content_item_id: "ci_a", quote: "Q good", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } },
          { content_item_id: "ci_b", quote: "Q exaggerated", locator: { paragraph_index: 0, char_start: 1, char_end: 2 } },
          { content_item_id: "ci_c", quote: "Q broken-ref", locator: { paragraph_index: 0, char_start: 2, char_end: 3 } },
        ],
        source_count: 3, multi_source: true, time_window: win, confidence: null, language: "zh",
      },
    ],
  };
  saveAnalysisBatch(db, batch);
  const v: ValidationResult = {
    checks: [
      { insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "i1", citation_index: 1, reachability: "pass", reachability_reason: "ok", consistency: "not_support", consistency_reason: "exaggeration", verdict: "blocked" },
      { insight_id: "i1", citation_index: 2, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "blocked" },
    ],
    report: { total: 3, pass: 1, blocked: 2, flagged: 0, consistency_failure_rate: 0.33, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true },
  };
  saveValidationResult(db, batch.id, v);

  const blocked = listBlockedChecksForReport(db, "rep_test1");
  expect(blocked).toHaveLength(2); // 仅 verdict=blocked 的 2 条
  expect(blocked.map((b) => b.citation_index)).toEqual([1, 2]); // pass 的 0 不在
  // 路线 1：reachability=pass → reason = consistency_reason
  expect(blocked[0]).toMatchObject({
    insight_id: "i1", quote: "Q exaggerated", content_item_id: "ci_b",
    reachability: "pass", consistency: "not_support", reason: "exaggeration",
  });
  // 路线 2：reachability=fail → reason = reachability_reason（不取 consistency）
  expect(blocked[1]).toMatchObject({
    insight_id: "i1", quote: "Q broken-ref", content_item_id: "ci_c",
    reachability: "fail", reason: "quote_not_in_source",
  });
  expect(blocked[0].statement).toBe("S1 long"); // 联表带出 statement
});

it("FS 正文缺失（孤儿 DB 行）→ getReport 兜底占位、不抛", () => {
  saveReport(db, report, index, { dir });
  rmSync(join(dir, `${report.id}.md`), { force: true });
  rmSync(join(dir, `${report.id}.html`), { force: true });
  const r = getReport(db, "rep_test1");
  expect(r).not.toBeNull();
  expect(r!.body_md).toContain("正文文件缺失");
  expect(r!.title).toBe("Code Agent Brief"); // 元数据仍来自 DB
});

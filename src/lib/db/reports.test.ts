import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisBatch, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { getReport, listBlockedChecksForReport, queryReportIndex, saveReport, searchReports } from "./reports.js";
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

describe("queryReportIndex（B-1+2 报告库筛/搜/排）", () => {
  // 4 条多样化样本
  const samples: ReportIndexEntry[] = [
    { report_id: "r1", type: "brief", topic_id: "t_swe", industry: "ai-swe", date: "2026-06-01", source_ids: ["s1"], title: "AI 软件工程·6月1日", summary: "DHH AI 编码", tags: [], entity_names: ["DHH"], importance: 5, event_ids: [] },
    { report_id: "r2", type: "deep_dive", topic_id: "t_swe", industry: "ai-swe", date: "2026-06-05", source_ids: ["s1"], title: "深度·Coding Agent", summary: "Cursor Composer", tags: [], entity_names: ["Cursor"], importance: 4, event_ids: [] },
    { report_id: "r3", type: "brief", topic_id: "t_sec", industry: "ai-security", date: "2026-06-03", source_ids: ["s2"], title: "AI 安全·6月3日", summary: "Prompt injection 案例", tags: [], entity_names: [], importance: 3, event_ids: [] },
    { report_id: "r4", type: "initial_digest", topic_id: "t_sec", industry: "ai-security", date: "2026-05-20", source_ids: ["s2"], title: "首版·ATLAS 综述", summary: "MITRE ATLAS", tags: [], entity_names: ["MITRE"], importance: 5, event_ids: [] },
  ];

  beforeEach(() => {
    insertTopic(db, { id: "t_swe", name: "SWE", keywords: [], industry: "ai-swe", language: "zh", brief_schedule: "daily", enabled: true });
    insertTopic(db, { id: "t_sec", name: "SEC", keywords: [], industry: "ai-security", language: "zh", brief_schedule: "daily", enabled: true });
    for (const idx of samples) {
      const rep: Report = {
        id: idx.report_id, type: idx.type, topic_id: idx.topic_id, status: "done",
        generated_at: `${idx.date}T08:00:00Z`, title: idx.title,
        body_md: `# ${idx.title}\n${idx.summary}`, body_html: `<h1>${idx.title}</h1>`,
        insight_ids: [], event_ids: [], prev_report_id: null, citation_count: 0,
        cost: { tokens: 0, amount: 0 },
      };
      saveReport(db, rep, idx, { dir });
    }
  });

  it("无筛选 → 4 条按 date desc 默认", () => {
    const rs = queryReportIndex(db);
    expect(rs.map((r) => r.report_id)).toEqual(["r2", "r3", "r1", "r4"]);
  });

  it("type=brief → 仅 2 条", () => {
    const rs = queryReportIndex(db, { type: "brief" });
    expect(rs.map((r) => r.report_id).sort()).toEqual(["r1", "r3"]);
  });

  it("industry=ai-security → r3 + r4", () => {
    const rs = queryReportIndex(db, { industry: "ai-security" });
    expect(rs.map((r) => r.report_id).sort()).toEqual(["r3", "r4"]);
  });

  it("from + to 区间筛选 → 仅 r2/r3/r1", () => {
    const rs = queryReportIndex(db, { from: "2026-06-01", to: "2026-06-05" });
    expect(rs.map((r) => r.report_id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("sort=importance desc → 5/5/4/3", () => {
    const rs = queryReportIndex(db, { sort: "importance" });
    expect(rs.map((r) => r.importance)).toEqual([5, 5, 4, 3]);
  });

  it("sort=date asc → r4 最早", () => {
    const rs = queryReportIndex(db, { sort: "date", dir: "asc" });
    expect(rs[0].report_id).toBe("r4");
  });

  it("q='ATLAS' FTS5 命中 r4（标题）+ 不命中 r1", () => {
    const rs = queryReportIndex(db, { q: "ATLAS" });
    expect(rs.map((r) => r.report_id)).toContain("r4");
    expect(rs.map((r) => r.report_id)).not.toContain("r1");
  });

  it("非法 type 静默忽略走默认（不抛、不过滤）", () => {
    const rs = queryReportIndex(db, { type: "garbage" });
    expect(rs.length).toBe(4);
  });

  it("非法 industry 静默忽略（Sonnet R1 critical：与 type 同口径白名单）", () => {
    const rs = queryReportIndex(db, { industry: "garbage" });
    expect(rs.length).toBe(4); // 不过滤、全返
  });

  it("非法 sort 字段（注入面）走默认 date", () => {
    // 即使传 'id; DROP TABLE'，因走 SORT_COLS 映射，未匹配 key 必 fallback 到 date
    const rs = queryReportIndex(db, { sort: "id; DROP TABLE report_index--" });
    expect(rs.map((r) => r.report_id)).toEqual(["r2", "r3", "r1", "r4"]); // 默认 date desc 顺序
  });

  it("非法日期格式静默忽略", () => {
    const rs = queryReportIndex(db, { from: "not-a-date" });
    expect(rs.length).toBe(4);
  });

  it("组合筛选：type+industry+from → 单条命中", () => {
    const rs = queryReportIndex(db, {
      type: "deep_dive", industry: "ai-swe", from: "2026-06-01",
    });
    expect(rs.map((r) => r.report_id)).toEqual(["r2"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisBatch, Report, ReportIndexEntry, Topic, ValidationResult } from "../types.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { chainTypesFor, distinctIndexValues, entityTrends, getReport, latestReportForTopicSince, listBlockedChecksForReport, listRecentBriefEvents, listRecentReports, previousReportForTopic, queryReportIndex, reportNeighbors, reportStatusCounts, sanitizeFtsQuery, saveReport, searchReports, SNIPPET_CLOSE, SNIPPET_OPEN, topicEvolution, topicReportStats } from "./reports.js";
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
  source_ids: ["s_a"], title: "Code Agent Brief", summary: "Reward hacking persists.",
  highlights: ["Reward hacking 仍在"], tags: ["t-x"],
  entity_names: [], importance: 5, event_ids: ["e1"], milestone_count: 0,
};

it("saveReport → getReport 往返（正文走 FS）", () => {
  saveReport(db, report, index, { dir });
  expect(getReport(db, "rep_test1")).toEqual(report);
});

it("report_index 往返保留 milestone_count（ADR-0006）", () => {
  saveReport(db, report, { ...index, milestone_count: 2 }, { dir });
  const [row] = queryReportIndex(db, { topic: "t1" });
  expect(row.milestone_count).toBe(2);
});

it("latestReportForTopicSince：只认 since 之后本主题最新的【已完成深挖】报告（深挖进度 3.3 终态链接）", () => {
  const since = "2026-06-14T10:00:00Z";
  insertTopic(db, { ...topic, id: "t2" });
  saveReport(db, { ...report, id: "rep_old", type: "deep_dive", generated_at: "2026-06-13T08:00:00Z" }, { ...index, report_id: "rep_old", type: "deep_dive" }, { dir });
  expect(latestReportForTopicSince(db, "t1", since)).toBeNull(); // 触发前的不算
  // 窗口内但 type=brief（每日 cron 落库）——绝不能误判为深挖完成（review 实锤的错报告链接 bug）
  saveReport(db, { ...report, id: "rep_brief", type: "brief", generated_at: "2026-06-14T10:05:00Z" }, { ...index, report_id: "rep_brief", type: "brief" }, { dir });
  expect(latestReportForTopicSince(db, "t1", since)).toBeNull(); // brief 不算完成
  // 窗口内但 status=failed 的深挖——也不算完成
  saveReport(db, { ...report, id: "rep_fail", type: "deep_dive", status: "failed", generated_at: "2026-06-14T10:05:30Z" }, { ...index, report_id: "rep_fail", type: "deep_dive" }, { dir });
  expect(latestReportForTopicSince(db, "t1", since)).toBeNull(); // failed 不算完成
  saveReport(db, { ...report, id: "rep_new", type: "deep_dive", generated_at: "2026-06-14T10:06:00Z" }, { ...index, report_id: "rep_new", type: "deep_dive" }, { dir });
  saveReport(db, { ...report, id: "rep_other", type: "deep_dive", topic_id: "t2", generated_at: "2026-06-14T10:07:00Z" }, { ...index, report_id: "rep_other", topic_id: "t2", type: "deep_dive" }, { dir });
  expect(latestReportForTopicSince(db, "t1", since)).toEqual({ id: "rep_new", title: report.title, type: "deep_dive" }); // 别主题 rep_other 不串
});

it("reportStatusCounts / listRecentReports：全状态计数 + 近 N 份倒序（含瞬态）", () => {
  saveReport(db, { ...report, id: "r_done", status: "done", generated_at: "2026-05-07T08:00:00Z" }, { ...index, report_id: "r_done" }, { dir });
  saveReport(db, { ...report, id: "r_fail", status: "failed", generated_at: "2026-05-08T08:00:00Z" }, { ...index, report_id: "r_fail" }, { dir });
  saveReport(db, { ...report, id: "r_gen", status: "generating", generated_at: "2026-05-09T08:00:00Z" }, { ...index, report_id: "r_gen" }, { dir });
  expect(reportStatusCounts(db)).toEqual({ done: 1, failed: 1, generating: 1 });
  const recent = listRecentReports(db, 2);
  expect(recent.map((r) => r.id)).toEqual(["r_gen", "r_fail"]); // 倒序、limit 生效
  expect(recent[0]).toMatchObject({ status: "generating", type: "brief" });
  expect(recent[0].cost).toEqual(report.cost); // cost JSON 解析
});

it("chainTypesFor：brief/initial_digest 同链，deep_dive 独立链", () => {
  expect(chainTypesFor("brief")).toEqual(["brief", "initial_digest"]);
  expect(chainTypesFor("initial_digest")).toEqual(["brief", "initial_digest"]);
  expect(chainTypesFor("deep_dive")).toEqual(["deep_dive"]);
});

it("previousReportForTopic：本批之前同链最新 done 报告作前情；跨链/跨主题/非 done 不串", () => {
  insertTopic(db, { ...topic, id: "t2" });
  // 链头：冷启动 initial_digest
  saveReport(db, { ...report, id: "rep_init", type: "initial_digest", generated_at: "2026-05-01T08:00:00Z" }, { ...index, report_id: "rep_init", type: "initial_digest" }, { dir });
  // 第一篇 brief 的前情应回溯到 initial_digest（同属每日节奏链）
  expect(previousReportForTopic(db, "t1", "brief")).toBe("rep_init");
  // 深挖链与日度链不混：此刻无 done 深挖 → null
  expect(previousReportForTopic(db, "t1", "deep_dive")).toBeNull();
  // 落一篇更晚的 brief → 成为最新前情
  saveReport(db, { ...report, id: "rep_b1", type: "brief", generated_at: "2026-05-02T08:00:00Z" }, { ...index, report_id: "rep_b1", type: "brief" }, { dir });
  expect(previousReportForTopic(db, "t1", "brief")).toBe("rep_b1");
  // failed 不算前情
  saveReport(db, { ...report, id: "rep_bad", type: "brief", status: "failed", generated_at: "2026-05-03T08:00:00Z" }, { ...index, report_id: "rep_bad", type: "brief" }, { dir });
  expect(previousReportForTopic(db, "t1", "brief")).toBe("rep_b1");
  // 别主题不串
  expect(previousReportForTopic(db, "t2", "brief")).toBeNull();
});

it("reportNeighbors：prev 取自 prev_report_id，next 反查谁记本报告为前情", () => {
  saveReport(db, { ...report, id: "rep_a", prev_report_id: null, generated_at: "2026-05-01T08:00:00Z" }, { ...index, report_id: "rep_a" }, { dir });
  saveReport(db, { ...report, id: "rep_b", title: "B 报告", prev_report_id: "rep_a", generated_at: "2026-05-02T08:00:00Z" }, { ...index, report_id: "rep_b", title: "B 报告" }, { dir });
  saveReport(db, { ...report, id: "rep_c", title: "C 报告", prev_report_id: "rep_b", generated_at: "2026-05-03T08:00:00Z" }, { ...index, report_id: "rep_c", title: "C 报告" }, { dir });
  // 中间节点 b：前 a、后 c
  expect(reportNeighbors(db, { id: "rep_b", prev_report_id: "rep_a" })).toEqual({
    prev: { id: "rep_a", title: report.title, type: "brief" },
    next: { id: "rep_c", title: "C 报告", type: "brief" },
  });
  // 链头 a：无前、有后 b
  expect(reportNeighbors(db, { id: "rep_a", prev_report_id: null })).toEqual({
    prev: null,
    next: { id: "rep_b", title: "B 报告", type: "brief" },
  });
  // 链尾 c：有前 b、无后
  expect(reportNeighbors(db, { id: "rep_c", prev_report_id: "rep_b" })).toEqual({
    prev: { id: "rep_b", title: "B 报告", type: "brief" },
    next: null,
  });
});

it("reportNeighbors：next 分叉（同 prev 被多篇重生成引用）取最新 done 一条", () => {
  saveReport(db, { ...report, id: "rep_h", prev_report_id: null, generated_at: "2026-05-01T08:00:00Z" }, { ...index, report_id: "rep_h" }, { dir });
  // 两篇都把 rep_h 记为前情（重生成分叉）；next 应取 generated_at 最新的 rep_n2
  saveReport(db, { ...report, id: "rep_n1", title: "旧分叉", prev_report_id: "rep_h", generated_at: "2026-05-02T08:00:00Z" }, { ...index, report_id: "rep_n1", title: "旧分叉" }, { dir });
  saveReport(db, { ...report, id: "rep_n2", title: "新分叉", prev_report_id: "rep_h", generated_at: "2026-05-03T08:00:00Z" }, { ...index, report_id: "rep_n2", title: "新分叉" }, { dir });
  expect(reportNeighbors(db, { id: "rep_h", prev_report_id: null }).next).toEqual({ id: "rep_n2", title: "新分叉", type: "brief" });
});

it("reportNeighbors：prev 指向不存在/非 done 报告时安全返 null（不崩）", () => {
  saveReport(db, { ...report, id: "rep_x", prev_report_id: "rep_ghost" }, { ...index, report_id: "rep_x" }, { dir });
  expect(reportNeighbors(db, { id: "rep_x", prev_report_id: "rep_ghost" })).toEqual({ prev: null, next: null });
});

it("saveReport body_path 始终是绝对路径（dogfood 6/6 防相对路径跨环境失效回退）", () => {
  saveReport(db, report, index, { dir: "relative/path/reports" });
  const row = db.prepare("SELECT body_path FROM report WHERE id = ?").get("rep_test1") as { body_path: string };
  expect(row.body_path.startsWith("/")).toBe(true); // POSIX 系上必须 / 开头
  // 清理
  rmSync("relative", { recursive: true, force: true });
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
    report: { total: 3, pass: 1, blocked: 2, flagged: 0, errored: 0, consistency_failure_rate: 0.33, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true },
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
    { report_id: "r1", type: "brief", topic_id: "t_swe", industry: "ai-swe", date: "2026-06-01", source_ids: ["s1"], title: "AI 软件工程·6月1日", summary: "DHH AI 编码", highlights: [], tags: ["trend"], entity_names: ["DHH"], importance: 5, event_ids: [], milestone_count: 0 },
    { report_id: "r2", type: "deep_dive", topic_id: "t_swe", industry: "ai-swe", date: "2026-06-05", source_ids: ["s1", "s3"], title: "深度·Coding Agent", summary: "Cursor Composer", highlights: [], tags: ["trend", "practice"], entity_names: ["Cursor"], importance: 4, event_ids: [], milestone_count: 0 },
    { report_id: "r3", type: "brief", topic_id: "t_sec", industry: "ai-security", date: "2026-06-03", source_ids: ["s2"], title: "AI 安全·6月3日", summary: "Prompt injection 案例", highlights: [], tags: ["case"], entity_names: [], importance: 3, event_ids: [], milestone_count: 0 },
    { report_id: "r4", type: "initial_digest", topic_id: "t_sec", industry: "ai-security", date: "2026-05-20", source_ids: ["s2"], title: "首版·ATLAS 综述", summary: "MITRE ATLAS", highlights: [], tags: [], entity_names: ["MITRE"], importance: 5, event_ids: [], milestone_count: 0 },
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

  it("topic 筛选 → 仅该主题报告（主题页时间线用）", () => {
    expect(queryReportIndex(db, { topic: "t_swe" }).map((r) => r.report_id).sort()).toEqual(["r1", "r2"]);
    expect(queryReportIndex(db, { topic: "t_sec" }).map((r) => r.report_id).sort()).toEqual(["r3", "r4"]);
  });

  it("空白 topic 静默忽略（不过滤）", () => {
    expect(queryReportIndex(db, { topic: "  " }).length).toBe(4);
  });

  it("topic + 日期倒序组合（时间线默认序）", () => {
    const rs = queryReportIndex(db, { topic: "t_sec", sort: "date", dir: "desc" });
    expect(rs.map((r) => r.report_id)).toEqual(["r3", "r4"]); // 06-03 晚于 05-20
  });

  it("source 筛选 → JSON 数组含该源 id 的报告（r2 多源 s1+s3）", () => {
    expect(queryReportIndex(db, { source: "s1" }).map((r) => r.report_id).sort()).toEqual(["r1", "r2"]);
    expect(queryReportIndex(db, { source: "s2" }).map((r) => r.report_id).sort()).toEqual(["r3", "r4"]);
    expect(queryReportIndex(db, { source: "s3" }).map((r) => r.report_id)).toEqual(["r2"]); // 仅 r2 的第二个源
    expect(queryReportIndex(db, { source: "nope" }).length).toBe(0); // 不存在的源 → 0 命中
  });

  it("tag 筛选 → JSON 数组含该标签的报告", () => {
    expect(queryReportIndex(db, { tag: "trend" }).map((r) => r.report_id).sort()).toEqual(["r1", "r2"]);
    expect(queryReportIndex(db, { tag: "practice" }).map((r) => r.report_id)).toEqual(["r2"]);
    expect(queryReportIndex(db, { tag: "case" }).map((r) => r.report_id)).toEqual(["r3"]);
  });

  it("entity 筛选 → JSON 数组含该实体的报告（主题页关键实体下钻）", () => {
    expect(queryReportIndex(db, { entity: "DHH" }).map((r) => r.report_id)).toEqual(["r1"]);
    expect(queryReportIndex(db, { entity: "MITRE" }).map((r) => r.report_id)).toEqual(["r4"]);
    expect(queryReportIndex(db, { entity: "Unknown" }).length).toBe(0);
  });

  it("空白 source/tag/entity 静默忽略（不过滤）", () => {
    expect(queryReportIndex(db, { source: "  " }).length).toBe(4);
    expect(queryReportIndex(db, { tag: "" }).length).toBe(4);
    expect(queryReportIndex(db, { entity: "   " }).length).toBe(4);
  });

  it("source+entity 组合（json_each 多列相关子查询并存）", () => {
    expect(queryReportIndex(db, { source: "s1", entity: "Cursor" }).map((r) => r.report_id)).toEqual(["r2"]);
    expect(queryReportIndex(db, { source: "s2", entity: "Cursor" }).length).toBe(0); // s2 报告无 Cursor
  });

  it("q 带 FTS 特殊字符不抛错（旧实现裸 '-' 会抛 FTS5 语法错 → 丢整段 q）", () => {
    expect(() => queryReportIndex(db, { q: "-" })).not.toThrow(); // 纯操作符 → 消毒后 0 命中、不抛
    expect(() => queryReportIndex(db, { q: "Cursor!" })).not.toThrow();
    // 词内标点被分词器剥离，仍命中 r2（"Cursor"）
    expect(queryReportIndex(db, { q: "Cursor!" }).map((r) => r.report_id)).toContain("r2");
  });

  it("多词隐式 AND：全部词都需命中（含不存在词 → 0）", () => {
    expect(queryReportIndex(db, { q: "Cursor Composer" }).map((r) => r.report_id)).toEqual(["r2"]);
    expect(queryReportIndex(db, { q: "Cursor nonexistentword" }).length).toBe(0);
  });

  it("q 前缀匹配：部分词 'Curso' 命中 Cursor（r2）", () => {
    expect(queryReportIndex(db, { q: "Curso" }).map((r) => r.report_id)).toContain("r2");
  });

  it("q 消毒成空串（纯标点/空白）→ 视作无 q，返回全部", () => {
    expect(queryReportIndex(db, { q: '  "  ' }).length).toBe(4);
  });

  it("有 q 时结果带 snippet（命中词以控制字符标记包裹）", () => {
    const [hit] = queryReportIndex(db, { q: "ATLAS" });
    expect(hit.report_id).toBe("r4");
    expect(hit.snippet).toBeTruthy();
    expect(hit.snippet).toContain(SNIPPET_OPEN); // 命中标记存在
    expect(hit.snippet).toContain(SNIPPET_CLOSE);
  });

  it("无 q 时不带 snippet（瞬时字段仅搜索填充）", () => {
    expect(queryReportIndex(db, { type: "brief" })[0].snippet).toBeUndefined();
  });

  it("sort=relevance 仅在有 q 时按 bm25；无 q 回退 date desc", () => {
    // 无 q 选 relevance → 回退默认 date desc（不抛、不空）
    expect(queryReportIndex(db, { sort: "relevance" }).map((r) => r.report_id)).toEqual(["r2", "r3", "r1", "r4"]);
    // 有 q 且未指定 sort → 默认相关度，命中项非空
    expect(queryReportIndex(db, { q: "AI" }).length).toBeGreaterThan(0);
  });

  it("distinctIndexValues：各 JSON 列去重值升序（下拉选项来源）", () => {
    expect(distinctIndexValues(db, "source_ids")).toEqual(["s1", "s2", "s3"]);
    expect(distinctIndexValues(db, "tags")).toEqual(["case", "practice", "trend"]);
    expect(distinctIndexValues(db, "entity_names")).toEqual(["Cursor", "DHH", "MITRE"]); // 空数组的 r3 不贡献项
  });

  it("topicReportStats：按主题聚合条数 + MAX(date)", () => {
    const stats = topicReportStats(db);
    expect(stats.get("t_swe")).toEqual({ count: 2, latestDate: "2026-06-05" });
    expect(stats.get("t_sec")).toEqual({ count: 2, latestDate: "2026-06-03" });
    expect(stats.has("t_none")).toBe(false); // 无报告的主题不出现在统计里
  });
});

describe("listRecentBriefEvents（P1 不复报 · 喂 analyzer 的历史事件清单）", () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // 两个 brief、不同日期；一个 deep_dive 必须被过滤；event_id 复用判定
  beforeEach(() => {
    const seed = (
      reportId: string,
      type: "brief" | "deep_dive",
      date: string,
      insights: Array<{ id: string; event_id: string | null; statement: string }>,
    ) => {
      const win = { start: date, end: date };
      const batch: AnalysisBatch = {
        id: `b_${reportId}`, topic_id: "t1", time_window: win, status: "done", no_significant_event: false,
        insights: insights.map((s) => ({
          id: s.id, topic_id: "t1", type: "aggregation", event_id: s.event_id, statement: s.statement,
          importance: 4, importance_basis: "x", citations: [], source_count: 1, multi_source: false,
          time_window: win, confidence: null, language: "zh",
        })),
      };
      saveAnalysisBatch(db, batch);
      const rep: Report = {
        id: reportId, type, topic_id: "t1", status: "done", generated_at: `${date}T08:00:00Z`,
        title: `R-${reportId}`, body_md: `# R-${reportId}`, body_html: `<h1>R-${reportId}</h1>`,
        insight_ids: insights.map((s) => s.id), event_ids: [], prev_report_id: null,
        citation_count: 0, cost: { tokens: 0, amount: 0 },
      };
      const idx: ReportIndexEntry = {
        report_id: reportId, type, topic_id: "t1", industry: "ai-swe", date,
        source_ids: [], title: rep.title, summary: "", highlights: [], tags: [], entity_names: [], importance: 4, event_ids: [], milestone_count: 0,
      };
      saveReport(db, rep, idx, { dir });
    };

    seed("rep_today_brief", "brief", today, [
      { id: "ins_t1", event_id: "evt_alpha", statement: "今日 alpha 进展" },
      { id: "ins_t2", event_id: "evt_beta", statement: "今日 beta 新事件" },
    ]);
    seed("rep_yest_brief", "brief", yesterday, [
      { id: "ins_y1", event_id: "evt_alpha", statement: "昨日 alpha 较旧表述" }, // 同 evt_alpha → 应被 today 那条覆盖
      { id: "ins_y2", event_id: null, statement: "无 event_id 的洞察被过滤" }, // NULL event_id 不入清单
    ]);
    seed("rep_deep", "deep_dive", today, [
      { id: "ins_d1", event_id: "evt_deep_only", statement: "深度报告独有事件" }, // 必须不入清单
    ]);
  });

  it("只取 brief；同 event_id 取最新；NULL event_id 过滤；deep_dive 不入", () => {
    const events = listRecentBriefEvents(db, "t1");
    const ids = events.map((e) => e.event_id).sort();
    expect(ids).toEqual(["evt_alpha", "evt_beta"]); // 不含 evt_deep_only
    // evt_alpha 取 today 的 statement，不是 yesterday 那条
    expect(events.find((e) => e.event_id === "evt_alpha")?.statement).toBe("今日 alpha 进展");
    expect(events.find((e) => e.event_id === "evt_alpha")?.date).toBe(today);
  });

  it("sinceDays 过期截断：sinceDays=0 → 仅今日 brief 内 event", () => {
    const events = listRecentBriefEvents(db, "t1", { sinceDays: 0 });
    expect(events.map((e) => e.event_id).sort()).toEqual(["evt_alpha", "evt_beta"]);
  });

  it("limit 截断", () => {
    const events = listRecentBriefEvents(db, "t1", { limit: 1 });
    expect(events).toHaveLength(1);
  });

  it("无报告 / 别的 topic_id → 空数组（冷启动）", () => {
    expect(listRecentBriefEvents(db, "t_other")).toEqual([]);
  });
});

describe("主题持续聚合（ADR-0005）纯函数", () => {
  // report_index fixture 工厂：必填 date/report_id，其余给默认、可覆盖
  const mk = (o: Partial<ReportIndexEntry> & { date: string; report_id: string }): ReportIndexEntry => ({
    type: "brief", topic_id: "t1", industry: "ai-swe", source_ids: [],
    title: o.report_id, summary: "", highlights: [], tags: [], entity_names: [], importance: 1, event_ids: [],
    ...o,
    milestone_count: o.milestone_count ?? 0,
  });

  describe("topicEvolution", () => {
    it("空序列 → []", () => {
      expect(topicEvolution([])).toEqual([]);
    });

    it("按日期升序排列、焦点取前 N、major=importance≥4", () => {
      const pts = topicEvolution([
        mk({ report_id: "r2", date: "2026-06-08", tags: ["b1", "b2", "b3", "b4"], entity_names: ["E1", "E2", "E3", "E4"], importance: 4 }),
        mk({ report_id: "r1", date: "2026-06-01", tags: ["a1"], entity_names: ["X"], importance: 2 }),
      ]);
      expect(pts.map((p) => p.report_id)).toEqual(["r1", "r2"]); // 升序（过去→现在）
      expect(pts[1].focus_tags).toEqual(["b1", "b2", "b3"]); // 前 3
      expect(pts[1].focus_entities).toEqual(["E1", "E2", "E3"]);
      expect(pts[1].major).toBe(true); // importance 4
      expect(pts[0].major).toBe(false); // importance 2
    });

    it("过滤掉无焦点（tags+entities 皆空）的报告点——老报告稀释", () => {
      const pts = topicEvolution([
        mk({ report_id: "empty1", date: "2026-06-01" }), // 抽取激活前：无 tags/entities
        mk({ report_id: "has", date: "2026-06-02", tags: ["x"] }),
        mk({ report_id: "empty2", date: "2026-06-03", entity_names: [] }),
      ]);
      expect(pts.map((p) => p.report_id)).toEqual(["has"]); // 仅保留有焦点的点
    });

    it("不改入参（拷贝后排序）", () => {
      const input = [mk({ report_id: "r2", date: "2026-06-08", tags: ["z"] }), mk({ report_id: "r1", date: "2026-06-01", tags: ["a"] })];
      topicEvolution(input);
      expect(input.map((r) => r.report_id)).toEqual(["r2", "r1"]); // 原序不动
    });
  });

  describe("entityTrends", () => {
    // 等长报告序列工厂：第 i 篇含 picker(i) 给出的实体
    const series = (dates: string[], picker: (i: number) => string[]): ReportIndexEntry[] =>
      dates.map((d, i) => mk({ report_id: `r${i}`, date: d, entity_names: picker(i) }));
    const FOUR = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];

    it("空序列 → []", () => {
      expect(entityTrends([])).toEqual([]);
    });

    it("total=报告覆盖数、按 total 降序、limit 截断", () => {
      const reports = [
        mk({ report_id: "r1", date: "2026-06-01", entity_names: ["A", "B"] }),
        mk({ report_id: "r2", date: "2026-06-02", entity_names: ["A"] }),
        mk({ report_id: "r3", date: "2026-06-03", entity_names: ["A", "C"] }),
      ];
      const t = entityTrends(reports);
      expect(t.map((x) => x.name)).toEqual(["A", "B", "C"]); // A=3 居首；B,C=1 按首现序
      expect(t[0]).toMatchObject({ name: "A", total: 3 });
      expect(entityTrends(reports, 2)).toHaveLength(2); // limit
    });

    it("趋势 up：实体只在后半出现", () => {
      const hot = entityTrends(series(FOUR, (i) => (i >= 2 ? ["Hot"] : []))).find((x) => x.name === "Hot")!;
      expect(hot).toMatchObject({ total: 2, trend: "up" });
    });

    it("趋势 down：实体只在前半出现", () => {
      const cold = entityTrends(series(FOUR, (i) => (i < 2 ? ["Cold"] : []))).find((x) => x.name === "Cold")!;
      expect(cold.trend).toBe("down");
    });

    it("少样本防抖：仅出现 1 份报告 → flat（即便落在后半）", () => {
      const one = entityTrends(series(FOUR, (i) => (i === 3 ? ["One"] : []))).find((x) => x.name === "One")!;
      expect(one).toMatchObject({ total: 1, trend: "flat" });
    });

    it("前后持平 → flat", () => {
      const even = entityTrends(series(["2026-06-01", "2026-06-04"], () => ["Even"])).find((x) => x.name === "Even")!;
      expect(even.trend).toBe("flat");
    });

    it("buckets 长度=min(8,报告数)，桶计数之和=total", () => {
      const reports = Array.from({ length: 12 }, (_, i) =>
        mk({ report_id: `r${i}`, date: `2026-06-${String(i + 1).padStart(2, "0")}`, entity_names: ["Z"] }));
      const z = entityTrends(reports).find((x) => x.name === "Z")!;
      expect(z.buckets).toHaveLength(8);
      expect(z.buckets.reduce((a, b) => a + b, 0)).toBe(12);
    });

    it("同日报告分桶退化不崩", () => {
      const same = entityTrends(series(["2026-06-01", "2026-06-01", "2026-06-01"], () => ["Same"])).find((x) => x.name === "Same")!;
      expect(same.total).toBe(3);
      expect(same.buckets.reduce((a, b) => a + b, 0)).toBe(3);
    });
  });
});

describe("sanitizeFtsQuery（查询消毒 → 永不抛错的 MATCH 表达式）", () => {
  it("普通词 → 每词包成 \"term\"* 隐式 AND", () => {
    expect(sanitizeFtsQuery("agent security")).toBe('"agent"* "security"*');
  });

  it("中和 FTS 操作符：裸 '-' / 引号 / 冒号不破坏语法", () => {
    expect(sanitizeFtsQuery("-foo")).toBe('"-foo"*');
    expect(sanitizeFtsQuery('a"b')).toBe('"ab"*'); // 词内引号被剥
    expect(sanitizeFtsQuery("col:val")).toBe('"col:val"*');
  });

  it("多余空白折叠；纯空白 → 空串", () => {
    expect(sanitizeFtsQuery("  a   b  ")).toBe('"a"* "b"*');
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  it("纯引号 → 空串（剥引号后无内容）", () => {
    expect(sanitizeFtsQuery('""')).toBe("");
  });

  it("中文无空格词整体包裹（前缀使其可命中分词后的库）", () => {
    expect(sanitizeFtsQuery("软件工程")).toBe('"软件工程"*');
  });
});

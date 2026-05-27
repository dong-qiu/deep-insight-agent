import { describe, expect, it } from "vitest";
import type { AnalysisBatch, ContentItem, Topic, ValidationResult } from "../types.js";
import { buildReport, selectInsights } from "./report-gen.js";

const topic: Topic = {
  id: "t1", name: "Code Agent", keywords: ["a"], industry: "ai-swe", language: "zh",
  brief_schedule: "daily", enabled: true,
};
const win = { start: "2026-05-01", end: "2026-05-07" };

function batchOf(): AnalysisBatch {
  return {
    id: "b1", topic_id: "t1", time_window: win, status: "done", no_significant_event: false,
    insights: [
      {
        id: "i1", topic_id: "t1", type: "aggregation", event_id: "e1", statement: "S1", importance: 4,
        importance_basis: "x",
        citations: [
          { content_item_id: "ci1", quote: "q1", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } },
          { content_item_id: "ci2", quote: "q2", locator: { paragraph_index: 0, char_start: 1, char_end: 2 } },
        ],
        source_count: 2, multi_source: true, time_window: win, confidence: null, language: "zh",
      },
      {
        id: "i2", topic_id: "t1", type: "trend", event_id: null, statement: "S2", importance: 5,
        importance_basis: "y",
        citations: [{ content_item_id: "ci3", quote: "q3", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
        source_count: 1, multi_source: false, time_window: win, confidence: "high", language: "zh",
      },
      {
        id: "i3", topic_id: "t1", type: "aggregation", event_id: null, statement: "S3 all blocked", importance: 3,
        importance_basis: "z",
        citations: [{ content_item_id: "ci4", quote: "q4", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
        source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
      },
    ],
  };
}

const validation: ValidationResult = {
  checks: [
    { insight_id: "i1", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
    { insight_id: "i1", citation_index: 1, reachability: "pass", reachability_reason: "ok", consistency: "not_support", consistency_reason: "exaggeration", verdict: "blocked" },
    { insight_id: "i2", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict: "flagged" },
    { insight_id: "i3", citation_index: 0, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "blocked" },
  ],
  report: { total: 4, pass: 1, blocked: 2, flagged: 1, consistency_failure_rate: 0.25, flagged_rate: 0.25, insights_total: 3, insights_includable: 2, releasable: true },
};

describe("selectInsights（洞察级纳入判定）", () => {
  const sel = selectInsights(batchOf(), validation);
  it("剔除 blocked 引用、排除全 blocked 洞察、标记 flagged", () => {
    expect(sel.map((x) => x.insight.id)).toEqual(["i1", "i2"]); // i3 全 blocked 被排除
    expect(sel.find((x) => x.insight.id === "i1")!.citationIndices).toEqual([0]); // index1 blocked 被剔
    expect(sel.find((x) => x.insight.id === "i1")!.flagged).toBe(false);
    expect(sel.find((x) => x.insight.id === "i2")!.flagged).toBe(true); // uncertain → 待核实
  });

  it("无 check 的引用按「未通过」剔除（闸门白名单，防未校验引用伪装已核实）", () => {
    const batch2: AnalysisBatch = {
      ...batchOf(),
      insights: [
        {
          id: "i9", topic_id: "t1", type: "aggregation", event_id: null, statement: "no check", importance: 3,
          importance_basis: "x",
          citations: [{ content_item_id: "ciX", quote: "q", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
          source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
        },
      ],
    };
    const noChecks: ValidationResult = {
      checks: [],
      report: { total: 0, pass: 0, blocked: 0, flagged: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 0, insights_includable: 0, releasable: true },
    };
    expect(selectInsights(batch2, noChecks)).toEqual([]); // 无 check → 整条不纳入
  });
});

describe("buildReport 派生", () => {
  const lookup = new Map<string, Pick<ContentItem, "source_id" | "tags">>([
    ["ci1", { source_id: "s_a", tags: ["t-x"] }],
    ["ci3", { source_id: "s_b", tags: ["t-y", "t-x"] }],
  ]);
  const { report, index } = buildReport({
    topic, batch: batchOf(), validation, type: "brief", contentLookup: lookup, now: "2026-05-07T08:00:00Z",
  });

  it("report 字段：insight_ids / citation_count / event_ids / cost", () => {
    expect(report.insight_ids).toEqual(["i1", "i2"]);
    expect(report.citation_count).toBe(2); // i1 留 1 + i2 留 1
    expect(report.event_ids).toEqual(["e1"]);
    expect(report.status).toBe("done");
    expect(report.cost).toEqual({ tokens: 0, amount: 0 });
  });

  it("index 派生：source_ids / tags / importance / date / entity_names", () => {
    expect(index.source_ids.sort()).toEqual(["s_a", "s_b"]); // ci2(blocked) 不计入
    expect(index.tags.sort()).toEqual(["t-x", "t-y"]);
    expect(index.importance).toBe(5); // max(4,5)
    expect(index.date).toBe("2026-05-07");
    expect(index.entity_names).toEqual([]);
    expect(index.title).toContain("Code Agent");
  });

  it("正文含纳入洞察 + 待核实标记，不含被排除洞察", () => {
    expect(report.body_md).toContain("S1");
    expect(report.body_md).toContain("〔待核实〕"); // i2 flagged
    expect(report.body_md).not.toContain("S3 all blocked");
    expect(report.body_html).toContain("<section>");
    expect(report.body_html).toContain("待核实");
  });

  it("brief 维持扁平：无分节、无详版来源行", () => {
    expect(report.body_md).not.toContain("重点关注");
    expect(report.body_md).not.toContain("- 来源：");
    expect(report.body_html).not.toContain("<h3>");
  });
});

describe("buildReport · deep_dive（最小确定性深挖）", () => {
  const { report } = buildReport({
    topic, batch: batchOf(), validation, type: "deep_dive",
    contentLookup: new Map(), now: "2026-05-07T08:00:00Z",
  });
  it("标题用深度报告标签", () => {
    expect(report.title).toContain("深度报告");
  });
  it("按重要性分节 + 节内三级标题", () => {
    expect(report.body_md).toContain("## 重点关注"); // i1/i2 均 importance≥4
    expect(report.body_md).toContain("### "); // 节内洞察用三级标题
    expect(report.body_html).toContain("<h3>");
  });
  it("详版多展示来源（来源数 / 多源）", () => {
    expect(report.body_md).toContain("- 来源：");
  });
  it("仍只纳入通过/待核实洞察（与 brief 同闸门）", () => {
    expect(report.insight_ids).toEqual(["i1", "i2"]);
    expect(report.body_md).not.toContain("S3 all blocked");
  });
});

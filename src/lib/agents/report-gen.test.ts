import { describe, expect, it } from "vitest";
import type { AnalysisBatch, ContentItem, Topic, ValidationResult } from "../types.js";
import { buildReport, selectInsights } from "./report-gen.js";
import { flagLabel } from "../utils/citation-verdict.js";

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
        entities: [{ name: "OpenAI", type: "organization" }, { name: "Codex", type: "product" }],
        tags: ["code-agent", "benchmark"],
      },
      {
        id: "i2", topic_id: "t1", type: "trend", event_id: null, statement: "S2", importance: 5,
        importance_basis: "y",
        citations: [{ content_item_id: "ci3", quote: "q3", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
        source_count: 1, multi_source: false, time_window: win, confidence: "high", language: "zh",
        entities: [{ name: "OpenAI", type: "organization" }, { name: "Anthropic", type: "organization" }],
        tags: ["benchmark", "趋势"],
      },
      {
        id: "i3", topic_id: "t1", type: "aggregation", event_id: null, statement: "S3 all blocked", importance: 3,
        importance_basis: "z",
        citations: [{ content_item_id: "ci4", quote: "q4", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
        source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
        entities: [{ name: "排除不应出现", type: "project" }],
        tags: ["排除标签不应出现"],
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
  report: { total: 4, pass: 1, blocked: 2, flagged: 1, errored: 0, consistency_failure_rate: 0.25, flagged_rate: 0.25, insights_total: 3, insights_includable: 2, releasable: true },
};

describe("selectInsights（洞察级纳入判定）", () => {
  const sel = selectInsights(batchOf(), validation);
  it("剔除 blocked 引用、排除全 blocked 洞察、标记 flagged", () => {
    expect(sel.map((x) => x.insight.id)).toEqual(["i1", "i2"]); // i3 全 blocked 被排除
    expect(sel.find((x) => x.insight.id === "i1")!.citationIndices).toEqual([0]); // index1 blocked 被剔
    const i1 = sel.find((x) => x.insight.id === "i1")!;
    expect(i1.flaggedUncertain).toBe(false);
    expect(i1.flaggedError).toBe(false);
    const i2 = sel.find((x) => x.insight.id === "i2")!;
    expect(i2.flaggedUncertain).toBe(true); // uncertain → 待核实
    expect(i2.flaggedError).toBe(false);
  });

  it("汇总被屏蔽数 + 屏蔽理由直方图（外露 validator 把关力度）", () => {
    const i1 = sel.find((x) => x.insight.id === "i1")!;
    expect(i1.blockedCount).toBe(1);
    expect(i1.blockedReasonCounts).toEqual({ exaggeration: 1 }); // consistency_reason
    const i2 = sel.find((x) => x.insight.id === "i2")!;
    expect(i2.blockedCount).toBe(0);
    expect(i2.blockedReasonCounts).toEqual({});
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
      report: { total: 0, pass: 0, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 0, insights_includable: 0, releasable: true },
    };
    expect(selectInsights(batch2, noChecks)).toEqual([]); // 无 check → 整条不纳入
  });
});

describe("buildReport 派生", () => {
  const lookup = new Map([
    ["ci1", { source_id: "s_a", source_name: "Source A", tags: ["t-x"], url: "https://a.example/q1", published_at: "2026-05-07T08:00:00.000Z" }],
    ["ci3", { source_id: "s_b", source_name: "Source B", tags: ["t-y", "t-x"], url: "https://b.example/q3", published_at: null }],
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
    // tags = analyzer 洞察标签（i1: code-agent/benchmark · i2: benchmark/趋势，去重）∪ content_item 标签（t-x/t-y）
    expect(index.tags.slice().sort()).toEqual(["benchmark", "code-agent", "t-x", "t-y", "趋势"].sort());
    expect(index.tags).not.toContain("排除标签不应出现"); // i3 全 blocked，其标签不泄漏
    expect(index.importance).toBe(5); // max(4,5)
    expect(index.date).toBe("2026-05-07");
    // 跨纳入洞察聚合实体名 + 去重（OpenAI 在 i1/i2 各出现一次 → 一次）；i3 全 blocked 被排除，其实体不泄漏
    expect(index.entity_names).toEqual(["OpenAI", "Codex", "Anthropic"]);
    expect(index.entity_names).not.toContain("排除不应出现");
    expect(index.title).toContain("Code Agent");
  });

  it("正文含纳入洞察 + 待核实标记，不含被排除洞察", () => {
    expect(report.body_md).toContain("S1");
    expect(report.body_md).toContain("〔待核实〕"); // i2 flagged
    expect(report.body_md).not.toContain("S3 all blocked");
    expect(report.body_html).toContain("<section>");
    expect(report.body_html).toContain("待核实");
  });

  it("HTML 引用接 lookup：quote 可点跳源 + 人可读源名 + 日期，不再裸露 ci_xxx", () => {
    // ci1 有 url + published_at → <a href> 包 quote、源名 Source A、日期 2026-05-07
    expect(report.body_html).toContain('<a href="https://a.example/q1" target="_blank" rel="noopener noreferrer"><q>「q1」</q></a>');
    expect(report.body_html).toContain('<span class="src">Source A</span>');
    expect(report.body_html).toContain("· 2026-05-07");
    // ci3 有 url 但 published_at=null → 仍包 <a>、但无日期段，显示源名 Source B
    expect(report.body_html).toContain('<a href="https://b.example/q3" target="_blank" rel="noopener noreferrer"><q>「q3」</q></a> — <span class="src">Source B</span>');
    // 旧的裸 content_item_id 形式已消失
    expect(report.body_html).not.toContain("<code>ci");
  });

  it("HTML 引用 URL scheme 守卫：仅 http(s) 可点，javascript: 退化为纯 quote", () => {
    const evilLookup = new Map([
      ["ci1", { source_id: "s_a", source_name: "Src A", tags: [], url: "javascript:alert(1)", published_at: null }],
    ]);
    const { report: r } = buildReport({
      topic, batch: batchOf(), validation, type: "brief", contentLookup: evilLookup, now: "2026-05-07T08:00:00Z",
    });
    expect(r.body_html).not.toContain("javascript:"); // 危险 scheme 不进 href
    expect(r.body_html).not.toContain("<a href"); // ci1 退化为纯 <q>，无链接
    expect(r.body_html).toContain('<span class="src">Src A</span>'); // 源名仍展示
  });

  it("HTML href 属性转义：含双引号的 url 不破坏 href 属性", () => {
    const evilLookup = new Map([
      ["ci1", { source_id: "s_a", source_name: "Src A", tags: [], url: 'https://a.example/"onmouseover=x', published_at: null }],
    ]);
    const { report: r } = buildReport({
      topic, batch: batchOf(), validation, type: "brief", contentLookup: evilLookup, now: "2026-05-07T08:00:00Z",
    });
    // url 内 " 转义为 &quot; 进 href，不提前闭合属性
    expect(r.body_html).toContain('href="https://a.example/&quot;onmouseover=x"');
    expect(r.body_html).not.toContain('/"onmouseover'); // 不出现未转义的裸引号
  });

  it("brief 维持扁平：无分节、无详版来源行", () => {
    expect(report.body_md).not.toContain("重点关注");
    expect(report.body_md).not.toContain("- 来源：");
    expect(report.body_html).not.toContain("<h3>");
  });

  it("C-2 全局连续引用编号：statement 含 [N] inline + 列表项 [N] 前缀", () => {
    // i1 留 1 引用 → [1]；i2 留 1 引用 → [2]（跨洞察累计）
    expect(report.body_md).toMatch(/## 1\. S1 \[1\]/);
    expect(report.body_md).toMatch(/## 2\. S2 \[2\]/);
    // 列表项前缀：每条 quote 行以 [N] 开头；含 url 时 quote 被包成 markdown 链接、
    // 源名跟在 — 后；published_at 是 ISO 时输出 YYYY-MM-DD 日期，null 时无日期段
    expect(report.body_md).toMatch(/- \[1\] \[「q1」]\(https:\/\/a\.example\/q1\) — Source A · 2026-05-07/);
    expect(report.body_md).toMatch(/- \[2\] \[「q3」]\(https:\/\/b\.example\/q3\) — Source B$/m);
  });

  it("P1 不复报：is_followup=true 的洞察 statement 后渲染 〔更新〕（md）+ <span class=\"followup\">（html）", () => {
    const fb = batchOf();
    fb.insights[0].is_followup = true; // i1 标记为续报
    fb.insights[1].is_followup = false; // i2 仍是新事件
    const { report } = buildReport({
      topic, batch: fb, validation, type: "brief", contentLookup: lookup, now: "2026-05-07T08:00:00Z",
    });
    expect(report.body_md).toMatch(/## 1\. S1 \[1\] 〔更新〕/); // i1 有 〔更新〕
    expect(report.body_md).not.toMatch(/## 2\. S2 \[2\] 〔更新〕/); // i2 无 〔更新〕
    expect(report.body_html).toContain('<span class="followup">更新</span>');
  });

  it("外露 validator 屏蔽信号：md/html 各加 1 行（仅 blockedCount>0 时展示）", () => {
    // i1 有 1 条 blocked exaggeration → 应渲染
    expect(report.body_md).toContain("- 校验阻断：1 条（理由：exaggeration ×1）");
    expect(report.body_html).toContain('class="meta blocked"');
    expect(report.body_html).toContain("校验阻断：1 条（理由：exaggeration ×1）");
    // i2 无 blocked → 不应出现"校验阻断"标签（除非来自 i1，匹配次数=1）
    expect((report.body_md.match(/校验阻断/g) ?? []).length).toBe(1);
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

  // #19：deep_dive 结构化六段（TL;DR / 概览 / 趋势 / 时间线 / 详版关键发现+其他）
  it("TL;DR 段上浮、按重要性降序（i2 imp5 在 i1 imp4 前）", () => {
    const md = report.body_md;
    expect(md).toContain("## TL;DR");
    const tldrIdx = md.indexOf("## TL;DR");
    const overviewIdx = md.indexOf("## 概览");
    // TL;DR 在概览之前；段内 S2 先于 S1（重要性 5 > 4）
    expect(tldrIdx).toBeGreaterThan(-1);
    expect(tldrIdx).toBeLessThan(overviewIdx);
    const tldrBlock = md.slice(tldrIdx, overviewIdx);
    expect(tldrBlock.indexOf("S2")).toBeLessThan(tldrBlock.indexOf("S1"));
  });
  it("概览对比表：GFM 表格 + 类型/重要性/来源/置信度列；行号对应详版序", () => {
    const md = report.body_md;
    expect(md).toContain("| # | 洞察 | 类型 | 重要性 | 来源 | 置信度 |");
    expect(md).toMatch(/\| 1 \| S1 \| 聚合 \| 4\/5 \| 2·多源 \| — \|/);
    expect(md).toMatch(/\| 2 \| S2 \| 趋势 \| 5\/5 \| 1·单源 \| 高 \|/);
    // HTML 自包含版同样含 <table>
    expect(report.body_html).toContain("<table>");
    expect(report.body_html).toContain("<th>置信度</th>");
  });
  it("趋势分析段：仅列 trend 型洞察 + 置信度", () => {
    const md = report.body_md;
    const seg = md.slice(md.indexOf("## 趋势分析"), md.indexOf("## 时间线"));
    expect(seg).toContain("S2（置信度 高）");
    expect(seg).not.toContain("S1"); // S1 是 aggregation，不进趋势段
  });
  it("时间线段：按日期倒序，无可解析发布日时回退洞察窗口末", () => {
    const md = report.body_md;
    const seg = md.slice(md.indexOf("## 时间线"), md.indexOf("## 重点关注"));
    // lookup 为空 → 回退 time_window.end = 2026-05-07
    expect(seg).toContain("`2026-05-07` — S1");
    expect(seg).toContain("`2026-05-07` — S2");
  });
  it("详版仍在最后，含关键发现分节 + 行内引用", () => {
    const md = report.body_md;
    expect(md.indexOf("## 重点关注")).toBeGreaterThan(md.indexOf("## 时间线"));
    expect(md).toContain("### 1. S1");
  });
  it("无趋势型洞察时趋势段诚实标注", () => {
    const onlyAgg = batchOf();
    onlyAgg.insights[1].type = "aggregation"; // i2 改为聚合
    const { report: r } = buildReport({
      topic, batch: onlyAgg, validation, type: "deep_dive", contentLookup: new Map(), now: "2026-05-07T08:00:00Z",
    });
    const seg = r.body_md.slice(r.body_md.indexOf("## 趋势分析"), r.body_md.indexOf("## 时间线"));
    expect(seg).toContain("无显著趋势信号");
  });
});

describe("flagLabel + 校验失败/待核实 区分（C）", () => {
  it("genuine uncertain 优先于校验失败；都无返空串", () => {
    expect(flagLabel({ flaggedUncertain: true, flaggedError: false })).toBe("待核实");
    expect(flagLabel({ flaggedUncertain: false, flaggedError: true })).toBe("校验失败·待重试");
    expect(flagLabel({ flaggedUncertain: true, flaggedError: true })).toBe("待核实");
    expect(flagLabel({ flaggedUncertain: false, flaggedError: false })).toBe("");
  });

  // 构造单洞察 batch + 给定 checks 的便捷器（每条 citation 一个 ci_index）
  function selOf(checks: ValidationResult["checks"], nCitations: number) {
    const batch: AnalysisBatch = {
      id: "be", topic_id: "t1", time_window: win, status: "done", no_significant_event: false,
      insights: [{
        id: "ie", topic_id: "t1", type: "aggregation", event_id: null, statement: "Serr", importance: 4,
        importance_basis: "x",
        citations: Array.from({ length: nCitations }, (_, i) => ({
          content_item_id: `ci${i}`, quote: `q${i}`, locator: { paragraph_index: 0, char_start: 0, char_end: 1 },
        })),
        source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
      }],
    };
    const v: ValidationResult = {
      checks,
      report: { total: 0, pass: 0, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 0, insights_includable: 0, releasable: true },
    };
    return selectInsights(batch, v);
  }
  const chk = (ci: number, verdict: "pass" | "flagged", consistency: "support" | "uncertain" | "not_evaluated") =>
    ({ insight_id: "ie", citation_index: ci, reachability: "pass" as const, reachability_reason: "ok" as const, consistency, consistency_reason: consistency === "support" ? "ok" as const : consistency, verdict });

  it("#2：唯一引用校验失败（pass+not_evaluated）→ 整条不纳入（零成功校验不出街）", () => {
    expect(selOf([chk(0, "flagged", "not_evaluated")], 1)).toHaveLength(0);
  });

  it("#2：pass + 校验失败 → 仍纳入（靠 pass），标 flaggedError、含错误引用展示", () => {
    const sel = selOf([chk(0, "pass", "support"), chk(1, "flagged", "not_evaluated")], 2);
    expect(sel).toHaveLength(1);
    expect(sel[0].citationIndices).toEqual([0, 1]); // 错误引用仍展示（带标签）
    expect(sel[0].flaggedError).toBe(true);
    expect(sel[0].flaggedUncertain).toBe(false);
    expect(flagLabel(sel[0])).toBe("校验失败·待重试");
  });

  it("#4：genuine uncertain + 校验失败并存 → 两标志均 true，标签取「待核实」（uncertain 优先）", () => {
    const sel = selOf([chk(0, "flagged", "uncertain"), chk(1, "flagged", "not_evaluated")], 2);
    expect(sel).toHaveLength(1);
    expect(sel[0].flaggedUncertain).toBe(true);
    expect(sel[0].flaggedError).toBe(true);
    expect(flagLabel(sel[0])).toBe("待核实");
  });
});

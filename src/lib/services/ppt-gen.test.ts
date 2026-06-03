import { describe, expect, it } from "vitest";
import type { Insight, Report, Topic } from "../types.js";
import { briefSummary, buildPptx, type IncludedInsightLite, type PptGenInput } from "./ppt-gen.js";

const topic: Topic = {
  id: "t1", name: "测试主题", keywords: ["k"], industry: "ai-swe", language: "zh",
  brief_schedule: "daily", enabled: true,
};

const win = { start: "2026-06-01", end: "2026-06-07" };

function ins(id: string, statement: string, importance: number, ci = "ci_a"): Insight {
  return {
    id, topic_id: "t1", type: "aggregation", event_id: null, statement, importance,
    importance_basis: "x",
    citations: [{ content_item_id: ci, quote: "示例引用 quote", locator: { paragraph_index: 0, char_start: 0, char_end: 1 } }],
    source_count: 1, multi_source: false, time_window: win, confidence: null, language: "zh",
  };
}

function makeInput(insights: IncludedInsightLite[]): PptGenInput {
  const report: Report = {
    id: "rep_test1", type: "brief", topic_id: "t1", status: "done",
    generated_at: "2026-06-07T08:00:00Z", title: "测试主题 · 今日 Brief · 2026-06-07",
    body_md: "", body_html: "",
    insight_ids: insights.map((x) => x.insight.id),
    event_ids: [], prev_report_id: null, citation_count: insights.length, cost: { tokens: 0, amount: 0 },
  };
  return {
    report, insights, topic,
    sourceNameByCi: new Map([["ci_a", "Latent Space"], ["ci_b", "Pragmatic Engineer"]]),
  };
}

function lite(i: Insight, indices: number[] = [0], flagged = false): IncludedInsightLite {
  return { insight: i, citationIndices: indices, flagged };
}

const PPTX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"（ZIP）

describe("buildPptx（A 阶段·确定性骨架）", () => {
  it("空报告 → 2 页（标题 + 空提示），buffer 是有效 ZIP", async () => {
    const { buffer, pageCount } = await buildPptx(makeInput([]));
    expect(pageCount).toBe(2);
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC); // .pptx 是 ZIP
    expect(buffer.length).toBeGreaterThan(1000); // 至少有内容
  });

  it("纯重点（4 条 importance≥4）→ 1 标题 + 4 重点 + 1 源 = 6 页", async () => {
    const insights = [
      lite(ins("i1", "重点洞察 A", 5)),
      lite(ins("i2", "重点洞察 B", 4), [0], true), // flagged
      lite(ins("i3", "重点洞察 C", 4)),
      lite(ins("i4", "重点洞察 D", 5)),
    ];
    const { buffer, pageCount } = await buildPptx(makeInput(insights));
    expect(pageCount).toBe(1 + 4 + 1);
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
  });

  it("纯非重点（10 条 importance<4）→ 1 标题 + ceil(10/4)=3 聚合页 + 1 源 = 5 页", async () => {
    const insights = Array.from({ length: 10 }, (_, i) => lite(ins(`x${i}`, `次要洞察 ${i}`, 3)));
    const { pageCount } = await buildPptx(makeInput(insights));
    expect(pageCount).toBe(1 + 3 + 1);
  });

  it("混合 (3 重点 + 7 非重点) → 1 + 3 + ceil(7/4)=2 + 1 = 7 页", async () => {
    const insights = [
      ...Array.from({ length: 3 }, (_, i) => lite(ins(`k${i}`, `重点洞察 ${i}`, 4))),
      ...Array.from({ length: 7 }, (_, i) => lite(ins(`r${i}`, `次要洞察 ${i}`, 3))),
    ];
    const { pageCount } = await buildPptx(makeInput(insights));
    expect(pageCount).toBe(1 + 3 + 2 + 1);
  });

  it("flagged 洞察不破坏渲染", async () => {
    const insights = [lite(ins("i1", "待核实的重点", 5), [0], true)];
    const { buffer, pageCount } = await buildPptx(makeInput(insights));
    expect(pageCount).toBe(1 + 1 + 1); // title + key + sources
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
  });

  it("洞察 statement 超长不破坏渲染（标题与正文都被截断或换行处理）", async () => {
    const longStatement = "这是一条非常长的洞察，".repeat(50);
    const insights = [lite(ins("long", longStatement, 5))];
    const { buffer } = await buildPptx(makeInput(insights));
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
    expect(buffer.length).toBeGreaterThan(2000);
  });
});

describe("buildPptx · polish 接入（B 阶段）", () => {
  it("polish.executive 存在 → 标题页后插 Executive Summary 页（+1 页）", async () => {
    const insights = [
      lite(ins("i1", "重点 A", 5)),
      lite(ins("i2", "重点 B", 4)),
    ];
    const input = makeInput(insights);
    input.polish = {
      perInsight: new Map(),
      executive: { takeaways: ["要点 1", "要点 2", "要点 3"] },
    };
    const { pageCount } = await buildPptx(input);
    expect(pageCount).toBe(1 + 1 + 2 + 1); // title + executive + 2 key + sources
  });

  it("polish.executive=null → 不插 Executive 页（与 A 一致）", async () => {
    const insights = [lite(ins("i1", "重点 A", 5))];
    const input = makeInput(insights);
    input.polish = { perInsight: new Map(), executive: null };
    const { pageCount } = await buildPptx(input);
    expect(pageCount).toBe(1 + 1 + 1); // title + key + sources
  });

  it("polish.perInsight 含某条 → 该条 §1/§3 用 polish 数据；其他条 fallback A", async () => {
    const insights = [
      lite(ins("i1", "完整 statement 1。后续无关。", 5)),
      lite(ins("i2", "完整 statement 2。", 4)),
    ];
    const input = makeInput(insights);
    input.polish = {
      perInsight: new Map([["i1", { brief_summary: "LLM 凝练 1", implications: ["启示 a", "启示 b"] }]]),
      executive: null,
    };
    const { buffer } = await buildPptx(input);
    // 简单结构性断言：buffer 非空、ZIP 头
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
    expect(buffer.length).toBeGreaterThan(5000);
  });
});

describe("briefSummary（§1 简要总结取首句策略）", () => {
  it("有句末标点 → 取首句（去尾空白）", () => {
    expect(briefSummary("DHH 已六个月不手写代码。后半段不重要。")).toBe(
      "DHH 已六个月不手写代码。",
    );
  });

  it("英文句号也算句末", () => {
    expect(briefSummary("Reachability is 100% by construction. Tests prove it.")).toBe(
      "Reachability is 100% by construction.",
    );
  });

  it("无句末标点 → 截到 ~50 字", () => {
    const s = "一段不带句号的长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长";
    const result = briefSummary(s);
    expect(result.length).toBeLessThanOrEqual(55);
    expect(result).toContain("…");
  });

  it("过短首句（<6 字）→ 跳过句号取整段截断", () => {
    // "是。" 首句过短，regex 不匹配；走 truncate 分支；整段 < 55 字 → 原样返
    expect(briefSummary("是。后续不重要。")).toBe("是。后续不重要。");
  });
});

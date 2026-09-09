import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { Insight, Report, Topic } from "../types.js";
import { buildPptx, type IncludedInsightLite, type PptGenInput } from "./ppt-gen.js";

const topic: Topic = {
  id: "t1", name: "测试主题", keywords: ["k"], language: "zh",
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
    citationSourceByCi: new Map([
      ["ci_a", { sourceName: "Latent Space", url: "https://latent.example/a" }],
      ["ci_b", { sourceName: "Pragmatic Engineer", url: "https://pragmatic.example/b" }],
    ]),
  };
}

function lite(
  i: Insight, indices: number[] = [0], flaggedUncertain = false, flaggedError = false,
): IncludedInsightLite {
  return { insight: i, citationIndices: indices, flaggedUncertain, flaggedError };
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

  it("洞察 statement 超长不破坏渲染（完整原文由版面 shrink 适配）", async () => {
    const longStatement = "这是一条非常长的洞察，".repeat(50);
    const insights = [lite(ins("long", longStatement, 5))];
    const { buffer } = await buildPptx(makeInput(insights));
    expect(buffer.subarray(0, 4)).toEqual(PPTX_MAGIC);
    expect(buffer.length).toBeGreaterThan(2000);
  });

  it("v6 重点页将完整绑定 quote 写入 PPT XML 一次，不插入润色或截断副本", async () => {
    const quote = "A source-verified long sentence must remain complete in the generated PowerPoint without any abbreviated duplicate.";
    const bound = ins("bound", quote, 5);
    bound.citations[0]!.quote = quote;
    const { buffer } = await buildPptx(makeInput([lite(bound)]));
    const zip = await JSZip.loadAsync(buffer);
    const slideXml = (await Promise.all(
      Object.entries(zip.files)
        .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map(([, file]) => file.async("string")),
    )).join("\n");
    expect(slideXml.split(quote).length - 1).toBe(1);
    expect(slideXml).not.toContain(`${quote.slice(0, 48)}…`);
    expect(slideXml).not.toContain("LLM 润色");
  });

  it("重点与其他动态均把唯一绑定原文链接回各自 content item", async () => {
    const keyQuote = "A key source quote.";
    const otherQuote = "A lower-priority source quote.";
    const key = ins("key", keyQuote, 4, "ci_a");
    key.citations[0]!.quote = keyQuote;
    const other = ins("other", otherQuote, 3, "ci_b");
    other.citations[0]!.quote = otherQuote;
    const { buffer } = await buildPptx(makeInput([lite(key), lite(other)]));
    const zip = await JSZip.loadAsync(buffer);
    const slideXml = (await Promise.all(Object.entries(zip.files)
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map(([, file]) => file.async("string")))).join("\n");
    const relsXml = (await Promise.all(Object.entries(zip.files)
      .filter(([name]) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
      .map(([, file]) => file.async("string")))).join("\n");
    expect(slideXml.split(keyQuote).length - 1).toBe(1);
    expect(slideXml.split(otherQuote).length - 1).toBe(1);
    expect(relsXml).toContain('Target="https://latent.example/a"');
    expect(relsXml).toContain('Target="https://pragmatic.example/b"');
  });

  it("缺失或非 http(s) binding URL 时 fail-closed，不写入原文", async () => {
    const quote = "A quote that must not be published without a safe source URL.";
    const bound = ins("unsafe", quote, 5);
    bound.citations[0]!.quote = quote;

    for (const citationSourceByCi of [
      new Map<string, { sourceName: string; url: string }>(),
      new Map([["ci_a", { sourceName: "Unsafe", url: "javascript:alert(1)" }]]),
    ]) {
      const input = makeInput([lite(bound)]);
      input.citationSourceByCi = citationSourceByCi;
      const { buffer, pageCount } = await buildPptx(input);
      const zip = await JSZip.loadAsync(buffer);
      const slideXml = (await Promise.all(Object.entries(zip.files)
        .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map(([, file]) => file.async("string")))).join("\n");

      expect(pageCount).toBe(2); // title + fail-closed empty state
      expect(slideXml).not.toContain(quote);
    }
  });
});

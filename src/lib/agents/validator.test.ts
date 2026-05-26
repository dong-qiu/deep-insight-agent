/**
 * validator 纯函数单测 —— 不需要 API key，CI 可跑（npm test）。
 * 覆盖可达性校验与 verdict 处置矩阵（确定性逻辑）。
 */
import { describe, expect, it } from "vitest";
import { checkReachability, insightInclusion, summarize, verdictFor } from "./validator.js";
import type { CitationCheck, ContentItem } from "../types.js";

function item(id: string, body: string): ContentItem {
  return {
    id,
    source_id: "src",
    url: "https://example.com",
    title: "t",
    author: null,
    published_at: null,
    fetched_at: "2026-05-25T00:00:00Z",
    language: "en",
    topic_ids: [],
    tags: [],
    body,
    raw_ref: `raw://${id}`,
    content_hash: `h_${id}`,
    fetch_status: "ok",
  };
}

const items = new Map<string, ContentItem>([
  ["ci_1", item("ci_1", "The test-first loop reduced regressions by 38%.")],
]);

describe("checkReachability", () => {
  it("逐字命中 → pass", () => {
    expect(
      checkReachability({ content_item_id: "ci_1", quote: "reduced regressions by 38%" }, items),
    ).toEqual({ reachability: "pass", reason: "ok" });
  });

  it("空白归一后命中 → pass", () => {
    expect(
      checkReachability(
        { content_item_id: "ci_1", quote: "reduced   regressions\nby 38%" },
        items,
      ).reachability,
    ).toBe("pass");
  });

  it("片段不在原文 → fail / quote_not_in_source", () => {
    expect(
      checkReachability({ content_item_id: "ci_1", quote: "eliminated all regressions" }, items),
    ).toEqual({ reachability: "fail", reason: "quote_not_in_source" });
  });

  it("来源不存在 → fail / source_not_found", () => {
    expect(
      checkReachability({ content_item_id: "ci_missing", quote: "x" }, items),
    ).toEqual({ reachability: "fail", reason: "source_not_found" });
  });
});

describe("verdictFor（处置矩阵）", () => {
  it("可达性 fail → blocked", () => {
    expect(verdictFor("fail", "not_evaluated")).toBe("blocked");
  });
  it("pass + support → pass", () => {
    expect(verdictFor("pass", "support")).toBe("pass");
  });
  it("pass + not_support → blocked", () => {
    expect(verdictFor("pass", "not_support")).toBe("blocked");
  });
  it("pass + uncertain → flagged", () => {
    expect(verdictFor("pass", "uncertain")).toBe("flagged");
  });
});

/** 构造一条类型合法的 CitationCheck；summarize/insightInclusion 只关心 insight_id + verdict。 */
function check(insight_id: string, verdict: CitationCheck["verdict"]): CitationCheck {
  const base = { insight_id, citation_index: 0 };
  if (verdict === "pass") {
    return { ...base, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict };
  }
  if (verdict === "flagged") {
    return { ...base, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict };
  }
  return { ...base, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict };
}

describe("summarize（护栏与 releasable 对齐洞察级纳入判定）", () => {
  it("空批次 → releasable 诚实放行，洞察计数为 0", () => {
    const r = summarize([]);
    expect(r).toMatchObject({ total: 0, insights_total: 0, insights_includable: 0, releasable: true });
  });

  it("单洞察全 blocked → 不可纳入 → releasable=false", () => {
    const r = summarize([check("i1", "blocked"), check("i1", "blocked")]);
    expect(r.insights_total).toBe(1);
    expect(r.insights_includable).toBe(0);
    expect(r.releasable).toBe(false); // 引用级 pass=0；洞察级也 0 —— 两口径一致
  });

  it("混合：i1 含 1 pass（可纳入）、i2 全 blocked（排除）→ releasable=true 且纳入数=1", () => {
    const r = summarize([
      check("i1", "pass"),
      check("i1", "blocked"),
      check("i2", "blocked"),
    ]);
    expect(r.insights_total).toBe(2);
    expect(r.insights_includable).toBe(1); // 与 report-gen.selectInsights 纳入数一致
    expect(r.releasable).toBe(true);
  });

  it("flagged（待核实）也算可纳入", () => {
    const r = summarize([check("i1", "flagged")]);
    expect(r.insights_includable).toBe(1);
    expect(r.releasable).toBe(true);
  });

  it("insightInclusion 按 insight_id 分组、与 verdict 白名单一致", () => {
    expect(insightInclusion([check("a", "pass"), check("b", "blocked"), check("b", "flagged")])).toEqual({
      insights_total: 2,
      insights_includable: 2, // a 有 pass；b 有 flagged
    });
  });
});

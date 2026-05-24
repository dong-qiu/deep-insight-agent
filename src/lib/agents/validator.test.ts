/**
 * validator 纯函数单测 —— 不需要 API key，CI 可跑（npm test）。
 * 覆盖可达性校验与 verdict 处置矩阵（确定性逻辑）。
 */
import { describe, expect, it } from "vitest";
import { checkReachability, verdictFor } from "./validator.js";
import type { ContentItem } from "../types.js";

function item(id: string, body: string): ContentItem {
  return {
    id,
    source_id: "src",
    url: "https://example.com",
    title: "t",
    published_at: null,
    language: "en",
    topic_ids: [],
    body,
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

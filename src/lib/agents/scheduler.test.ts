/** rankAndDiversify 纯函数单测（F2 选片：相关优先 + 来源多样）。无 key、无 db。 */
import { describe, expect, it } from "vitest";
import type { ContentItem } from "../types.js";
import { rankAndDiversify, reportPlan } from "./scheduler.js";

function ci(id: string, source_id: string, text: string): ContentItem {
  return {
    id, source_id, url: `https://x/${id}`, title: text, author: null, published_at: null,
    fetched_at: "2026-05-27T00:00:00Z", language: "en", topic_ids: ["t"], tags: [],
    body: text, body_kind: "article", raw_ref: "", content_hash: `h_${id}`, fetch_status: "ok",
  };
}
const KW = ["coding agent", "swe-bench"];

describe("rankAndDiversify", () => {
  it("候选 ≤ limit 时原样返回（无需选片）", () => {
    const items = [ci("a", "s1", "x"), ci("b", "s2", "y")];
    expect(rankAndDiversify(items, KW, 5)).toEqual(items);
  });

  it("相关项（命中关键词）优先于无关营销帖", () => {
    const items = [
      ci("noise1", "s1", "marketing post about dalle"),
      ci("noise2", "s1", "introducing outpainting"),
      ci("rel", "s2", "a study on coding agent and SWE-bench"),
      ci("noise3", "s1", "requests for research"),
    ];
    expect(rankAndDiversify(items, KW, 2)[0].id).toBe("rel"); // 命中 2 关键词 → 第一
  });

  it("来源多样：源足够时高产源不超过每源上限", () => {
    // s1 ×8（全相关）+ s2、s3 各 1（相关）；limit=4 → 每源上限 max(2,ceil(4/3))=2
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ci(`p${i}`, "s1", "coding agent")),
      ci("q", "s2", "coding agent"),
      ci("r", "s3", "swe-bench"),
    ];
    const out = rankAndDiversify(items, KW, 4);
    expect(out.length).toBe(4);
    expect(out.filter((x) => x.source_id === "s1").length).toBeLessThanOrEqual(2);
    expect(new Set(out.map((x) => x.source_id)).size).toBeGreaterThanOrEqual(3); // 多源覆盖
  });

  it("全无关键词命中 → 回退候选原序（recency）", () => {
    const items = [ci("a", "s1", "foo"), ci("b", "s2", "bar"), ci("c", "s3", "baz"), ci("d", "s4", "qux")];
    expect(rankAndDiversify(items, KW, 2).map((x) => x.id)).toEqual(["a", "b"]); // 原序前 2
  });

  it("token 化：英文研究摘要靠词命中（非整短语）也算相关并排上", () => {
    // 关键词整短语不会原样出现，但 token software/engineering/autonomous 会命中摘要
    const kws = ["autonomous software engineering", "代码生成"];
    const items = [
      ci("mkt1", "s1", "introducing our new image model"),
      ci("mkt2", "s1", "a fun podcast episode"),
      ci("paper", "s_arxiv", "We study software engineering with autonomous agents on SWE tasks"),
      ci("mkt3", "s1", "more marketing copy"),
    ];
    expect(rankAndDiversify(items, kws, 2)[0].id).toBe("paper");
  });
});

describe("reportPlan（冷启动 → 首版综述）", () => {
  const warm = { type: "brief" as const, windowHours: 168, items: 15 };
  const cold = { windowHours: 720, items: 25 };

  it("topic 无历史报告 → initial_digest + 宽窗 + 多条", () => {
    expect(reportPlan(true, warm, cold)).toEqual({ type: "initial_digest", windowHours: 720, items: 25 });
  });

  it("topic 已有报告 → 沿用常规 reportType 与窗口/条数", () => {
    expect(reportPlan(false, warm, cold)).toEqual({ type: "brief", windowHours: 168, items: 15 });
    expect(reportPlan(false, { type: "deep_dive", windowHours: 168, items: 20 }, cold))
      .toEqual({ type: "deep_dive", windowHours: 168, items: 20 });
  });
});

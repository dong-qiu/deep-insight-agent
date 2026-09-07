import { describe, expect, it } from "vitest";
import { buildLocalEvalCases, missingRequiredSources } from "./build-local-eval-lib.js";
import type { ContentItem, Topic } from "../src/lib/types.js";

const topic: Topic = {
  id: "t_code_agents", name: "Coding agents", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
  archetype: "deep_vertical", facets: ["domain:software-engineering"],
};
const item = (sourceId: string, body = "x".repeat(500)): ContentItem => ({
  id: `item-${sourceId}`, source_id: sourceId, url: `https://example.test/${sourceId}`, title: sourceId,
  author: null, published_at: null, fetched_at: "2026-09-08T00:00:00.000Z", language: "en", topic_ids: [topic.id],
  tags: [], body, body_kind: "article", raw_ref: "", content_hash: sourceId, fetch_status: "ok",
});

describe("buildLocalEvalCases", () => {
  const window = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" };

  it("先保留所有指定源，并在 manifest 中证明其进入输出 case", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [item("ordinary"), item("src_a"), item("src_b"), item("src_c")],
      window,
      { minBody: 400, perSource: 1, maxItems: 4, requiredSourceIds: ["src_a", "src_b", "src_c"] },
    );

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].items.map((entry) => entry.source_id)).toEqual(["src_a", "src_b", "src_c", "ordinary"]);
    expect(missingRequiredSources(result)).toEqual([]);
    expect(result.cohort.src_a).toMatchObject({ eligible: 1, selected: 1, topics: [topic.id] });
  });

  it("指定源正文不达门槛时，不把残缺 cohort 伪装为可评数据", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [item("src_a"), item("src_b"), item("src_c", "too short")],
      window,
      { minBody: 400, perSource: 1, maxItems: 4, requiredSourceIds: ["src_a", "src_b", "src_c"] },
    );

    expect(missingRequiredSources(result)).toEqual(["src_c"]);
  });
});

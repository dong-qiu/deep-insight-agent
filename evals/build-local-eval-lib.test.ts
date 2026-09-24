import { describe, expect, it } from "vitest";
import { buildLocalEvalCases, missingRequiredSources, missingRequiredSourcesByTopic, parseTopicSourceIds } from "./build-local-eval-lib.js";
import type { ContentItem, Topic } from "../src/lib/types.js";

const topic: Topic = {
  id: "t_code_agents", name: "Coding agents", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
  archetype: "deep_vertical", facets: ["domain:software-engineering"],
};
const item = (sourceId: string, body = "x".repeat(500)): ContentItem => ({
  id: `item-${sourceId}`, source_id: sourceId, url: `https://example.test/${sourceId}`, title: sourceId,
  author: null, published_at: null, fetched_at: "2026-09-08T00:00:00.000Z", language: "en", topic_ids: [topic.id],
  tags: [], body, body_kind: "article", raw_ref: `raw://${sourceId}`, content_hash: sourceId, fetch_status: "ok",
});

const secondTopic: Topic = {
  ...topic, id: "t_agent_security", name: "Agent security",
};

describe("buildLocalEvalCases", () => {
  const window = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" };

  it("先保留所有指定源，并在 manifest 中证明其进入输出 case", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [item("ordinary"), item("src_a"), item("src_b"), item("src_c")],
      window,
      { minBody: 400, perSource: 1, maxItems: 4, minimumSources: 2, requiredSourceIds: ["src_a", "src_b", "src_c"] },
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
      { minBody: 400, perSource: 1, maxItems: 4, minimumSources: 2, requiredSourceIds: ["src_a", "src_b", "src_c"] },
    );

    expect(missingRequiredSources(result)).toEqual(["src_c"]);
  });

  it("partial 或缺 raw_ref 的条目不进入本地 A1 输入", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [
        { ...item("src_partial"), fetch_status: "partial" as const },
        { ...item("src_missing_raw"), raw_ref: "" },
        item("src_complete"),
        item("src_other"),
      ],
      window,
      { minBody: 400, perSource: 1, maxItems: 4, minimumSources: 1, requiredSourceIds: ["src_complete"] },
    );
    expect(result.cases[0]?.items.map((entry) => entry.source_id)).toEqual(["src_complete", "src_other"]);
    expect(missingRequiredSources(result)).toEqual([]);
  });

  it("单一 staged source 可用两条同源内容构成隔离发布安全 case", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [item("src_staged"), { ...item("src_staged"), id: "item-src-staged-2", url: "https://example.test/src-staged-2" }],
      window,
      { minBody: 400, perSource: 2, maxItems: 4, minimumSources: 1, requiredSourceIds: ["src_staged"] },
    );

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].items).toHaveLength(2);
    expect(missingRequiredSources(result)).toEqual([]);
  });

  it("跨 topic 不复用同一 content id 或 URL 来虚增受控快照", () => {
    const shared = item("src_a");
    const sameUrlDifferentId = { ...item("src_b"), id: "other-id", url: shared.url };
    const firstOnly = item("src_c");
    const secondOnlyA = { ...item("src_d"), id: "second-a", url: "https://example.test/second-a" };
    const secondOnlyB = { ...item("src_e"), id: "second-b", url: "https://example.test/second-b" };
    const result = buildLocalEvalCases(
      [topic, secondTopic],
      (topicId) => topicId === topic.id
        ? [shared, firstOnly]
        : [shared, sameUrlDifferentId, secondOnlyA, secondOnlyB],
      window,
      { minBody: 400, perSource: 1, maxItems: 4, minimumSources: 2, requiredSourceIds: [] },
    );

    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].items.map((entry) => entry.id)).toEqual(["item-src_a", "item-src_c"]);
    expect(result.cases[1].items.map((entry) => entry.id)).toEqual(["second-a", "second-b"]);
    const allItems = result.cases.flatMap((entry) => entry.items);
    expect(new Set(allItems.map((entry) => entry.id)).size).toBe(allItems.length);
    expect(new Set(allItems.map((entry) => entry.url)).size).toBe(allItems.length);
  });

  it("按主题固定来源对，避免共享路由挤占后续 v2 topic", () => {
    const platform = { ...topic, id: "t_coding_agent_platforms", name: "Coding platforms" };
    const result = buildLocalEvalCases(
      [topic, platform],
      (topicId) => topicId === topic.id
        ? [item("src_openai"), item("src_simon"), item("src_aider")]
        : [item("src_openai", "x".repeat(600)), item("src_cursor")],
      window,
      {
        minBody: 400, perSource: 1, maxItems: 3, minimumSources: 2,
        requiredSourceIds: ["src_simon", "src_aider", "src_openai", "src_cursor"],
        requiredSourceIdsByTopic: {
          [topic.id]: ["src_simon", "src_aider"],
          [platform.id]: ["src_openai", "src_cursor"],
        },
      },
    );

    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].items.map((entry) => entry.source_id)).toEqual(["src_simon", "src_aider"]);
    expect(result.cases[1].items.map((entry) => entry.source_id)).toEqual(["src_openai", "src_cursor"]);
    expect(missingRequiredSourcesByTopic(result, {
      [topic.id]: ["src_simon", "src_aider"], [platform.id]: ["src_openai", "src_cursor"],
    })).toEqual([]);
  });

  it("rejects malformed fixed-pair configuration rather than silently falling back to global sources", () => {
    expect(() => parseTopicSourceIds('["src_a"]', "EVAL_TOPIC_SOURCE_IDS")).toThrow("JSON object");
    expect(() => parseTopicSourceIds('{"topic":["src_a","src_a"]}', "EVAL_TOPIC_SOURCE_IDS")).toThrow("不可重复");
  });

  it("bodyKind=transcript excludes show-notes and article fallbacks", () => {
    const result = buildLocalEvalCases(
      [topic],
      () => [
        item("src_article"),
        { ...item("src_show_notes"), body_kind: "show_notes" as const },
        { ...item("src_a"), id: "item-src_a-transcript", url: "https://example.test/src_a-transcript", body_kind: "transcript" as const },
        { ...item("src_b"), body_kind: "transcript" as const },
      ],
      window,
      { minBody: 400, perSource: 1, maxItems: 2, minimumSources: 2, requiredSourceIds: ["src_a", "src_b"], bodyKind: "transcript" },
    );
    expect(result.cases[0].items.map((entry) => entry.body_kind)).toEqual(["transcript", "transcript"]);
  });
});

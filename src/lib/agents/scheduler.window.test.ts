/** 冻结的 durable dispatch 必须按原窗口选材，不能把重试时的新内容混入历史 Brief。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../db/index.js";
import { insertContentItem, insertSource, insertTopic } from "../db/repos.js";
import type { ContentItem, Source, Topic } from "../types.js";

const { runAnalysisMock } = vi.hoisted(() => ({ runAnalysisMock: vi.fn() }));
vi.mock("./pipeline.js", async (orig) => ({
  ...(await orig<typeof import("./pipeline.js")>()),
  runAnalysis: runAnalysisMock,
}));

import { runScheduledTopicPipeline } from "./scheduler.js";

const topic: Topic = {
  id: "topic_a", name: "Topic A", keywords: [], language: "en", brief_schedule: "daily", enabled: true,
  archetype: "deep_vertical", facets: [],
};
const source: Source = { id: "source_a", name: "Source A", type: "rss", endpoint: "https://example.test/feed", topic_ids: [topic.id], fetch_interval: "1h", backfill: null, enabled: true };

function item(id: string, publishedAt: string): ContentItem {
  return {
    id, source_id: source.id, url: `https://example.test/${id}`, title: id, author: null,
    published_at: publishedAt, fetched_at: publishedAt, language: "en", topic_ids: [topic.id], tags: [],
    body: id, body_kind: "article", raw_ref: "", content_hash: `hash_${id}`, fetch_status: "ok",
  };
}

describe("runScheduledTopicPipeline frozen window", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    insertTopic(db, topic);
    insertSource(db, source);
    runAnalysisMock.mockReset();
  });

  it("只把 window_end 前的内容交给分析器", async () => {
    insertContentItem(db, item("in_window", "2026-08-07T12:00:00.000Z"));
    insertContentItem(db, item("after_window", "2026-08-08T12:00:00.000Z"));
    runAnalysisMock.mockRejectedValueOnce(new Error("stop_after_selection"));

    await expect(runScheduledTopicPipeline(db, topic.id, {
      reportType: "brief", windowHours: 24, items: 10, windowEnd: "2026-08-08T00:00:00.000Z",
    })).rejects.toThrow("stop_after_selection");

    expect(runAnalysisMock).toHaveBeenCalledWith(
      db, topic, [expect.objectContaining({ id: "in_window" })],
      { start: "2026-08-07T00:00:00.000Z", end: "2026-08-08T00:00:00.000Z" },
      expect.any(Object),
    );
  });
});

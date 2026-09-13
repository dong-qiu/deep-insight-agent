/** RSS feed path only parses episode metadata. Transcript transport is covered separately through
 * the real safeFetch → robots → cap path in rss-transcript.integration.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "../types.js";

// vi.hoisted：mock 工厂被提升到 import 之上，需用 hoisted 共享受控响应表。
const { responses } = vi.hoisted(() => ({ responses: new Map<string, { ok: boolean; text: string }>() }));

vi.mock("./safe-fetch.js", () => {
  const mockFetch = async (url: string) => {
    const r = responses.get(url);
    if (!r) throw new Error(`unmocked fetch ${url}`);
    return { ok: r.ok, _text: r.text } as unknown as Response;
  };
  return {
    MAX_RESPONSE_BYTES: 8_000_000,
    safeFetch: vi.fn(mockFetch),
    fetchWithRetry: vi.fn(mockFetch), // 切片3a：fetchRss feed 抓取改用退避包装
    readTextCapped: vi.fn(async (res: { _text: string }) => res._text),
  };
});
vi.mock("./robots.js", () => ({
  UA: "Bot",
  fetchRobots: vi.fn(async () => ({ disallow: [] })),
  isAllowed: vi.fn(() => true),
}));

const { fetchRss } = await import("./rss.js");

const FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <item><title>Ep</title><link>https://pod/ep</link><description>Show notes.</description>
    <podcast:transcript url="https://pod/ep.txt" type="text/plain"/>
  </item>
</channel></rss>`;

const source: Source = {
  id: "s", name: "S", type: "rss", endpoint: "https://pod/feed",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};

afterEach(() => {
  delete process.env.TRANSCRIPT_FETCH;
  responses.clear();
});

describe("fetchRss 只解析不抓（ADR-0027）", () => {
  it("只解析 transcript_url，body 与 body_kind 均保持既有 RSS 语义——即便开关开也不抓（后续 worker 才会评估）", async () => {
    process.env.TRANSCRIPT_FETCH = "1"; // 开关开
    responses.set("https://pod/feed", { ok: true, text: FEED });
    // 不为 transcript URL 设响应——若 fetchRss 误抓会 throw "unmocked fetch"
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Show notes.");
    expect(items[0].transcript_url).toBe("https://pod/ep.txt");
    expect(items[0].body_kind).toBeUndefined();
  });
});

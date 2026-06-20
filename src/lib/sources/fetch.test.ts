/** fetchRss 只解析不抓（ADR-0007 6a：转写抓取已移到 collector 去重后、只对新 url 抓）。
 *  此处守住「fetchRss 不抓转写」不变量——即便开关开，fetchRss 也只解析 transcript_url、body 仍 show notes。
 *  B族抓取/不降级的实际行为在 collector.test 覆盖。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "../types.js";

// vi.hoisted：mock 工厂被提升到 import 之上，需用 hoisted 共享受控响应表。
const { responses } = vi.hoisted(() => ({ responses: new Map<string, { ok: boolean; text: string }>() }));

vi.mock("./safe-fetch.js", () => ({
  MAX_RESPONSE_BYTES: 8_000_000,
  safeFetch: vi.fn(async (url: string) => {
    const r = responses.get(url);
    if (!r) throw new Error(`unmocked fetch ${url}`);
    return { ok: r.ok, _text: r.text } as unknown as Response;
  }),
  readTextCapped: vi.fn(async (res: { _text: string }) => res._text),
}));
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
  id: "s", name: "S", type: "rss", endpoint: "https://pod/feed", industry: "ai-swe",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};

afterEach(() => {
  delete process.env.TRANSCRIPT_FETCH;
  responses.clear();
});

describe("fetchRss 只解析不抓（6a）", () => {
  it("只解析 transcript_url，body 仍 show notes、body_kind 未设——即便开关开也不抓（抓取在 collector）", async () => {
    process.env.TRANSCRIPT_FETCH = "1"; // 开关开
    responses.set("https://pod/feed", { ok: true, text: FEED });
    // 不为 transcript URL 设响应——若 fetchRss 误抓会 throw "unmocked fetch"
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Show notes.");
    expect(items[0].transcript_url).toBe("https://pod/ep.txt");
    expect(items[0].body_kind).toBeUndefined();
  });
});

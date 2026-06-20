/** fetchRss 转写抓取（ADR-0007 切片2）：mock 出网 + robots，覆盖开关三态。
 *  纯逻辑（pickTranscriptUrl / stripTranscript）在 parse.test / normalize.test 已覆盖；
 *  此处验证 fetchRss 编排：开关门、body 替换、body_kind 赋值、抓取失败回退。 */
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

describe("fetchRss 转写抓取（ADR-0007 切片2）", () => {
  it("开关关：transcript_url 解析但不抓，body 仍 show notes、body_kind 未设（→ 归一化默认 article）", async () => {
    responses.set("https://pod/feed", { ok: true, text: FEED });
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Show notes.");
    expect(items[0].transcript_url).toBe("https://pod/ep.txt");
    expect(items[0].body_kind).toBeUndefined();
  });

  it("开关开 + 抓到转写：body=清洗后转写、body_kind=transcript", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    responses.set("https://pod/feed", { ok: true, text: FEED });
    responses.set("https://pod/ep.txt", { ok: true, text: "WEBVTT\n\n1\n00:00 --> 00:01\nReal transcript." });
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Real transcript.");
    expect(items[0].body_kind).toBe("transcript");
  });

  it("开关开 + 抓取失败（非 2xx）：回退 show notes、body_kind=show_notes", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    responses.set("https://pod/feed", { ok: true, text: FEED });
    responses.set("https://pod/ep.txt", { ok: false, text: "" });
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Show notes.");
    expect(items[0].body_kind).toBe("show_notes");
  });
});

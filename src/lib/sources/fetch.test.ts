/** fetchRss 只解析不抓（ADR-0007 6a：转写抓取已移到 collector 去重后、只对新 url 抓）。
 *  此处守住「fetchRss 不抓转写」不变量——即便开关开，fetchRss 也只解析 transcript_url、body 仍 show notes。
 *  B族抓取/不降级的实际行为在 collector.test 覆盖。 */
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
    readTextCapped: vi.fn(async (res: { _text: string }) => {
      if (res._text === "__size_limited__") throw new Error("响应体超过上限");
      return res._text;
    }),
  };
});
vi.mock("./robots.js", () => ({
  UA: "Bot",
  fetchRobots: vi.fn(async () => ({ disallow: [] })),
  isAllowed: vi.fn(() => true),
}));

const { extractSubstackEpisodeTranscriptUrl, extractSubstackTranscriptText, fetchRss, fetchTranscript } = await import("./rss.js");

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
  it("只解析 transcript_url，body 仍 show notes、body_kind 明确为 show_notes——即便开关开也不抓（抓取在 collector）", async () => {
    process.env.TRANSCRIPT_FETCH = "1"; // 开关开
    responses.set("https://pod/feed", { ok: true, text: FEED });
    // 不为 transcript URL 设响应——若 fetchRss 误抓会 throw "unmocked fetch"
    const items = await fetchRss(source);
    expect(items[0].body).toBe("Show notes.");
    expect(items[0].transcript_url).toBe("https://pod/ep.txt");
    expect(items[0].body_kind).toBe("show_notes");
    expect(items[0].is_podcast_episode).toBe(true);
  });
});

describe("fetchTranscript structured result", () => {
  it("成功时保留原始载荷、清洗正文、稳定 URL，且不把签名 query 带入证据身份", async () => {
    responses.set("https://pod/ep.txt?sig=ephemeral", { ok: true, text: "00:00:01 Hello world" });
    const result = await fetchTranscript("https://pod/ep.txt?sig=ephemeral");
    expect(result).toMatchObject({
      outcome: "success", stable_url: "https://pod/ep.txt", raw_payload: "00:00:01 Hello world",
      cleaned_body: "00:00:01 Hello world", speaker_attribution: "unknown",
    });
  });

  it("HTTP 失败保留可观测终态，而不是返空字符串", async () => {
    responses.set("https://pod/not-found.txt", { ok: false, text: "not found" });
    const result = await fetchTranscript("https://pod/not-found.txt");
    expect(result).toMatchObject({ outcome: "http_error", reason_code: "http_undefined" });
  });
});

describe("The Pragmatic Engineer / Substack episode adapter", () => {
  const episode = "https://newsletter.pragmaticengineer.com/p/building-codex?utm_source=rss";
  const canonical = "https://newsletter.pragmaticengineer.com/p/building-codex";
  const transcript = "https://substackcdn.com/video_upload/post/1/transcription.json?Expires=1&Signature=test";

  it("只接受与当前 canonical episode 同对象绑定的受信任 CDN URL，不取推荐集的第一个 URL", () => {
    const hydration = `<script type="application/json">${JSON.stringify({
      recommendations: [{ post: { canonical_url: "https://newsletter.pragmaticengineer.com/p/other" }, transcription: { cdn_url: "https://substackcdn.com/video_upload/post/other/transcription.json?Signature=other" } }],
      post: { canonical_url: canonical }, transcription: { cdn_url: transcript },
    })}</script>`;
    expect(extractSubstackEpisodeTranscriptUrl(hydration, episode)).toBe(transcript);
  });

  it("从 JSON.parse 字面量中绑定当前 post 的直属 podcastUpload，不继承到推荐集", () => {
    const current = "https://substackcdn.com/video_upload/post/1/current/transcription.json?Signature=current";
    const recommended = "https://substackcdn.com/video_upload/post/other/transcription.json?Signature=other";
    const payload = JSON.stringify({
      post: { canonical_url: canonical, podcastUpload: { transcription: { cdn_url: current } } },
      recentEpisodes: [{ post: { canonical_url: "https://newsletter.pragmaticengineer.com/p/other", podcastUpload: { transcription: { cdn_url: recommended } } } }],
    });
    const hydration = `<script>window.__loader = JSON.parse(${JSON.stringify(payload)});</script>`;

    expect(extractSubstackEpisodeTranscriptUrl(hydration, episode)).toBe(current);
  });

  it("缺少 episode 绑定或存在两个不同绑定 URL 时拒绝，而不是猜第一个", () => {
    const unbound = `<script>${JSON.stringify({ transcription: { cdn_url: transcript } })}</script>`;
    expect(extractSubstackEpisodeTranscriptUrl(unbound, episode)).toBeNull();
    const ambiguous = `<script>${JSON.stringify([
      { post: { canonical_url: canonical }, transcription: { cdn_url: transcript } },
      { post: { canonical_url: canonical }, transcription: { cdn_url: "https://substackcdn.com/video_upload/post/1/other/transcription.json?Signature=two" } },
    ])}</script>`;
    expect(extractSubstackEpisodeTranscriptUrl(ambiguous, episode)).toBeNull();
  });

  it("下载 JSON 时存节目页和实际载荷，并剥无可靠映射的 speaker label", async () => {
    const hydration = `<script type="application/json">${JSON.stringify({
      post: { canonical_url: canonical }, transcription: { cdn_url: transcript },
    })}</script>`;
    responses.set(episode, { ok: true, text: hydration });
    responses.set(transcript, { ok: true, text: JSON.stringify([
      { speaker: "host-id", text: "Host: Welcome." }, { speaker: "guest-id", text: "Gergely Orosz: Thanks." },
    ]) });
    const result = await fetchTranscript(episode, { adapter: "substack_episode_hydration" });
    expect(result).toMatchObject({
      outcome: "success", stable_url: "https://substackcdn.com/video_upload/post/1/transcription.json",
      cleaned_body: "Welcome.\nThanks.", speaker_attribution: "unknown",
      program_page: { stable_url: canonical, raw_payload: hydration },
    });
  });

  it("转录载荷超过剩余配额时记录 structured size_limited，而不是让 collector 抛错", async () => {
    const hydration = '<script type="application/json">{"post":{"canonical_url":"' + canonical
      + '"},"transcription":{"cdn_url":"' + transcript + '"}}</script>';
    responses.set(episode, { ok: true, text: hydration });
    responses.set(transcript, { ok: true, text: "__size_limited__" });

    await expect(fetchTranscript(episode, { adapter: "substack_episode_hydration" }))
      .resolves.toMatchObject({
        outcome: "size_limited", stable_url: "https://substackcdn.com/video_upload/post/1/transcription.json",
        bytes: Buffer.byteLength(hydration, "utf8"), reason_code: "response_size_limit",
      });
  });

  it("只保留 segment text；speaker/role label 不进入可分析正文", () => {
    expect(extractSubstackTranscriptText(JSON.stringify([
      { text: "CEO: We will ship it." }, { text: "plain fact" }, { words: [] }, null,
    ]))).toBe("We will ship it.\nplain fact");
  });
});

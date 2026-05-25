import { describe, expect, it } from "vitest";
import type { Source } from "../types.js";
import {
  contentHash, contentItemId, detectLanguage, normalizeUrl, rawToContentItem,
} from "./normalize.js";
import type { RawItem } from "./types.js";

describe("normalizeUrl", () => {
  it("去跟踪参数 / fragment / 末尾斜杠，host 小写", () => {
    expect(normalizeUrl("https://EX.com/a/?utm_source=x&id=1#frag")).toBe("https://ex.com/a/?id=1".replace(/\/$/, ""));
    expect(normalizeUrl("https://ex.com/p/")).toBe("https://ex.com/p");
  });
  it("解析失败原样 trim", () => {
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
  });
});

describe("contentHash", () => {
  it("空白不敏感、内容变则变", () => {
    expect(contentHash("a  b\nc")).toBe(contentHash("a b c"));
    expect(contentHash("a b c")).not.toBe(contentHash("a b d"));
  });
});

describe("detectLanguage", () => {
  it("纯英文 → en，纯中文 → zh，混合 → mixed", () => {
    expect(detectLanguage("hello world foo bar")).toBe("en");
    expect(detectLanguage("这是一段中文内容用于测试")).toBe("zh");
    expect(detectLanguage("这是 mixed 中英文 content 内容混合的 text 文本测试")).toBe("mixed");
  });
});

it("contentItemId 仅按 url 稳定（同 url 内容变 id 不变；不同 url 则异）", () => {
  expect(contentItemId("https://ex.com/a")).toBe(contentItemId("https://ex.com/a"));
  expect(contentItemId("https://ex.com/a")).not.toBe(contentItemId("https://ex.com/b"));
});

it("rawToContentItem 归一化 + 继承 Source.topic_ids", () => {
  const source: Source = {
    id: "s1", name: "S", type: "rss", endpoint: "https://ex.com/feed", industry: "ai-swe",
    topic_ids: ["t1", "t2"], fetch_interval: "1h", backfill: null, enabled: true,
  };
  const raw: RawItem = {
    url: "https://EX.com/post?utm_source=z", title: "  Title  ", author: "A",
    published_at: "2026-05-20", body: "Some  body\ntext.", raw: "{}",
  };
  const item = rawToContentItem(raw, source, "2026-05-26T00:00:00Z");
  expect(item.url).toBe("https://ex.com/post");
  expect(item.body).toBe("Some body text.");
  expect(item.title).toBe("Title");
  expect(item.topic_ids).toEqual(["t1", "t2"]);
  expect(item.source_id).toBe("s1");
  expect(item.content_hash).toBe(contentHash("Some body text."));
  expect(item.id).toBe(contentItemId(item.url));
  expect(item.fetch_status).toBe("ok");
  expect(item.raw_ref).toBe(""); // collector 回填
});

import { describe, expect, it } from "vitest";
import type { Source } from "../types.js";
import {
  MAX_BODY_CHARS, contentHash, contentItemId, detectLanguage, normalizeBody, normalizeUrl,
  rawToContentItem, stripHtml,
} from "./normalize.js";
import type { RawItem } from "./types.js";

const SRC: Source = {
  id: "s1", name: "S", type: "rss", endpoint: "https://ex.com/feed", industry: "ai-swe",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};

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

describe("stripHtml（#14 类根因：加粗/链接的数字被标签从 quote 切掉）", () => {
  it("行内标签删除，被加粗的数字回到正文（真实 #1 案例）", () => {
    const html = "Google says it now processes <strong>over 3.2 quadrillion tokens/month</strong>, up <strong>7x YoY</strong>";
    const clean = normalizeBody(html);
    expect(clean).toBe("Google says it now processes over 3.2 quadrillion tokens/month, up 7x YoY");
    // 模型剥标签后的 quote 现可逐字命中 body（不再在 "processes " 处截断）
    expect(clean.includes("processes over 3.2 quadrillion tokens/month")).toBe(true);
  });

  it("链接里的金额 + 数字实体（真实 #8 案例）", () => {
    const html = '<a href="/x">$1.5B ($300m each</a> &#8220;A typical&#8221;';
    expect(normalizeBody(html)).toBe("$1.5B ($300m each “A typical”");
  });

  it("块级标签 → 空白，不粘连相邻词", () => {
    expect(normalizeBody("<p>End one.</p><p>Start two.</p>")).toBe("End one. Start two.");
  });

  it("常见实体解码", () => {
    expect(stripHtml("a &amp; b &lt;tag&gt; &quot;q&quot; it&#39;s &nbsp;x")).toBe("a & b <tag> \"q\" it's  x");
  });

  it("印刷/排版命名实体解码（rep_54ed154e 真实根因：&rsquo;/&rdquo; 残留致 quote 不可达）", () => {
    expect(stripHtml("He&rsquo;d seen the &ldquo;static&rdquo; intro"))
      .toBe("He’d seen the “static” intro");
    expect(stripHtml("range&ndash;dash&mdash;em wait&hellip;"))
      .toBe("range–dash—em wait…");
    expect(stripHtml("&lsquo;curly&rsquo;")).toBe("‘curly’");
  });

  it("保留正文中的不等式（仅剥字母起头的标签）", () => {
    expect(normalizeBody("if a < b and c > d then x")).toBe("if a < b and c > d then x");
  });

  it("幂等：清洗后再清洗无变化", () => {
    const once = normalizeBody("<div>Foo <em>3.2 quadrillion</em> &amp; bar</div>");
    expect(normalizeBody(once)).toBe(once);
  });

  it("丢弃 script/style 整段", () => {
    expect(normalizeBody("Hi<script>alert(1)</script> there")).toBe("Hi there");
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

describe("rawToContentItem 正文上限（AC9 partial）", () => {
  const raw = (body: string): RawItem => ({
    url: "https://ex.com/big", title: "T", author: null, published_at: null, body, raw: "{}",
  });

  it("超 MAX_BODY_CHARS → 截断到上限并标 partial", () => {
    const item = rawToContentItem(raw("x".repeat(MAX_BODY_CHARS + 5000)), SRC, "2026-05-26T00:00:00Z");
    expect(item.body.length).toBe(MAX_BODY_CHARS);
    expect(item.fetch_status).toBe("partial");
    expect(item.content_hash).toBe(contentHash(item.body)); // 指纹按截断后正文计
  });

  it("未超限 → 完整保留并标 ok", () => {
    const item = rawToContentItem(raw("short body"), SRC, "2026-05-26T00:00:00Z");
    expect(item.body).toBe("short body");
    expect(item.fetch_status).toBe("ok");
  });
});

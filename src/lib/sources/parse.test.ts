import { describe, expect, it } from "vitest";
import { parseArxiv } from "./arxiv.js";
import { parseRss } from "./rss.js";

const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2605.00001v1</id>
    <title>Test  Paper
      Title</title>
    <published>2026-05-20T00:00:00Z</published>
    <summary>This is the abstract body.</summary>
    <author><name>Jane Doe</name></author>
    <link href="http://arxiv.org/abs/2605.00001v1" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2605.00002v1</id>
    <title>Second</title>
    <summary>Body two.</summary>
    <author><name>John Roe</name></author>
    <link href="http://arxiv.org/abs/2605.00002v1" rel="alternate"/>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title>Item One</title>
    <link>https://ex.com/a?utm_source=x</link>
    <pubDate>Mon, 20 May 2026 00:00:00 GMT</pubDate>
    <description>Body one.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Entry</title>
    <link href="https://ex.com/atom-1" rel="alternate"/>
    <updated>2026-05-21T00:00:00Z</updated>
    <content>Atom body.</content>
    <author><name>Ada</name></author>
  </entry>
</feed>`;

describe("parseArxiv", () => {
  const items = parseArxiv(ARXIV);
  it("解析全部 entry，title 折叠空白", () => {
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Test Paper Title");
    expect(items[0].url).toBe("http://arxiv.org/abs/2605.00001v1");
    expect(items[0].author).toBe("Jane Doe");
    expect(items[0].published_at).toBe("2026-05-20T00:00:00Z");
    expect(items[0].body).toBe("This is the abstract body.");
  });
});

describe("parseRss", () => {
  it("RSS 2.0 item", () => {
    const items = parseRss(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Item One");
    expect(items[0].url).toBe("https://ex.com/a?utm_source=x"); // 规范化在 rawToContentItem
    expect(items[0].body).toBe("Body one.");
  });
  it("无 <link>、URL 在 <guid>（安全客式）→ 回退 guid 作 url", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><guid>https://www.anquanke.com/post/id/1</guid><description></description></item>
    </channel></rss>`;
    expect(parseRss(feed)[0].url).toBe("https://www.anquanke.com/post/id/1");
  });

  it("<link> 存在时优先 link，不被 guid 覆盖", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><link>https://ex.com/real</link><guid>tag:ex.com,2026:1</guid><description>b</description></item>
    </channel></rss>`;
    expect(parseRss(feed)[0].url).toBe("https://ex.com/real");
  });

  it("相对 <link> + feed base → 归一为绝对 URL（决定⑤，防下游 new URL 抛错丢条目）", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><link>/posts/42</link><description>b</description></item></channel></rss>`;
    expect(parseRss(feed, "https://blog.example.com/feed.xml")[0].url).toBe("https://blog.example.com/posts/42");
  });

  it("绝对 <link> + base → 原样不变（base 不覆盖绝对）", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><link>https://other.com/x</link><description>b</description></item></channel></rss>`;
    expect(parseRss(feed, "https://blog.example.com/feed.xml")[0].url).toBe("https://other.com/x");
  });

  it("非 http scheme 的 <link>（tag:/mailto:）→ 丢弃，不灌进 url（即便有 base 也不放行）", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><link>mailto:x@ex.com</link><guid>tag:ex.com,2026:1</guid><description>b</description></item></channel></rss>`;
    expect(parseRss(feed, "https://blog.example.com/feed.xml")[0].url).toBe("");
  });

  it("相对 <link> 无 base → 丢弃（不灌非法 url）；Atom 相对 alt + base → 归一", () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><link>/rel</link><description>b</description></item></channel></rss>`;
    expect(parseRss(rss)[0].url).toBe("");
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>A</title><link href="/news/9" rel="alternate"/><content>c</content></entry></feed>`;
    expect(parseRss(atom, "https://site.example/atom")[0].url).toBe("https://site.example/news/9");
  });

  it("guid isPermaLink=false 或非 URL → 不当 url（仍空，避免拿 id 当链接）", () => {
    const f1 = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><guid isPermaLink="false">https://ex.com/x</guid><description>b</description></item></channel></rss>`;
    expect(parseRss(f1)[0].url).toBe("");
    const f2 = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>T</title><guid>tag:ex.com,2026:42</guid><description>b</description></item></channel></rss>`;
    expect(parseRss(f2)[0].url).toBe("");
  });

  it("Atom entry", () => {
    const items = parseRss(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://ex.com/atom-1");
    expect(items[0].author).toBe("Ada");
    expect(items[0].body).toBe("Atom body.");
  });
  it("无法识别的 XML → 空数组", () => {
    expect(parseRss("<x/>")).toEqual([]);
  });

  it("无 <podcast:transcript> → transcript_url undefined（普通 feed 不受影响）", () => {
    expect(parseRss(RSS)[0].transcript_url).toBeUndefined();
    expect(parseRss(ATOM)[0].transcript_url).toBeUndefined();
  });

  it("<podcast:transcript> 多格式：按 MIME 优先级选（plain>vtt），跳过 rel=captions", () => {
    const feed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <item>
    <title>Ep 1</title>
    <link>https://pod.example/ep1</link>
    <description>Show notes.</description>
    <podcast:transcript url="https://pod.example/ep1.vtt" type="text/vtt"/>
    <podcast:transcript url="https://pod.example/ep1.txt" type="text/plain"/>
    <podcast:transcript url="https://pod.example/ep1.srt" type="application/x-subrip" rel="captions"/>
  </item>
</channel></rss>`;
    const items = parseRss(feed);
    expect(items[0].body).toBe("Show notes."); // body 仍是 show notes（抓取在 fetchRss、按开关）
    expect(items[0].transcript_url).toBe("https://pod.example/ep1.txt"); // text/plain 优先、srt 因 captions 被跳
  });

  it("Atom 分支也解析 <podcast:transcript>", () => {
    const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <entry><title>E</title><link href="https://p/e" rel="alternate"/><content>notes</content>
    <podcast:transcript url="https://p/e.txt" type="text/plain"/>
  </entry>
</feed>`;
    expect(parseRss(feed)[0].transcript_url).toBe("https://p/e.txt");
  });

  it("<podcast:transcript> 仅 captions → 无可用转写 URL", () => {
    const feed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <item><title>E</title><link>https://p/e</link><description>n</description>
    <podcast:transcript url="https://p/e.srt" type="application/x-subrip" rel="captions"/>
  </item>
</channel></rss>`;
    expect(parseRss(feed)[0].transcript_url).toBeUndefined();
  });
});

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
});

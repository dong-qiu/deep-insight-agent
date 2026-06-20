import { describe, expect, it } from "vitest";
import type { Source } from "../types.js";
import {
  MAX_BODY_CHARS, MAX_TRANSCRIPT_CHARS, contentHash, contentItemId, detectLanguage,
  extractHtmlTranscript, normalizeBody, normalizeUrl, rawToContentItem, stripHtml, stripTranscript,
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

describe("stripTranscript（ADR-0007 切片2）", () => {
  it("VTT：剥头/时间轴/NOTE，保留台词", () => {
    const vtt = "WEBVTT\n\nNOTE recorded 2026\n\n1\n00:00:01.000 --> 00:00:03.000\nHello world.\n\n2\n00:00:03.500 --> 00:00:06.000\nSecond line here.";
    expect(stripTranscript(vtt)).toBe("Hello world. Second line here.");
  });
  it("SRT：剥 cue 序号 + 时间轴", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nFirst.\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond.";
    expect(stripTranscript(srt)).toBe("First. Second.");
  });
  it("纯文本原样收敛空白；幂等", () => {
    const out = stripTranscript("  Plain   transcript\n\ntext.  ");
    expect(out).toBe("Plain transcript text.");
    expect(stripTranscript(out)).toBe(out); // 幂等
  });
  it("保留说话人标签（不误剥）", () => {
    expect(stripTranscript("00:00:01.000 --> 00:00:02.000\nJohn: hi there")).toBe("John: hi there");
  });
  it("不误删正文：独立数字行 + 含 --> 的台词保留（评审 M1/M2）", () => {
    // "42" 后随正文（非时间轴）→ 不当 SRT 序号删；含 --> 但非行首时间戳 → 不当时间轴删
    expect(stripTranscript("In 2024\n42\npeople agreed")).toBe("In 2024 42 people agreed");
    expect(stripTranscript("The pipeline A --> B is key")).toBe("The pipeline A --> B is key");
  });
  it("VTT NOTE 多行块整块删（评审 M3）", () => {
    const vtt = "WEBVTT\n\nNOTE\nrecorded in studio\nby the team\n\n00:00:01.000 --> 00:00:02.000\nReal line.";
    expect(stripTranscript(vtt)).toBe("Real line.");
  });
  it("SRT 序号与时间轴间有空行：跳空行后仍认出序号（二轮 M1 边界）", () => {
    expect(stripTranscript("1\n\n00:00:01,000 --> 00:00:02,000\nHi there")).toBe("Hi there");
  });
  it("末尾纯数字行（无后随时间轴）保留为正文", () => {
    expect(stripTranscript("总数是\n100")).toBe("总数是 100");
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

  it("transcript 形态走更高上限：50k–300k 间不截断、标 ok（ADR-0007 按 kind 取值）", () => {
    const big = "y".repeat(MAX_BODY_CHARS + 100_000); // 150k：超 article 上限、未超 transcript 上限
    const tr = rawToContentItem({ ...raw(big), body_kind: "transcript" }, SRC, "2026-05-26T00:00:00Z");
    expect(tr.body.length).toBe(big.length); // 完整保留
    expect(tr.fetch_status).toBe("ok");
    const art = rawToContentItem(raw(big), SRC, "2026-05-26T00:00:00Z"); // 同样长度的 article → 截断
    expect(art.body.length).toBe(MAX_BODY_CHARS);
    expect(art.fetch_status).toBe("partial");
  });

  it("transcript 超 300k 仍截断到 transcript 上限", () => {
    const huge = "z".repeat(MAX_TRANSCRIPT_CHARS + 10_000);
    const tr = rawToContentItem({ ...raw(huge), body_kind: "transcript" }, SRC, "2026-05-26T00:00:00Z");
    expect(tr.body.length).toBe(MAX_TRANSCRIPT_CHARS);
    expect(tr.fetch_status).toBe("partial");
  });
});

describe("extractHtmlTranscript（ADR-0007 切片6d：Lex 式 .ts-segment）", () => {
  const seg = (name: string, text: string) =>
    `<div class="ts-segment"><span class="ts-name">${name}</span> ` +
    `<span class="ts-timestamp"><a href="#">(00:01:00)</a></span> <span class="ts-text">${text}</span></div>`;

  it("逐段抽 ts-text、配 ts-name 成 '说话人: 正文'", () => {
    const html = `<html><body>${seg("Lex Fridman", "Hello there.")}${seg("Guest", "Hi Lex.")}</body></html>`;
    expect(extractHtmlTranscript(html)).toBe("Lex Fridman: Hello there.\nGuest: Hi Lex.");
  });

  it("ts-text 内联标签被剥（stripHtml）", () => {
    const html = seg("Lex", 'See <a href="x">this <strong>paper</strong></a> now.');
    expect(extractHtmlTranscript(html)).toBe("Lex: See this paper now.");
  });

  it("不混入 ts-text 之外的页面 chrome（赞助/导航）", () => {
    const html = `<nav>Sponsor: BetterHelp</nav>${seg("Lex", "Real content.")}<footer>© 2026</footer>`;
    const out = extractHtmlTranscript(html);
    expect(out).toBe("Lex: Real content.");
    expect(out).not.toContain("Sponsor");
  });

  it("无 ts-text 结构 → 空串（交调用方回退，不误把整页当转写）", () => {
    expect(extractHtmlTranscript("<html><body><p>just a page</p></body></html>")).toBe("");
  });

  it("某段缺 ts-name 不致说话人错位（review M1）：续段沿用上一说话人，不串味", () => {
    const html =
      `<span class="ts-name">Lex</span><span class="ts-text">First.</span>` +
      `<span class="ts-text">Still Lex, no name span.</span>` + // 续段：缺 ts-name
      `<span class="ts-name">Guest</span><span class="ts-text">Guest now.</span>`;
    // 有序扫描：续段归到上一个说话人 Lex，Guest 仍正确——而非整体错位
    expect(extractHtmlTranscript(html)).toBe("Lex: First.\nLex: Still Lex, no name span.\nGuest: Guest now.");
  });

  it("text 先于任何 name 出现 → 无前缀（不臆造说话人）", () => {
    expect(extractHtmlTranscript('<span class="ts-text">Orphan line.</span>')).toBe("Orphan line.");
  });
});

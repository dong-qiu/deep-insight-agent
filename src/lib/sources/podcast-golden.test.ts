import { describe, expect, it } from "vitest";
import type { Source } from "../types.js";
import {
  applyGoldenSource,
  deriveLexTranscriptUrl,
  titleMatchesAiSwe,
} from "./podcast-golden.js";
import type { RawItem } from "./types.js";

function lexSource(): Source {
  return {
    id: "src_lex_fridman",
    name: "Lex Fridman Podcast",
    type: "rss",
    endpoint: "https://lexfridman.com/feed/podcast/",
    industry: "ai-swe",
    topic_ids: ["t_code_agents"],
    fetch_interval: "24h",
    backfill: null,
    enabled: true,
  } as unknown as Source;
}
function rawItem(over: Partial<RawItem>): RawItem {
  return { url: "https://lexfridman.com/x/", title: "t", author: null, published_at: null, body: "b", raw: "{}", ...over };
}

describe("deriveLexTranscriptUrl", () => {
  it("单集页 → <slug>-transcript/（剥查询参数）", () => {
    expect(deriveLexTranscriptUrl("https://lexfridman.com/don-lincoln/?utm_source=rss")).toBe(
      "https://lexfridman.com/don-lincoln-transcript/",
    );
  });
  it("已是转写页 → undefined（不重复加后缀）", () => {
    expect(deriveLexTranscriptUrl("https://lexfridman.com/don-lincoln-transcript/")).toBeUndefined();
  });
  it("非 lexfridman.com → undefined", () => {
    expect(deriveLexTranscriptUrl("https://example.com/don-lincoln/")).toBeUndefined();
  });
  it("多级路径（非单集页）→ undefined", () => {
    expect(deriveLexTranscriptUrl("https://lexfridman.com/tag/ai/")).toBeUndefined();
  });
  it("非法 URL → undefined（不抛）", () => {
    expect(deriveLexTranscriptUrl("not a url")).toBeUndefined();
  });
});

describe("titleMatchesAiSwe（标题筛子）", () => {
  it.each([
    "#494 – Jensen Huang: NVIDIA & the AI Revolution",
    "#490 – State of AI in 2026: LLMs, Coding, Scaling Laws",
    "#471 – Sundar Pichai: CEO of Google and Alphabet", // 嘉宾白名单兜底（标题无关键词）
    "Linus Torvalds: Linux, GitHub, and the Future", // 嘉宾白名单
    "George Hotz: The Future", // 纯嘉宾名兜底，标题无关键词
    "#474 – DHH: Future of Programming, AI, Ruby on Rails",
    "#452 – Dario Amodei: Anthropic CEO on Claude, AGI",
  ])("命中 AI/SWE：%s", (t) => expect(titleMatchesAiSwe(t)).toBe(true));

  it.each([
    "#497 – Biggest Mysteries in Physics: Antimatter, Dark Energy",
    "#495 – Vikings, Ragnar, Berserkers, Valhalla",
    "#473 – Iran War Debate: Nuclear Weapons, Trump, Peace",
    "#453 – Javier Milei: President of Argentina",
    "#489 – Paul Rosolie: Uncontacted Tribes in the Amazon Jungle",
  ])("离题不命中：%s", (t) => expect(titleMatchesAiSwe(t)).toBe(false));

  it("词界防误中：Ukraine/domain 不因含 'ai' 命中", () => {
    expect(titleMatchesAiSwe("War in Ukraine and the domain of power")).toBe(false);
  });
});

describe("applyGoldenSource", () => {
  it("Lex 源：留命中集 + 为其注入推导的 transcript_url", () => {
    const items = [
      rawItem({ url: "https://lexfridman.com/jensen-huang/", title: "Jensen Huang: NVIDIA and AI" }),
      rawItem({ url: "https://lexfridman.com/vikings/", title: "Vikings and Valhalla" }),
    ];
    const out = applyGoldenSource(lexSource(), items);
    expect(out).toHaveLength(1); // 离题集被筛掉
    expect(out[0].url).toContain("jensen-huang");
    expect(out[0].transcript_url).toBe("https://lexfridman.com/jensen-huang-transcript/");
  });

  it("已带 transcript_url 的集不被覆盖", () => {
    const items = [
      rawItem({ url: "https://lexfridman.com/ai-show/", title: "AI show", transcript_url: "https://x/t.vtt" }),
    ];
    expect(applyGoldenSource(lexSource(), items)[0].transcript_url).toBe("https://x/t.vtt");
  });

  it("非注册源（普通 rss）原样透传，不筛不改", () => {
    const src = { ...lexSource(), endpoint: "https://feeds.transistor.fm/practical-ai" } as Source;
    const items = [rawItem({ url: "https://x/a", title: "Vikings" }), rawItem({ url: "https://x/b", title: "anything" })];
    const out = applyGoldenSource(src, items);
    expect(out).toHaveLength(2); // 不筛
    expect(out[0].transcript_url).toBeUndefined(); // 不注入
  });
});

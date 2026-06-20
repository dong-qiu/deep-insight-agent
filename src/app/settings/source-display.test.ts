import { describe, expect, it } from "vitest";
import type { Source } from "../../lib/types.js";
import { INDUSTRY_ORDER, sourceForm } from "./source-display.js";

const base: Source = {
  id: "s", name: "Some Feed", type: "rss", endpoint: "https://example.com/feed",
  industry: "ai-swe", topic_ids: [], fetch_interval: "6h", backfill: null, enabled: true,
};
const mk = (o: Partial<Source>): Source => ({ ...base, ...o });

describe("sourceForm", () => {
  it("arxiv → 论文（type 精确，优先于一切）", () => {
    expect(sourceForm(mk({ type: "arxiv", endpoint: "http://export.arxiv.org/api/query" })).label).toBe("论文");
    // 即便 name 含「播客」、有 transcript，arxiv 仍判论文
    expect(sourceForm(mk({ type: "arxiv", name: "x（播客）" }), new Set(["transcript"])).label).toBe("论文");
  });

  it("GitHub Atom → 仓库", () => {
    expect(sourceForm(mk({ endpoint: "https://github.com/OWASP/x/releases.atom" })).label).toBe("仓库");
    expect(sourceForm(mk({ endpoint: "https://github.com/mitre-atlas/atlas-data/commits.atom" })).label).toBe("仓库");
  });

  it("github.blog 等非 *.atom 的 GitHub 博客 feed 不误判为仓库", () => {
    expect(sourceForm(mk({ endpoint: "https://github.blog/category/engineering/feed/" })).label).toBe("资讯");
    expect(sourceForm(mk({ endpoint: "https://githubnext.com/rss.xml" })).label).toBe("资讯");
  });

  it("播客：已产出 transcript/show_notes 即判播客（实测优先，不靠 name）", () => {
    expect(sourceForm(mk({ name: "改了名没播客二字" }), new Set(["transcript"])).label).toBe("播客");
    expect(sourceForm(mk({ name: "改了名没播客二字" }), new Set(["show_notes"])).label).toBe("播客");
  });

  it("播客：冷启动（无内容）回退到 name 含「播客」", () => {
    expect(sourceForm(mk({ name: "Practical AI（播客 · 元数据）" })).label).toBe("播客");
    expect(sourceForm(mk({ name: "Practical AI（播客）" }), new Set()).label).toBe("播客");
  });

  it("其余 rss → 资讯", () => {
    expect(sourceForm(mk({ name: "Hacker News" })).label).toBe("资讯");
    expect(sourceForm(mk({ name: "Hacker News" }), new Set(["article"])).label).toBe("资讯");
  });
});

describe("INDUSTRY_ORDER", () => {
  it("列出已知 Industry 的展示顺序（漏配由「其他」组兜底，非编译期穷举）", () => {
    expect(INDUSTRY_ORDER.map((g) => g.id).sort()).toEqual(["ai-security", "ai-swe"]);
  });
});

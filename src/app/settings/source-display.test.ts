import { describe, expect, it } from "vitest";
import type { Source, Topic } from "../../lib/types.js";
import { DOMAIN_ORDER, sourceDomains, sourceForm } from "./source-display.js";

const base: Source = {
  id: "s", name: "Some Feed", type: "rss", endpoint: "https://example.com/feed",
  topic_ids: [], fetch_interval: "6h", backfill: null, enabled: true,
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

describe("DOMAIN_ORDER", () => {
  it("来自受控词表 DOMAIN_VALUES（去 ai- 前缀 + foundation-models）", () => {
    expect(DOMAIN_ORDER.map((g) => g.id)).toEqual(["software-engineering", "security", "foundation-models"]);
    expect(DOMAIN_ORDER.find((g) => g.id === "foundation-models")?.label).toBe("基础模型");
  });
});

describe("sourceDomains（Step2c：源的域由 topic.facets 派生）", () => {
  const t = (id: string, facets: string[]): Topic => ({
    id, name: id, keywords: [], language: "zh", brief_schedule: "daily", enabled: true, facets,
  });
  const topicById = new Map<string, Topic>([
    ["t_swe", t("t_swe", ["domain:software-engineering", "lens:technical"])],
    ["t_sec", t("t_sec", ["domain:security", "lens:technical"])],
    ["t_ind", t("t_ind", ["domain:foundation-models", "lens:business"])],
  ]);

  it("取源全部 topic 的 domain 并集（lens facet 不算域）", () => {
    expect([...sourceDomains(mk({ topic_ids: ["t_swe"] }), topicById)]).toEqual(["software-engineering"]);
    expect([...sourceDomains(mk({ topic_ids: ["t_ind"] }), topicById)]).toEqual(["foundation-models"]);
  });

  it("跨多 topic → 多域并集去重", () => {
    const d = sourceDomains(mk({ topic_ids: ["t_swe", "t_sec"] }), topicById);
    expect([...d].sort()).toEqual(["security", "software-engineering"]);
  });

  it("无 topic / 未知 topic → 空集（page.tsx 归「未分类」）", () => {
    expect(sourceDomains(mk({ topic_ids: [] }), topicById).size).toBe(0);
    expect(sourceDomains(mk({ topic_ids: ["nope"] }), topicById).size).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../db/index.js";
import {
  getEffectiveModels, getEffectiveSources, loadStaticConfig, resolveEnvRefs, seedDefaults,
} from "./index.js";

describe("resolveEnvRefs", () => {
  it("递归替换 ${VAR}（字符串/数组/对象，非字符串原样）", () => {
    process.env.TEST_FOO = "bar";
    expect(resolveEnvRefs({ a: "x-${TEST_FOO}", b: ["${TEST_FOO}"], n: 1, t: true })).toEqual({
      a: "x-bar", b: ["bar"], n: 1, t: true,
    });
  });
  it("引用未设置的变量即抛（启动校验）", () => {
    delete process.env.TEST_MISSING_XYZ;
    expect(() => resolveEnvRefs({ k: "${TEST_MISSING_XYZ}" })).toThrow(/TEST_MISSING_XYZ/);
  });
});

describe("loadStaticConfig + 播种 + 合并", () => {
  let db: DB;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    db = openDb(":memory:");
  });

  it("加载默认配置、解析 ${VAR}、通过 Zod 校验", () => {
    const cfg = loadStaticConfig();
    expect(cfg.models.apiKey).toBe("test-key"); // ${ANTHROPIC_API_KEY} 已解析
    expect(cfg.models.analyzer).toBeTruthy();
    expect(cfg.defaultTopics.length).toBeGreaterThan(0);
    expect(cfg.defaultSources.length).toBeGreaterThan(0);
    expect(cfg.defaultSources[0].backfill).toBeNull(); // 未填 → 默认 null
  });

  it("将 GitHub Changelog 保持为显式启用前的 staged 候选", () => {
    const cfg = loadStaticConfig();
    const source = cfg.defaultSources.find((candidate) => candidate.id === "src_github_changelog");
    expect(source).toMatchObject({
      type: "rss",
      endpoint: "https://github.blog/changelog/feed/",
      topic_ids: ["t_code_agents"],
      fetch_interval: "6h",
      fetch_mode: "feed",
      enabled: false,
    });
    seedDefaults(db, cfg);
    expect(db.prepare("SELECT enabled FROM source WHERE id=?").get("src_github_changelog")).toEqual({
      enabled: 0,
    });
  });

  it("将新增的 AI-SWE 官方来源保持为逐源启用前的 staged 候选", () => {
    const cfg = loadStaticConfig();
    const expected = [
      {
        id: "src_openai_codex_releases", endpoint: "https://github.com/openai/codex/releases.atom",
        fetch_interval: "12h", fetch_mode: "full_text", content_container: "repository-content",
      },
      {
        id: "src_cursor_changelog", endpoint: "https://cursor.com/changelog/rss.xml",
        fetch_interval: "12h", fetch_mode: "feed", content_container: null,
      },
      {
        id: "src_openhands_releases", endpoint: "https://github.com/OpenHands/OpenHands/releases.atom",
        fetch_interval: "24h", fetch_mode: "feed", content_container: null,
      },
    ];

    for (const candidate of expected) {
      expect(cfg.defaultSources.find((source) => source.id === candidate.id)).toMatchObject({
        ...candidate, type: "rss", topic_ids: ["t_code_agents"], enabled: false,
      });
    }

    seedDefaults(db, cfg);
    for (const candidate of expected) {
      expect(db.prepare("SELECT enabled FROM source WHERE id=?").get(candidate.id)).toEqual({ enabled: 0 });
    }
  });

  it("将已复审的信息源以预期默认值播种", () => {
    const cfg = loadStaticConfig();
    const semianalysis = cfg.defaultSources.find((candidate) => candidate.id === "src_semianalysis");
    const googleResearch = cfg.defaultSources.find((candidate) => candidate.id === "src_google_research");

    expect(semianalysis).toMatchObject({
      endpoint: "https://newsletter.semianalysis.com/feed",
      topic_ids: ["t_ai_industry"],
      fetch_mode: "feed",
      enabled: true,
    });
    expect(googleResearch).toMatchObject({
      endpoint: "https://research.google/blog/rss/",
      topic_ids: ["t_code_agents"],
      fetch_mode: "full_text",
      content_container: "rich_text",
      enabled: false,
    });

    seedDefaults(db, cfg);
    expect(db.prepare("SELECT endpoint, enabled FROM source WHERE id=?").get("src_semianalysis")).toEqual({
      endpoint: "https://newsletter.semianalysis.com/feed", enabled: 1,
    });
    expect(db.prepare("SELECT enabled FROM source WHERE id=?").get("src_google_research")).toEqual({
      enabled: 0,
    });
  });

  it("seedDefaults 幂等", () => {
    const cfg = loadStaticConfig();
    const first = seedDefaults(db, cfg);
    expect(first.topics).toBe(cfg.defaultTopics.length);
    expect(first.sources).toBe(cfg.defaultSources.length);
    expect(seedDefaults(db, cfg)).toEqual({ topics: 0, sources: 0 }); // 二次不重复
  });

  it("getEffectiveSources：库空则播种后返回", () => {
    const cfg = loadStaticConfig();
    expect(getEffectiveSources(db, cfg).length).toBe(cfg.defaultSources.length);
  });

  it("getEffectiveModels：env 覆盖 > 静态默认", () => {
    const cfg = loadStaticConfig();
    const priorAnalyzer = process.env.ANALYZER_MODEL;
    const priorCoverage = process.env.COVERAGE_MODEL;
    delete process.env.ANALYZER_MODEL;
    delete process.env.COVERAGE_MODEL;
    expect(getEffectiveModels(cfg).analyzer).toBe(cfg.models.analyzer);
    expect(getEffectiveModels(cfg).coverage).toBeNull();
    process.env.ANALYZER_MODEL = "claude-opus-4-6";
    process.env.COVERAGE_MODEL = "claude-opus-4-8";
    expect(getEffectiveModels(cfg).analyzer).toBe("claude-opus-4-6");
    expect(getEffectiveModels(cfg).coverage).toBe("claude-opus-4-8");
    if (priorAnalyzer === undefined) delete process.env.ANALYZER_MODEL;
    else process.env.ANALYZER_MODEL = priorAnalyzer;
    if (priorCoverage === undefined) delete process.env.COVERAGE_MODEL;
    else process.env.COVERAGE_MODEL = priorCoverage;
  });
});

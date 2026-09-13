import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../db/index.js";
import {
  getEffectiveModels, getEffectiveSources, loadStaticConfig, loadStaticSourceConfig, resolveEnvRefs, seedDefaults,
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
  it("在非 Anthropic provider 下拒绝以旧 key 满足通用 key", () => {
    const provider = process.env.LLM_PROVIDER;
    const generic = process.env.LLM_API_KEY;
    process.env.LLM_PROVIDER = "volcengine-responses";
    delete process.env.LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "legacy-key";
    expect(() => resolveEnvRefs({ k: "${LLM_API_KEY}" })).toThrow(/LLM_API_KEY/);
    if (provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = provider;
    if (generic === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = generic;
  });
});

describe("loadStaticConfig + 播种 + 合并", () => {
  let db: DB;
  beforeEach(() => {
    delete process.env.LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    db = openDb(":memory:");
  });

  it("加载默认配置、解析 ${VAR}、通过 Zod 校验", () => {
    const cfg = loadStaticConfig();
    expect(cfg.models.apiKey).toBe("test-key"); // ${LLM_API_KEY} 经 Anthropic legacy alias 解析
    expect(cfg.models.analyzer).toBeTruthy();
    expect(cfg.defaultTopics.length).toBeGreaterThan(0);
    expect(cfg.defaultSources.length).toBeGreaterThan(0);
    expect(cfg.defaultSources[0].backfill).toBeNull(); // 未填 → 默认 null
  });

  it("source-only 配置不解析模型密钥，但仍校验 topics 与 sources", () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const config = loadStaticSourceConfig();
      expect(config.defaultTopics.length).toBeGreaterThan(0);
      expect(config.defaultSources.find((source) => source.id === "src_chain_of_thought")).toMatchObject({
        transcript_mode: "off", transcript_host_qps: 0.5,
      });
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
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

  it("将 Chain of Thought 以逐源关闭的 transcript 策略播种", () => {
    const cfg = loadStaticConfig();
    const source = cfg.defaultSources.find((candidate) => candidate.id === "src_chain_of_thought");
    expect(source).toMatchObject({
      endpoint: "https://feeds.transistor.fm/chain-of-thought", topic_ids: ["t_code_agents"],
      transcript_mode: "off", transcript_strategy: "all", enabled: false,
    });
    seedDefaults(db, cfg);
    expect(db.prepare("SELECT transcript_mode,transcript_strategy FROM source WHERE id=?").get("src_chain_of_thought"))
      .toEqual({ transcript_mode: "off", transcript_strategy: "all" });
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
        ...candidate, type: "rss",
        topic_ids: candidate.id === "src_openhands_releases"
          ? ["t_code_agents"]
          : ["t_code_agents", "t_coding_agent_platforms"],
        enabled: false,
      });
    }

    seedDefaults(db, cfg);
    for (const candidate of expected) {
      expect(db.prepare("SELECT enabled FROM source WHERE id=?").get(candidate.id)).toEqual({ enabled: 0 });
    }
  });

  it("将 controlled-v2 新主题保持停用，并给其候选来源显式路由", () => {
    const cfg = loadStaticConfig();
    expect(cfg.defaultTopics.filter((topic) => topic.id === "t_coding_agent_platforms" || topic.id === "t_agent_security"))
      .toMatchObject([
        { id: "t_coding_agent_platforms", enabled: false, facets: ["domain:software-engineering", "lens:technical"] },
        { id: "t_agent_security", enabled: false, facets: ["domain:security", "lens:technical"] },
      ]);
    expect(cfg.defaultSources.find((source) => source.id === "src_embracethered")?.topic_ids)
      .toEqual(["t_prompt_injection", "t_agent_security"]);
    expect(cfg.defaultSources.find((source) => source.id === "src_simonwillison_promptinj")?.topic_ids)
      .toEqual(["t_prompt_injection", "t_agent_security"]);

    seedDefaults(db, cfg);
    expect(db.prepare("SELECT enabled FROM topic WHERE id=?").get("t_coding_agent_platforms")).toEqual({ enabled: 0 });
    expect(db.prepare("SELECT enabled FROM topic WHERE id=?").get("t_agent_security")).toEqual({ enabled: 0 });
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

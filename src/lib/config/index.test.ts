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
    delete process.env.ANALYZER_MODEL;
    expect(getEffectiveModels(cfg).analyzer).toBe(cfg.models.analyzer);
    process.env.ANALYZER_MODEL = "claude-opus-4-6";
    expect(getEffectiveModels(cfg).analyzer).toBe("claude-opus-4-6");
    delete process.env.ANALYZER_MODEL;
  });
});

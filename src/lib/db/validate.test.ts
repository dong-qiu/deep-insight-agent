import { describe, expect, it } from "vitest";
import { validateSourceInput, validateTopicInput } from "./validate.js";

describe("validateTopicInput", () => {
  const valid = {
    name: "AI 软件工程", keywords: ["coding", "agent"],
    industry: "ai-swe", language: "zh", brief_schedule: "daily",
  };

  it("最小合法输入 → ok + 自动生成 id", () => {
    const v = validateTopicInput(valid);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.id).toMatch(/^t_/);
  });

  it("existingId 注入 → 用注入值", () => {
    const v = validateTopicInput(valid, { existingId: "t_keep_me" });
    if (v.ok) expect(v.value.id).toBe("t_keep_me");
  });

  it("name 空 → 422", () => {
    const v = validateTopicInput({ ...valid, name: "  " });
    expect(v.ok).toBe(false);
  });

  it("keywords 不是数组 → 422", () => {
    const v = validateTopicInput({ ...valid, keywords: "not array" });
    expect(v.ok).toBe(false);
  });

  it("keywords 空数组 → 422", () => {
    const v = validateTopicInput({ ...valid, keywords: [] });
    expect(v.ok).toBe(false);
  });

  it("industry 非白名单 → 422", () => {
    const v = validateTopicInput({ ...valid, industry: "garbage" });
    expect(v.ok).toBe(false);
  });

  it("language 缺省 → 默认 zh", () => {
    const { language: _, ...rest } = valid;
    const v = validateTopicInput(rest);
    if (v.ok) expect(v.value.language).toBe("zh");
  });

  it("brief_schedule 非白名单 → 422", () => {
    const v = validateTopicInput({ ...valid, brief_schedule: "hourly" });
    expect(v.ok).toBe(false);
  });

  it("enabled=false 显式 → false", () => {
    const v = validateTopicInput({ ...valid, enabled: false });
    if (v.ok) expect(v.value.enabled).toBe(false);
  });

  it("非对象 → 422", () => {
    expect(validateTopicInput(null).ok).toBe(false);
    expect(validateTopicInput("string").ok).toBe(false);
  });

  it("keyword 单项 >100 字符 → 422（Sonnet R1 concern）", () => {
    const v = validateTopicInput({ ...valid, keywords: ["a".repeat(101)] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain("100");
  });

  it("keyword 单项 100 字符正好 → ok（边界）", () => {
    const v = validateTopicInput({ ...valid, keywords: ["a".repeat(100)] });
    expect(v.ok).toBe(true);
  });
});

describe("validateSourceInput", () => {
  const valid = {
    name: "ArXiv cs.CL", type: "arxiv", endpoint: "https://export.arxiv.org/api/query",
    industry: "ai-swe", topic_ids: ["t_swe"], fetch_interval: "1h",
  };

  it("合法输入 → ok + id 自动生成 / type/endpoint 保留", () => {
    const v = validateSourceInput(valid);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.id).toMatch(/^src_/);
      expect(v.value.type).toBe("arxiv");
    }
  });

  it("type 非白名单 → 422", () => {
    const v = validateSourceInput({ ...valid, type: "scrape" });
    expect(v.ok).toBe(false);
  });

  it("endpoint 非 URL → 422", () => {
    const v = validateSourceInput({ ...valid, endpoint: "not a url" });
    expect(v.ok).toBe(false);
  });

  it("fetch_interval 非法格式 → 422", () => {
    const v = validateSourceInput({ ...valid, fetch_interval: "very fast" });
    expect(v.ok).toBe(false);
  });

  it("fetch_interval 缺省 → 1h", () => {
    const { fetch_interval: _, ...rest } = valid;
    const v = validateSourceInput(rest);
    if (v.ok) expect(v.value.fetch_interval).toBe("1h");
  });

  it("topic_ids 不是数组 → 422", () => {
    const v = validateSourceInput({ ...valid, topic_ids: "single" });
    expect(v.ok).toBe(false);
  });
});

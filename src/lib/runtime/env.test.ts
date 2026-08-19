import { afterEach, describe, expect, it } from "vitest";
import { llmMaxRetries } from "./env.js";

describe("llmMaxRetries", () => {
  const original = process.env.LLM_MAX_RETRIES;

  afterEach(() => {
    if (original === undefined) delete process.env.LLM_MAX_RETRIES;
    else process.env.LLM_MAX_RETRIES = original;
  });

  it("允许用 0 禁用 SDK 重试", () => {
    process.env.LLM_MAX_RETRIES = "0";
    expect(llmMaxRetries()).toBe(0);
  });

  it("对无效或负值回退到安全默认值", () => {
    process.env.LLM_MAX_RETRIES = "invalid";
    expect(llmMaxRetries()).toBe(2);
    process.env.LLM_MAX_RETRIES = "-1";
    expect(llmMaxRetries()).toBe(2);
  });
});

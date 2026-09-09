import { afterEach, describe, expect, it } from "vitest";
import { coverageThinking, coverageThinkingSource, llmMaxRetries, validatorThinking } from "./env.js";

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

describe("coverageThinking", () => {
  const validatorOriginal = process.env.VALIDATOR_THINKING;
  const coverageOriginal = process.env.COVERAGE_THINKING;

  afterEach(() => {
    if (validatorOriginal === undefined) delete process.env.VALIDATOR_THINKING;
    else process.env.VALIDATOR_THINKING = validatorOriginal;
    if (coverageOriginal === undefined) delete process.env.COVERAGE_THINKING;
    else process.env.COVERAGE_THINKING = coverageOriginal;
  });

  it("inherits the validator setting only while the dedicated setting is absent", () => {
    delete process.env.COVERAGE_THINKING;
    process.env.VALIDATOR_THINKING = "0";
    expect(coverageThinking()).toBe(false);
    expect(coverageThinkingSource()).toBe("inherited");
    process.env.VALIDATOR_THINKING = "1";
    expect(coverageThinking()).toBe(true);
  });

  it("lets the dedicated setting override validator thinking without mutating it", () => {
    process.env.VALIDATOR_THINKING = "1";
    process.env.COVERAGE_THINKING = "0";
    expect(validatorThinking()).toBe(true);
    expect(coverageThinking()).toBe(false);
    expect(coverageThinkingSource()).toBe("explicit");
    process.env.VALIDATOR_THINKING = "0";
    process.env.COVERAGE_THINKING = "1";
    expect(validatorThinking()).toBe(false);
    expect(coverageThinking()).toBe(true);
  });
});

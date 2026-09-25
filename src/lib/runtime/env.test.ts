import { afterEach, describe, expect, it } from "vitest";
import { coverageMaxTokens, coverageThinking, coverageThinkingSource, llmMaxRetries, llmTransientRetries, llmTransientRetryBackoffMs, validatorBatchOn, validatorThinking } from "./env.js";

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

describe("llmTransientRetries", () => {
  const retriesOriginal = process.env.LLM_TRANSIENT_RETRIES;
  const backoffOriginal = process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS;

  afterEach(() => {
    if (retriesOriginal === undefined) delete process.env.LLM_TRANSIENT_RETRIES;
    else process.env.LLM_TRANSIENT_RETRIES = retriesOriginal;
    if (backoffOriginal === undefined) delete process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS;
    else process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = backoffOriginal;
  });

  it("默认仅补一次本地墙钟超时，并允许显式关闭", () => {
    delete process.env.LLM_TRANSIENT_RETRIES;
    expect(llmTransientRetries()).toBe(1);
    process.env.LLM_TRANSIENT_RETRIES = "0";
    expect(llmTransientRetries()).toBe(0);
  });

  it("限制额外尝试和退避，拒绝异常配置放大任务时延", () => {
    process.env.LLM_TRANSIENT_RETRIES = "99";
    expect(llmTransientRetries()).toBe(2);
    process.env.LLM_TRANSIENT_RETRIES = "invalid";
    expect(llmTransientRetries()).toBe(1);
    process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "99999";
    expect(llmTransientRetryBackoffMs()).toBe(10_000);
    process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "-1";
    expect(llmTransientRetryBackoffMs()).toBe(750);
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

describe("coverageMaxTokens", () => {
  const original = process.env.COVERAGE_MAX_TOKENS;

  afterEach(() => {
    if (original === undefined) delete process.env.COVERAGE_MAX_TOKENS;
    else process.env.COVERAGE_MAX_TOKENS = original;
  });

  it("preserves the 2048 compatibility default and bounds explicit escalations", () => {
    delete process.env.COVERAGE_MAX_TOKENS;
    expect(coverageMaxTokens()).toBe(2_048);
    process.env.COVERAGE_MAX_TOKENS = "4096";
    expect(coverageMaxTokens()).toBe(4_096);
    process.env.COVERAGE_MAX_TOKENS = "8192";
    expect(coverageMaxTokens()).toBe(8_192);
  });

  it("rejects invalid explicit values instead of silently changing the reviewed profile", () => {
    process.env.COVERAGE_MAX_TOKENS = "2047";
    expect(coverageMaxTokens).toThrow("COVERAGE_MAX_TOKENS 必须是 2048、4096 或 8192");
    process.env.COVERAGE_MAX_TOKENS = "8193";
    expect(coverageMaxTokens).toThrow("COVERAGE_MAX_TOKENS 必须是 2048、4096 或 8192");
    process.env.COVERAGE_MAX_TOKENS = "3000";
    expect(coverageMaxTokens).toThrow("COVERAGE_MAX_TOKENS 必须是 2048、4096 或 8192");
    process.env.COVERAGE_MAX_TOKENS = "invalid";
    expect(coverageMaxTokens).toThrow("COVERAGE_MAX_TOKENS 必须是 2048、4096 或 8192");
  });
});

describe("validatorBatchOn", () => {
  const original = process.env.VALIDATOR_BATCH;

  afterEach(() => {
    if (original === undefined) delete process.env.VALIDATOR_BATCH;
    else process.env.VALIDATOR_BATCH = original;
  });

  it("defaults to the single-judge path and requires explicit opt-in", () => {
    delete process.env.VALIDATOR_BATCH;
    expect(validatorBatchOn()).toBe(false);
    process.env.VALIDATOR_BATCH = "0";
    expect(validatorBatchOn()).toBe(false);
    process.env.VALIDATOR_BATCH = "unexpected";
    expect(validatorBatchOn()).toBe(false);
    process.env.VALIDATOR_BATCH = "1";
    expect(validatorBatchOn()).toBe(true);
  });
});

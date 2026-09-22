import { afterEach, describe, expect, it } from "vitest";
import { llmApiKey, llmBaseUrl, llmCostProvider, llmProvider, requireLlmApiKey, requireLlmBaseUrl, structuredTransportVersion, VOLCENGINE_CODING_PLAN_BASE_URL } from "./llm-provider.js";

const environment = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});

describe("LLM provider selection", () => {
  it("keeps Anthropic as the backwards-compatible default", () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "legacy-key";
    expect(llmProvider()).toBe("anthropic");
    expect(llmApiKey()).toBe("legacy-key");
    expect(llmCostProvider()).toBe("anthropic");
    expect(structuredTransportVersion()).toBe("forced-tool-enabled-v1");
  });

  it("uses the generic key and explicit Coding Plan endpoint for Volcengine", () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "volc-key";
    process.env.LLM_BASE_URL = " https://ark.cn-beijing.volces.com/api/coding/v3/ ";
    expect(llmProvider()).toBe("volcengine-responses");
    expect(llmApiKey()).toBe("volc-key");
    expect(llmBaseUrl()).toBe(VOLCENGINE_CODING_PLAN_BASE_URL);
    expect(requireLlmBaseUrl()).toBe(VOLCENGINE_CODING_PLAN_BASE_URL);
    expect(llmCostProvider()).toBe("volcengine");
    expect(structuredTransportVersion()).toBe("volcengine-responses-forced-function-v2");
  });

  it("does not use an Anthropic legacy key for a Volcengine request", () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    delete process.env.LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "legacy-key";
    expect(llmApiKey()).toBeUndefined();
    expect(() => requireLlmApiKey()).toThrow("LLM_API_KEY");
  });

  it("rejects an unsupported provider and a missing Volcengine endpoint before network I/O", () => {
    expect(() => llmProvider("unknown-provider")).toThrow("不支持的 LLM_PROVIDER");
    delete process.env.LLM_BASE_URL;
    expect(() => requireLlmBaseUrl("volcengine-responses")).toThrow("LLM_BASE_URL");
  });

  it("pins a Coding Plan bearer key to the admitted HTTPS endpoint", () => {
    expect(llmBaseUrl(
      "volcengine-responses",
      "https://tenant.apigateway-cn-beijing.volceapi.com/v1/",
    )).toBe("https://tenant.apigateway-cn-beijing.volceapi.com/v1");
    expect(llmBaseUrl(
      "volcengine-responses",
      "https://tenant.apigateway-cn-beijing.volceapi.com/v1/responses/",
    )).toBe("https://tenant.apigateway-cn-beijing.volceapi.com/v1/responses");
    for (const endpoint of [
      "http://ark.cn-beijing.volces.com/api/coding/v3",
      "https://ark.cn-beijing.volces.com.evil.example/api/coding/v3",
      "https://reader:password@ark.cn-beijing.volces.com/api/coding/v3",
      "https://ark.cn-beijing.volces.com/api/coding/v3?redirect=https://evil.example",
      "https://ark.cn-beijing.volces.com/api/v3",
      "https://tenant.apigateway-cn-beijing.volceapi.com/api/coding/v3",
      "https://tenant.apigateway-cn-beijing.volceapi.evil.example/v1",
    ]) {
      expect(() => llmBaseUrl("volcengine-responses", endpoint)).toThrow("LLM_BASE_URL 必须是");
    }
  });
});

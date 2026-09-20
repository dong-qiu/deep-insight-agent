import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { callStructured, getCostReport, MODELS, resetCostMeter, resetRoleCallTelemetry } from "./llm.js";
import { STRUCTURED_RESPONSE_TOOL_NAME } from "./volcengine-responses.js";

const originalEnvironment = { ...process.env };
const originalModels = { ...MODELS };
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  Object.assign(MODELS, originalModels);
  globalThis.fetch = originalFetch;
  resetCostMeter();
  resetRoleCallTelemetry();
});

describe("callStructured through Volcengine Responses", () => {
  it("uses the new provider only when explicitly selected and retains Zod as the output gate", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "function_call", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"answer":"ok"}' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(callStructured({
      role: "analyzer",
      system: "system",
      user: "user",
      schema: z.object({ answer: z.string() }),
      maxTokens: 2048,
      thinking: false,
    })).resolves.toMatchObject({
      data: { answer: "ok" },
      usage: { input_tokens: 11, output_tokens: 7 },
      // The project has no verified Volcengine USD price table yet: the fallback must remain
      // visibly estimated instead of being persisted as a known price.
      cost: { tokens: 18, estimated: true },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails locally before fetch when a Volcengine endpoint is not explicit", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    delete process.env.LLM_BASE_URL;
    globalThis.fetch = vi.fn() as typeof fetch;

    await expect(callStructured({
      role: "analyzer", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toThrow("LLM_BASE_URL");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accounts a paid malformed response before Zod rejects it", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "completed", output: [{ type: "message" }], usage: { input_tokens: 9, output_tokens: 4 },
    }), { status: 200 })) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toThrow("schema 校验失败");
    expect(getCostReport().byModel).toEqual([expect.objectContaining({ model: "glm-5.3", calls: 1, input: 9, output: 4, unpriced: true })]);
  });
});

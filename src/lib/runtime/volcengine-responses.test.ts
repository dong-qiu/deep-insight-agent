import { afterEach, describe, expect, it, vi } from "vitest";
import { callVolcengineResponses, STRUCTURED_RESPONSE_TOOL_NAME, VolcengineResponsesError } from "./volcengine-responses.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const request = {
  apiKey: "not-a-real-key",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/",
  model: "glm-5.3",
  system: "Return only the requested result.",
  user: "Return ok=true.",
  jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  maxTokens: 2048,
  thinking: false,
};

describe("Volcengine Responses structured adapter", () => {
  it("posts a forced function call to the Coding Plan Responses endpoint and normalizes usage", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "function_call", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' }],
      usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } },
      }), { status: 200 });
    };

    await expect(callVolcengineResponses(request)).resolves.toEqual({
      input: { ok: true },
      usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 3 },
      stopReason: "completed",
    });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/coding/v3/responses");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer not-a-real-key", "Content-Type": "application/json" } });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "glm-5.3", instructions: request.system, input: request.user, max_output_tokens: 2048, thinking: { type: "disabled" } });
    expect(body.tools[0]).toMatchObject({ type: "function", name: STRUCTURED_RESPONSE_TOOL_NAME, parameters: request.jsonSchema, strict: true });
    expect(body.tool_choice).toEqual({ type: "function", name: STRUCTURED_RESPONSE_TOOL_NAME });
  });

  it("supports an enabled-thinking request without changing the structured contract", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({
        output: [{ type: "function_call", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: { ok: true } }], usage: {},
      }), { status: 200 });
    };

    await expect(callVolcengineResponses({ ...request, thinking: true })).resolves.toMatchObject({ input: { ok: true } });
    expect(JSON.parse(String(calls[0]![1]?.body)).thinking).toEqual({ type: "enabled" });
  });

  it("does not leak an upstream error body into the safe failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response("credential=do-not-log; source body=do-not-log", { status: 503 })) as typeof fetch;
    await expect(callVolcengineResponses(request)).rejects.toEqual(expect.objectContaining({
      name: "VolcengineResponsesError", status: 503, message: "Volcengine Responses 请求失败（HTTP 503）",
    }));
  });

  it("returns missing function output to the runtime's Zod gate so usage can still be accounted", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: "message" }] }), { status: 200 })) as typeof fetch;
    await expect(callVolcengineResponses(request)).resolves.toMatchObject({ input: undefined, usage: { input_tokens: 0, output_tokens: 0 } });
  });
});

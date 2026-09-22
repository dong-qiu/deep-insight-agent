import { once } from "node:events";
import { createServer, type Server } from "node:http";
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

function sse(events: unknown[], lineBreak = "\n"): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}${lineBreak}${lineBreak}`).join("")}data: [DONE]${lineBreak}${lineBreak}`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function endlesslyBufferedSse(onCancel?: (reason: unknown) => void): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode("data: {\"type\":\"response.in_progress\"}\n\n"));
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("Volcengine Responses structured adapter", () => {
  it("posts a forced function call to the Coding Plan Responses endpoint and normalizes usage", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = async (input, init) => {
      calls.push([input, init]);
      return sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
        { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } } } },
      ]);
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
    expect(body).toMatchObject({ model: "glm-5.3", instructions: request.system, input: request.user, max_output_tokens: 2048, stream: true, thinking: { type: "disabled" } });
    expect(body.tools[0]).toMatchObject({ type: "function", name: STRUCTURED_RESPONSE_TOOL_NAME, parameters: request.jsonSchema, strict: true });
    expect(body.tool_choice).toEqual({ type: "function", name: STRUCTURED_RESPONSE_TOOL_NAME });
  });

  it("does not append /responses twice when a console gateway provides the complete endpoint", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = async (input, init) => {
      calls.push([input, init]);
      return sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    };
    await expect(callVolcengineResponses({
      ...request,
      baseUrl: "https://tenant.apigateway-cn-beijing.volceapi.com/v1/responses/",
    })).resolves.toMatchObject({ input: { ok: true } });
    expect(calls[0]![0]).toBe("https://tenant.apigateway-cn-beijing.volceapi.com/v1/responses");
  });

  it("supports an enabled-thinking request without changing the structured contract", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = async (input, init) => {
      calls.push([input, init]);
      return sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: { ok: true } },
        { type: "response.completed", response: { status: "completed", output: [], usage: {} } },
      ]);
    };

    await expect(callVolcengineResponses({ ...request, thinking: true })).resolves.toMatchObject({ input: { ok: true } });
    expect(JSON.parse(String(calls[0]![1]?.body)).thinking).toEqual({ type: "enabled" });
  });

  it("accepts standard CRLF SSE framing", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ], "\r\n")) as typeof fetch;
    await expect(callVolcengineResponses(request)).resolves.toMatchObject({ input: { ok: true } });
  });

  it("accepts one anonymous arguments-done event only when completed output identifies the forced function", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", arguments: '{"ok":true}' },
      { type: "response.completed", response: {
        status: "completed",
        output: [{ type: "function_call", name: STRUCTURED_RESPONSE_TOOL_NAME }],
        usage: {},
      } },
    ])) as typeof fetch;
    await expect(callVolcengineResponses(request)).resolves.toMatchObject({ input: { ok: true } });
  });

  it("does not leak an upstream error body into the safe failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response("credential=do-not-log; source body=do-not-log", { status: 503 })) as typeof fetch;
    await expect(callVolcengineResponses(request)).rejects.toEqual(expect.objectContaining({
      name: "VolcengineResponsesError", status: 503, message: "Volcengine Responses 请求失败（HTTP 503）",
    }));
  });

  it("rejects every redirect response without allowing fetch to forward prompts or source input", async () => {
    for (const status of [301, 302, 307, 308]) {
      let requestInit: RequestInit | undefined;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestInit = init;
        return new Response(null, {
        status,
        headers: { Location: "https://untrusted.example/collect" },
        });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(callVolcengineResponses(request)).rejects.toMatchObject({
        name: "VolcengineResponsesError", status,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestInit).toMatchObject({ redirect: "error" });
    }
  });

  it("relies on Node's redirect:error behavior so a 307 target never receives the POST body", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_req, res) => {
      redirectedRequests++;
      res.writeHead(204).end();
    });
    const destinationPort = await listen(destination);
    const origin = createServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}/collect` }).end();
    });
    const originPort = await listen(origin);
    try {
      await expect(originalFetch(`http://127.0.0.1:${originPort}/responses`, {
        method: "POST",
        body: "protected source input",
        redirect: "error",
      })).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
    } finally {
      await close(origin);
      await close(destination);
    }
  });

  it("cancels an endlessly buffered SSE reader when its caller deadline aborts", async () => {
    let resolveCancelled: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<unknown>((resolve) => { resolveCancelled = resolve; });
    globalThis.fetch = vi.fn(async () => endlesslyBufferedSse((reason) => resolveCancelled?.(reason))) as typeof fetch;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("test caller deadline")), 5);

    await expect(callVolcengineResponses({ ...request, signal: controller.signal })).rejects.toThrow("test caller deadline");
    await expect(cancelled).resolves.toMatchObject({ message: "test caller deadline" });
  });

  it("keeps the normal completion path when a non-aborted caller signal is supplied", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ])) as typeof fetch;
    const controller = new AbortController();

    await expect(callVolcengineResponses({ ...request, signal: controller.signal })).resolves.toMatchObject({ input: { ok: true } });
    expect(controller.signal.aborted).toBe(false);
  });

  it("refuses an unadmitted adapter endpoint before fetch even if a caller bypasses the runtime", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(callVolcengineResponses({ ...request, baseUrl: "https://untrusted.example/v1" })).rejects.toThrow("LLM_BASE_URL 必须是");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns a malformed final function call to the runtime's Zod gate so usage can still be accounted", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ])) as typeof fetch;
    await expect(callVolcengineResponses(request)).resolves.toMatchObject({ input: undefined, usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it("fails closed when the completion event has no matching function-arguments final event", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ])) as typeof fetch;
    await expect(callVolcengineResponses(request)).rejects.toThrow("缺少函数参数完成事件");
  });

  it("does not trust an anonymous arguments-done event without an expected completed function call", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", arguments: '{"ok":true}' },
      { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", name: "other_function" }], usage: {} } },
    ])) as typeof fetch;
    await expect(callVolcengineResponses(request)).rejects.toThrow("缺少函数参数完成事件");
  });

  it("fails closed when a streaming response ends without its completion event", async () => {
    globalThis.fetch = vi.fn(async () => sse([{ type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' }])) as typeof fetch;
    await expect(callVolcengineResponses(request)).rejects.toThrow("完成事件前结束");
  });
});

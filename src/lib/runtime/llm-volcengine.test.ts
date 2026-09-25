import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { callStructured, getCostReport, getRoleCallTelemetry, MODELS, resetCostMeter, resetRoleCallTelemetry } from "./llm.js";
import { STRUCTURED_RESPONSE_TOOL_NAME } from "./volcengine-responses.js";

const originalEnvironment = { ...process.env };
const originalModels = { ...MODELS };
const originalFetch = globalThis.fetch;

function sse(events: unknown[]): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function endlesslyBufferedSse(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode("data: {\"type\":\"response.in_progress\"}\n\n"));
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

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
    const fetchMock = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"answer":"ok"}' },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 11, output_tokens: 7 } } },
    ]));
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
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 4 } } },
    ])) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toThrow("schema 校验失败");
    expect(getCostReport().byModel).toEqual([expect.objectContaining({ model: "glm-5.3", calls: 1, input: 9, output: 4, unpriced: true })]);
  });

  it("accounts and fails closed for a paid completion that omitted the final function event", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TRANSIENT_RETRIES = "1";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 4 } } },
    ])) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", telemetryOperation: "provider_transport_test", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toMatchObject({ retryable: false, streamDiagnostic: { terminal: "completed", functionArgumentsDone: false } });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getCostReport().byModel).toEqual([expect.objectContaining({ model: "glm-5.3", calls: 1, input: 9, output: 4, unpriced: true })]);
    expect(getRoleCallTelemetry().analyzer).toMatchObject({
      failures: 1,
      provider_stream_failures: { completed_missing_function_arguments: 1 },
      provider_sse_done: { true: 1 },
      provider_function_arguments_done: { false: 1 },
    });
  });

  it("accounts but never accepts paid formal or contradictory terminal responses", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TRANSIENT_RETRIES = "0";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 9, output_tokens: 4 } } },
      ]))
      .mockResolvedValueOnce(sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
        { type: "response.completed", response: { status: "refusal", usage: { input_tokens: 3, output_tokens: 2 } } },
      ]));
    globalThis.fetch = fetchMock as typeof fetch;

    const call = () => callStructured({
      role: "analyzer", telemetryOperation: "provider_transport_test", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    });
    await expect(call()).rejects.toMatchObject({ retryable: false, streamDiagnostic: { terminal: "incomplete" } });
    await expect(call()).rejects.toMatchObject({ retryable: false, streamDiagnostic: { terminal: "completed_invalid_status" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCostReport().byModel).toEqual([expect.objectContaining({ model: "glm-5.3", calls: 2, input: 12, output: 6, unpriced: true })]);
    expect(getRoleCallTelemetry().analyzer).toMatchObject({
      failures: 2,
      provider_stream_failures: { incomplete: 1, completed_invalid_status: 1 },
      output_stop_reasons: { max_output_tokens: 1, other: 1 },
    });
  });

  it("does not resubmit a paid completed-protocol defect even when the EOF retry budget is available", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TRANSIENT_RETRIES = "1";
    process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "0";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(sse([
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 4 } } },
      ]))
      .mockResolvedValueOnce(sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
      ])) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", telemetryOperation: "provider_transport_test", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toMatchObject({ retryable: false, streamDiagnostic: { terminal: "completed", functionArgumentsDone: false } });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getCostReport().byModel).toEqual([expect.objectContaining({ calls: 1, input: 9, output: 4 })]);
    expect(getRoleCallTelemetry().analyzer).toMatchObject({
      requests: 1, failures: 1,
      provider_stream_failures: { completed_missing_function_arguments: 1 },
      provider_function_arguments_done: { false: 1 },
    });
  });

  it("retries only EOF-before-terminal and records its safe protocol class after recovery", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TRANSIENT_RETRIES = "1";
    process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "0";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
      ]))
      .mockResolvedValueOnce(sse([
        { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ])) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", telemetryOperation: "provider_transport_test", system: "system", user: "user",
      schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).resolves.toMatchObject({ data: { ok: true } });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(getRoleCallTelemetry().analyzer).toMatchObject({
      calls: 1, failures: 0, requests: 2,
      provider_stream_failures: { eof_before_terminal: 1 },
      provider_sse_done: { true: 2 }, provider_function_arguments_done: { true: 2 },
      by_operation: { provider_transport_test: { provider_stream_failures: { eof_before_terminal: 1 } } },
    });
  });

  it("does not expose an exhausted EOF retry to the validator-level retry budget", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TRANSIENT_RETRIES = "1";
    process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "0";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn(async () => sse([
      { type: "response.function_call_arguments.done", name: STRUCTURED_RESPONSE_TOOL_NAME, arguments: '{"ok":true}' },
    ])) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", telemetryOperation: "provider_transport_test", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toMatchObject({ retryable: true, streamDiagnostic: { terminal: "eof_before_terminal" } });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(getRoleCallTelemetry().analyzer).toMatchObject({
      requests: 2, provider_stream_failures: { eof_before_terminal: 2 },
    });
  });

  it("propagates the full callStructured wall-clock deadline through an endlessly buffered Responses stream", async () => {
    process.env.LLM_PROVIDER = "volcengine-responses";
    process.env.LLM_API_KEY = "not-a-real-key";
    process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
    process.env.LLM_TIMEOUT_MS = "5";
    process.env.LLM_MAX_RETRIES = "0";
    process.env.LLM_TRANSIENT_RETRIES = "0";
    Object.assign(MODELS, { analyzer: "glm-5.3" });
    globalThis.fetch = vi.fn(async () => endlesslyBufferedSse()) as typeof fetch;

    await expect(callStructured({
      role: "analyzer", system: "system", user: "user", schema: z.object({ ok: z.boolean() }), maxTokens: 2048,
    })).rejects.toThrow("LLM stream exceeded wall-clock timeout of 5ms");
  });
});

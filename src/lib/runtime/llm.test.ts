/** coerceStringifiedFields 纯函数单测（6b 防御：模型偶发把 array/object 字段返成 JSON 字符串）。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { MODELS, anthropicBaseUrl, assertCoverageModelSeparation, assertModelSeparation, callStructured, coerceStringifiedFields, createRequestAbortSignal, getRoleCallTelemetry, recordRoleCallTelemetry, resetRoleCallTelemetry, retryTransientOperation, structuredThinkingConfig } from "./llm.js";

const originalModels = { ...MODELS };

afterEach(() => Object.assign(MODELS, originalModels));

describe("assertCoverageModelSeparation", () => {
  it("接受三个不同且显式配置的模型", () => {
    Object.assign(MODELS, { analyzer: "analyzer", validator: "validator", coverage: "coverage" });
    expect(() => assertCoverageModelSeparation()).not.toThrow();
  });

  it("拒绝未配置的反扩写复核模型", () => {
    Object.assign(MODELS, { analyzer: "analyzer", validator: "validator", coverage: "" });
    expect(() => assertCoverageModelSeparation()).toThrow("COVERAGE_MODEL");
  });

  it("拒绝任意同源的三个角色", () => {
    Object.assign(MODELS, { analyzer: "same", validator: "validator", coverage: "same" });
    expect(() => assertCoverageModelSeparation()).toThrow("必须独立于分析与主校验");
  });
});

describe("assertModelSeparation", () => {
  it("在任何 analyzer / validator 请求前拒绝同模型配置", () => {
    Object.assign(MODELS, { analyzer: "same-model", validator: "same-model" });
    expect(() => assertModelSeparation()).toThrow("同源偏差约束");
  });
});

describe("coerceStringifiedFields（6b 结构化输出防御）", () => {
  const schema = z.object({ insights: z.array(z.string()) });

  it("array 字段被序列化成字符串 → 定点 JSON.parse 修回数组，再校验通过", () => {
    const bad = { insights: '["a","b"]' };
    const issues = schema.safeParse(bad).error!.issues;
    const fixed = coerceStringifiedFields(bad, issues);
    expect(fixed).toEqual({ insights: ["a", "b"] });
    expect(schema.safeParse(fixed).success).toBe(true);
  });

  it("嵌套 object 字段同理", () => {
    const s = z.object({ meta: z.object({ k: z.string() }) });
    const bad = { meta: '{"k":"v"}' };
    expect(coerceStringifiedFields(bad, s.safeParse(bad).error!.issues)).toEqual({ meta: { k: "v" } });
  });

  it("非 array/object 类型错（如 number）→ 不修正、返 null", () => {
    const s = z.object({ n: z.number() });
    const bad = { n: "abc" };
    expect(coerceStringifiedFields(bad, s.safeParse(bad).error!.issues)).toBeNull();
  });

  it("字符串不是合法 JSON → 不修正、返 null（不破坏原输出）", () => {
    const bad = { insights: "not json at all" };
    expect(coerceStringifiedFields(bad, schema.safeParse(bad).error!.issues)).toBeNull();
  });
});

describe("anthropicBaseUrl", () => {
  it("保留 relay endpoint，并规整末尾斜杠", () => {
    expect(anthropicBaseUrl(" https://relay.example.test/ ")).toBe("https://relay.example.test");
  });

  it("未配置时让 SDK 使用官方默认 endpoint", () => {
    expect(anthropicBaseUrl(undefined)).toBeUndefined();
    expect(anthropicBaseUrl("   ")).toBeUndefined();
  });
});

describe("createRequestAbortSignal（LLM 流硬超时）", () => {
  afterEach(() => vi.useRealTimers());

  it("在墙钟期限到达时中止仍未结束的流", () => {
    vi.useFakeTimers();
    const request = createRequestAbortSignal(120);

    vi.advanceTimersByTime(119);
    expect(request.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBeInstanceOf(Error);
    expect((request.signal.reason as Error).message).toContain("120ms");
    request.dispose();
  });

  it("保留调用方主动取消的原因，并清理内部计时器", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const request = createRequestAbortSignal(120, caller.signal);
    const reason = new Error("cost limit reached");

    caller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);

    request.dispose();
    vi.advanceTimersByTime(120);
    expect(request.signal.reason).toBe(reason);
  });
});

describe("retryTransientOperation（SSE 墙钟超时的有界应用层重试）", () => {
  it("仅对瞬态墙钟超时重试，保留一次初始调用和一次额外尝试", async () => {
    const calls: number[] = [];
    const retries: number[] = [];
    const sleeps: number[] = [];
    const result = await retryTransientOperation(async () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) throw new Error("LLM stream exceeded wall-clock timeout of 120000ms");
      return "ok";
    }, {
      retries: 1,
      backoffMs: 25,
      onRetry: (_error, retryNumber) => retries.push(retryNumber),
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    });

    expect(result).toBe("ok");
    expect(calls).toEqual([1, 2]);
    expect(retries).toEqual([1]);
    expect(sleeps).toEqual([25]);
  });

  it("拒答和 schema 类错误不重试，避免把内容错误扩大为额外模型调用", async () => {
    const operation = vi.fn(async () => { throw new Error("结构化输出 schema 校验失败"); });
    await expect(retryTransientOperation(operation, { retries: 2, backoffMs: 0 })).rejects.toThrow("schema");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("调用方取消优先，瞬态错误后不再发起下一次请求", async () => {
    const caller = new AbortController();
    const cancellation = new Error("cost limit reached");
    const operation = vi.fn(async () => {
      caller.abort(cancellation);
      throw new Error("Connection error.");
    });

    await expect(retryTransientOperation(operation, { retries: 2, backoffMs: 0, signal: caller.signal })).rejects.toBe(cancellation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("重试耗尽后原样抛出瞬态错误", async () => {
    const timeout = new Error("LLM stream exceeded wall-clock timeout of 120000ms");
    const operation = vi.fn(async () => { throw timeout; });
    await expect(retryTransientOperation(operation, { retries: 99, backoffMs: 0 })).rejects.toBe(timeout);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe("Volcengine Responses EOF recovery", () => {
  const environmentKeys = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_TRANSIENT_RETRIES", "LLM_TRANSIENT_RETRY_BACKOFF_MS"] as const;

  async function withVolcengineEnvironment<T>(fn: () => Promise<T>): Promise<T> {
    const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    const previousFetch = globalThis.fetch;
    try {
      process.env.LLM_PROVIDER = "volcengine-responses";
      process.env.LLM_API_KEY = "not-a-real-key";
      process.env.LLM_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
      process.env.LLM_TRANSIENT_RETRIES = "1";
      process.env.LLM_TRANSIENT_RETRY_BACKOFF_MS = "0";
      return await fn();
    } finally {
      globalThis.fetch = previousFetch;
      for (const key of environmentKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  function sse(events: unknown[]): Response {
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("retries one fresh request after EOF before completion and never accepts the first partial result", async () => {
    await withVolcengineEnvironment(async () => {
      resetRoleCallTelemetry();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(sse([
          { type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"ok":false}' },
        ]))
        .mockResolvedValueOnce(sse([
          { type: "response.function_call_arguments.done", name: "respond_with_structured_output", arguments: '{"ok":true}' },
          { type: "response.completed", response: { status: "completed", usage: {} } },
        ]));
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(callStructured({
        role: "analyzer",
        system: "Return a boolean.",
        user: "Return ok=true.",
        schema: z.object({ ok: z.boolean() }),
      })).resolves.toMatchObject({ data: { ok: true } });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(getRoleCallTelemetry().analyzer).toMatchObject({ calls: 1, failures: 0, requests: 2 });
      resetRoleCallTelemetry();
    });
  });

  it("does not retry a provider-declared incomplete response", async () => {
    await withVolcengineEnvironment(async () => {
      const fetchMock = vi.fn().mockResolvedValue(sse([
        { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      ]));
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(callStructured({
        role: "analyzer",
        system: "Return a boolean.",
        user: "Return ok=true.",
        schema: z.object({ ok: z.boolean() }),
      })).rejects.toMatchObject({ retryable: false, streamDiagnostic: { terminal: "incomplete" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("role-level LLM telemetry", () => {
  afterEach(() => resetRoleCallTelemetry());

  it("records attempts, failures and percentile latency separately for each role", () => {
    recordRoleCallTelemetry("coverage", 10, 1, false, [], "display_quote_countercheck");
    recordRoleCallTelemetry(
      "coverage",
      30,
      3,
      true,
      ["max_tokens", "refusal", "max_tokens"],
      "display_quote_countercheck",
      { streamFailures: ["eof_before_terminal", "eof_before_terminal", "source_secret", "upstream-error"], httpStatuses: [503], sseDone: [true, false], functionArgumentsDone: [true, false] },
    );
    recordRoleCallTelemetry("validator", 20, 1, false, ["tool_use"], "citation_consistency_batch");
    expect(getRoleCallTelemetry()).toMatchObject({
      coverage: {
        calls: 2, failures: 1, requests: 4, output_stop_reasons: { max_tokens: 2, refusal: 1 },
        provider_stream_failures: { eof_before_terminal: 2 }, provider_http_statuses: { 503: 1 },
        provider_sse_done: { false: 1, true: 1 }, provider_function_arguments_done: { false: 1, true: 1 },
        latency_ms: { p50: 10, p95: 30, max: 30 },
        by_operation: {
          display_quote_countercheck: {
            calls: 2, failures: 1, requests: 4, output_stop_reasons: { max_tokens: 2, refusal: 1 },
            provider_stream_failures: { eof_before_terminal: 2 }, provider_http_statuses: { 503: 1 },
            provider_sse_done: { false: 1, true: 1 }, provider_function_arguments_done: { false: 1, true: 1 },
          },
        },
      },
      validator: {
        calls: 1, failures: 0, requests: 1, output_stop_reasons: { tool_use: 1 },
        latency_ms: { p50: 20, p95: 20, max: 20 },
        by_operation: { citation_consistency_batch: { calls: 1, output_stop_reasons: { tool_use: 1 } } },
      },
      analyzer: { output_stop_reasons: {}, by_operation: {} },
    });
  });

  it("keeps omitted operation names explicit instead of silently merging them into a labelled phase", () => {
    recordRoleCallTelemetry("validator", 10, 1, false, ["max_tokens"]);
    recordRoleCallTelemetry("validator", 20, 1, false, ["tool_use"], "display_quote_primary");

    expect(getRoleCallTelemetry().validator.by_operation).toMatchObject({
      unclassified: { calls: 1, output_stop_reasons: { max_tokens: 1 } },
      display_quote_primary: { calls: 1, output_stop_reasons: { tool_use: 1 } },
    });
  });
});

describe("structured thinking transport", () => {
  it("only sends an admission-tested thinking payload with room above the minimum budget", () => {
    expect(structuredThinkingConfig(false, 1024)).toBeUndefined();
    expect(structuredThinkingConfig(true, 2048)).toEqual({ type: "enabled", budget_tokens: 1024, display: "omitted" });
    expect(() => structuredThinkingConfig(true, 1024)).toThrow("maxTokens");
  });
});

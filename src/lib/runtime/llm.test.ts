/** coerceStringifiedFields 纯函数单测（6b 防御：模型偶发把 array/object 字段返成 JSON 字符串）。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { MODELS, anthropicBaseUrl, assertCoverageModelSeparation, coerceStringifiedFields, createRequestAbortSignal, getRoleCallTelemetry, recordRoleCallTelemetry, resetRoleCallTelemetry, retryTransientOperation, structuredThinkingConfig } from "./llm.js";

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

describe("role-level LLM telemetry", () => {
  afterEach(() => resetRoleCallTelemetry());

  it("records attempts, failures and percentile latency separately for each role", () => {
    recordRoleCallTelemetry("coverage", 10, 1, false);
    recordRoleCallTelemetry("coverage", 30, 3, true);
    recordRoleCallTelemetry("validator", 20, 1, false);
    expect(getRoleCallTelemetry()).toMatchObject({
      coverage: { calls: 2, failures: 1, requests: 4, latency_ms: { p50: 10, p95: 30, max: 30 } },
      validator: { calls: 1, failures: 0, requests: 1, latency_ms: { p50: 20, p95: 20, max: 20 } },
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

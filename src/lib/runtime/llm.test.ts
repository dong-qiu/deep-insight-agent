/** coerceStringifiedFields 纯函数单测（6b 防御：模型偶发把 array/object 字段返成 JSON 字符串）。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { coerceStringifiedFields, createRequestAbortSignal } from "./llm.js";

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

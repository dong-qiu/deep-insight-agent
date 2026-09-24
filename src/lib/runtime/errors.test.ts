import { describe, expect, it } from "vitest";
import { isTransientApiError } from "./errors.js";
import { VolcengineResponsesError } from "./volcengine-responses.js";

describe("isTransientApiError（中转站瞬时错误 vs 模型层错误）", () => {
  it("Connection error 消息 → true（实测 security 0 洞察的真实情形）", () => {
    expect(isTransientApiError(new Error("Connection error."))).toBe(true);
  });

  it("超时/网络系统错误关键词 → true", () => {
    expect(isTransientApiError(new Error("Request timed out."))).toBe(true); // SDK 超时实际消息
    expect(isTransientApiError(new Error("LLM stream exceeded wall-clock timeout of 30000ms"))).toBe(true); // 本地 SSE 墙钟兜底
    expect(isTransientApiError(new Error('Unexpected event order, got message_start before receiving "message_stop"'))).toBe(true); // relay SSE 流序损坏
    expect(isTransientApiError(new Error("aborted due to timeout"))).toBe(true);
    expect(isTransientApiError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientApiError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
    expect(isTransientApiError(new Error("socket hang up"))).toBe(true);
    // Native fetch (used by the Responses adapter) surfaces connection loss with this exact
    // message rather than an Anthropic SDK error class.
    expect(isTransientApiError(new TypeError("fetch failed"))).toBe(true);
  });

  it("仅重试被 Responses 适配器显式标记的不完整 SSE 传输", () => {
    expect(isTransientApiError(new VolcengineResponsesError("stream ended before completion", undefined, true))).toBe(true);
    expect(isTransientApiError(new VolcengineResponsesError("missing function arguments"))).toBe(false);
  });

  it("模型拒答 / 解析失败 → false（应继续拆批隔离）", () => {
    expect(isTransientApiError(new Error("结构化输出解析失败（role=analyzer stop_reason=refusal）"))).toBe(false);
    expect(isTransientApiError(new Error("结构化输出解析失败（role=analyzer stop_reason=max_tokens）"))).toBe(false);
    expect(isTransientApiError(new Error("Schema validation failed: ..."))).toBe(false);
  });

  it("非 Error 输入 → false（安全降级）", () => {
    expect(isTransientApiError(null)).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
    expect(isTransientApiError("some string")).toBe(false);
    expect(isTransientApiError(42)).toBe(false);
  });
});

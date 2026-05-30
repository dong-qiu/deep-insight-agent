import { describe, expect, it } from "vitest";
import { isTransientApiError } from "./errors.js";

describe("isTransientApiError（中转站瞬时错误 vs 模型层错误）", () => {
  it("Connection error 消息 → true（实测 security 0 洞察的真实情形）", () => {
    expect(isTransientApiError(new Error("Connection error."))).toBe(true);
  });

  it("超时/网络系统错误关键词 → true", () => {
    expect(isTransientApiError(new Error("Request timed out."))).toBe(true); // SDK 超时实际消息
    expect(isTransientApiError(new Error("aborted due to timeout"))).toBe(true);
    expect(isTransientApiError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientApiError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
    expect(isTransientApiError(new Error("socket hang up"))).toBe(true);
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

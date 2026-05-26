import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter（固定窗口）", () => {
  it("窗口内放行至上限，超限拒绝", () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    const t = 1_000_000;
    expect([rl.allow("a", t), rl.allow("a", t), rl.allow("a", t)]).toEqual([true, true, true]);
    expect(rl.allow("a", t)).toBe(false); // 第 4 次超限
    expect(rl.remaining("a", t)).toBe(0);
  });

  it("窗口滚动后重置", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("a", 500)).toBe(false); // 同窗口
    expect(rl.allow("a", 1000)).toBe(true); // 新窗口
  });

  it("不同 key 独立计数", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("b", 0)).toBe(true);
  });
});

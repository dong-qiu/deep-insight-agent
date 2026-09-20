import { describe, expect, it } from "vitest";
import { parseLatencyLadderCounts, parseLatencyLadderOffset, selectLatencyLadderCase } from "./analyze-latency-ladder-lib.js";

describe("A1 analyze latency ladder planning", () => {
  it("accepts only an increasing positive ladder", () => {
    expect(parseLatencyLadderCounts("4,8,12,20")).toEqual([4, 8, 12, 20]);
    expect(() => parseLatencyLadderCounts("4,4")).toThrow("严格递增");
    expect(() => parseLatencyLadderCounts("0,4")).toThrow("正整数");
  });

  it("refuses to silently truncate a requested rung or use the wrong topic", () => {
    const cases = [{ topic: { id: "t1" }, items: [1, 2, 3, 4] }];
    expect(selectLatencyLadderCase(cases, "t1", [2, 4])).toBe(cases[0]);
    expect(() => selectLatencyLadderCase(cases, "missing", [2])).toThrow("未找到");
    expect(() => selectLatencyLadderCase(cases, "t1", [5])).toThrow("无法运行");
    expect(selectLatencyLadderCase(cases, "t1", [2], 2)).toBe(cases[0]);
    expect(() => selectLatencyLadderCase(cases, "t1", [3], 2)).toThrow("offset=2");
  });

  it("allows a non-negative offset only for an explicit failed-chunk replay", () => {
    expect(parseLatencyLadderOffset(undefined)).toBe(0);
    expect(parseLatencyLadderOffset("10")).toBe(10);
    expect(() => parseLatencyLadderOffset("-1")).toThrow("非负整数");
    expect(() => parseLatencyLadderOffset("1.5")).toThrow("非负整数");
  });
});

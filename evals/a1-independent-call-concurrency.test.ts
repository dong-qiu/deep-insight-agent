import { describe, expect, it } from "vitest";
import {
  a1IndependentCallConcurrency,
  DEFAULT_A1_INDEPENDENT_CALL_CONCURRENCY,
  mapA1IndependentCalls,
} from "./a1-independent-call-concurrency.js";

describe("A1 independent-call concurrency", () => {
  it("defaults to serial and permits only the reviewed low-concurrency experiment", () => {
    expect(a1IndependentCallConcurrency(undefined)).toBe(DEFAULT_A1_INDEPENDENT_CALL_CONCURRENCY);
    expect(a1IndependentCallConcurrency("2")).toBe(2);
    for (const invalid of ["0", "3", "1.5", "unbounded"]) {
      expect(() => a1IndependentCallConcurrency(invalid)).toThrow("A1_INDEPENDENT_CALL_CONCURRENCY");
    }
  });

  it("preserves source order while admitting no more than the configured number of calls", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapA1IndependentCalls(["first", "second", "third", "fourth"], 2, async (value) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value === "first" ? 8 : 1));
      inFlight--;
      return value.toUpperCase();
    });
    expect(result).toEqual(["FIRST", "SECOND", "THIRD", "FOURTH"]);
    expect(peak).toBe(2);
  });

  it("reports each settled result without changing the returned source order", async () => {
    const settled: Array<{ index: number; result: string }> = [];
    const result = await mapA1IndependentCalls(["first", "second", "third"], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === "first" ? 8 : 1));
      return value.toUpperCase();
    }, {
      onSettled: (value, index) => settled.push({ index, result: value }),
    });

    expect(result).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(settled).toEqual(expect.arrayContaining([
      { index: 0, result: "FIRST" },
      { index: 1, result: "SECOND" },
      { index: 2, result: "THIRD" },
    ]));
    expect(settled).toHaveLength(3);
  });
});

import { describe, expect, it, vi } from "vitest";
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

  it("reports only settled coordinates without changing the returned source order", async () => {
    const settled: number[] = [];
    const result = await mapA1IndependentCalls(["first", "second", "third"], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === "first" ? 8 : 1));
      return value.toUpperCase();
    }, {
      onSettled: (index) => { settled.push(index); },
    });

    expect(result).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(settled).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(settled).toHaveLength(3);
  });

  it("treats a progress-observer failure as best-effort telemetry rather than an evaluation failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(mapA1IndependentCalls(["only"], 1, async (value) => value.toUpperCase(), {
        onSettled: () => { throw new Error("observer disk unavailable"); },
      })).resolves.toEqual(["ONLY"]);
      expect(warning).toHaveBeenCalledWith("A1 independent-call progress hook failed; continuing evaluation");
    } finally {
      warning.mockRestore();
    }
  });

  it("consumes a later async observer rejection without delaying or failing the mapper", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(mapA1IndependentCalls(["only"], 1, async (value) => value.toUpperCase(), {
        onSettled: async () => {
          await Promise.resolve();
          throw new Error("observer failed later");
        },
      })).resolves.toEqual(["ONLY"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warning).toHaveBeenCalledWith("A1 independent-call progress hook failed; continuing evaluation");
    } finally {
      warning.mockRestore();
    }
  });
});

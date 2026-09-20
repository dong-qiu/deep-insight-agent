import { describe, expect, it } from "vitest";
import { a1SmokeMode, isA1Smoke, parseA1CaseLimit, selectA1Cases } from "./a1-case-limit.js";

describe("A1 eval subset controls", () => {
  const fixture = ["one", "two", "three"];

  it("treats an omitted or zero limit as a full, non-smoke selection", () => {
    expect(selectA1Cases(fixture, undefined, "A1_TEST_LIMIT")).toEqual({
      cases: fixture, requested_limit: 0, truncated: false,
    });
    expect(selectA1Cases(fixture, "0", "A1_TEST_LIMIT").truncated).toBe(false);
  });

  it("marks only an actual truncation as smoke", () => {
    expect(selectA1Cases(fixture, "2", "A1_TEST_LIMIT")).toEqual({
      cases: ["one", "two"], requested_limit: 2, truncated: true,
    });
    expect(selectA1Cases(fixture, "9", "A1_TEST_LIMIT").truncated).toBe(false);
  });

  it("does not let a truncated safety fixture masquerade as a full A1 run", () => {
    const full = selectA1Cases(fixture, "0", "A1_QUALITY_LIMIT");
    const limitedDisplay = selectA1Cases(fixture, "1", "A1_DISPLAY_COVERAGE_LIMIT");
    const limitedQuote = selectA1Cases(fixture, "1", "A1_QUOTE_SELF_CONTAINED_LIMIT");
    expect(isA1Smoke(full, full, full, full)).toBe(false);
    expect(isA1Smoke(full, full, limitedDisplay, full)).toBe(true);
    expect(isA1Smoke(full, full, full, limitedQuote)).toBe(true);
  });

  it("keeps the dedicated fast path non-promotable even for tiny fixtures", () => {
    const full = selectA1Cases(["only"], "1", "A1_TEST_LIMIT");
    expect(a1SmokeMode("1", full, full, full, full)).toBe(true);
    expect(a1SmokeMode("0", full, full, full, full)).toBe(false);
    expect(() => a1SmokeMode("yes", full)).toThrow("A1_FORCE_SMOKE");
  });

  it("rejects malformed and negative controls rather than silently changing evidence", () => {
    for (const raw of ["-1", "1.2", "not-a-number"]) {
      expect(() => parseA1CaseLimit(raw, "A1_TEST_LIMIT")).toThrow("A1_TEST_LIMIT");
    }
  });
});

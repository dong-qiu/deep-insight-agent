import { describe, expect, it } from "vitest";
import { A1_SMOKE_LIMITS, applyA1SmokeConfig } from "./a1-smoke-config.js";

describe("A1 fast smoke configuration", () => {
  it("overrides caller limits and always forces non-promotable smoke mode", () => {
    const env: Record<string, string | undefined> = {
      A1_QUALITY_LIMIT: "0",
      A1_CONSISTENCY_LIMIT: "100",
      A1_DISPLAY_COVERAGE_LIMIT: "0",
      A1_QUOTE_SELF_CONTAINED_LIMIT: "0",
      A1_DISPLAY_COVERAGE_IDS: "unexpected",
      A1_QUOTE_SELF_CONTAINED_IDS: "unexpected",
      A1_FORCE_SMOKE: "0",
    };
    applyA1SmokeConfig(env);
    expect(env).toMatchObject(A1_SMOKE_LIMITS);
    expect(env.A1_DISPLAY_COVERAGE_IDS).toBeUndefined();
    expect(env.A1_QUOTE_SELF_CONTAINED_IDS).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { A1_PROTOTYPE_SAFETY_LIMITS, applyA1PrototypeSafetyConfig } from "./a1-prototype-safety-config.js";

describe("prototype safety A1 configuration", () => {
  it("forces a bounded real-model path and selects display/quote positive and negative cases", () => {
    const env: Record<string, string | undefined> = { A1_FORCE_SMOKE: "0" };
    applyA1PrototypeSafetyConfig(env);
    expect(env).toMatchObject(A1_PROTOTYPE_SAFETY_LIMITS);
    expect(env.A1_FORCE_SMOKE).toBe("1");
    expect(env.A1_DISPLAY_COVERAGE_LIMIT).toBe("0");
    expect(env.A1_QUOTE_SELF_CONTAINED_LIMIT).toBe("0");
    expect(env.A1_DISPLAY_COVERAGE_IDS).toContain("controlled-poc-to-blackbox");
    expect(env.A1_DISPLAY_COVERAGE_IDS).toContain("generic-subject-direct-positive");
    expect(env.A1_QUOTE_SELF_CONTAINED_IDS).toContain("anaphora-it");
    expect(env.A1_QUOTE_SELF_CONTAINED_IDS).toContain("explicit-subject");
  });
});

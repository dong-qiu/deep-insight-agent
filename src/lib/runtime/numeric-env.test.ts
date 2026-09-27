import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeBodyChars, llmTimeoutMs, RuntimeConfigError, selectWindowChars, validationDegradedRate, validatorBackoffMs, validatorRetries } from "./env.js";

const settings = [
  { name: "ANALYZE_BODY_CHARS", get: analyzeBodyChars, fallback: 10_000, valid: [1, 100, 10_000], invalid: ["0", "1.5"] },
  { name: "SELECT_WINDOW_CHARS", get: selectWindowChars, fallback: 1_000, valid: [1, 8, 1_000], invalid: ["0", "0.1"] },
  { name: "VALIDATOR_RETRIES", get: validatorRetries, fallback: 2, valid: [0, 1, 2], invalid: ["1.5"] },
  { name: "VALIDATOR_RETRY_BACKOFF_MS", get: validatorBackoffMs, fallback: 800, valid: [0, 100, 800], invalid: ["0.5"] },
  { name: "VALIDATION_DEGRADED_ALERT_RATE", get: validationDegradedRate, fallback: 0.5, valid: [0, 0.25, 0.5, 1], invalid: ["1.01"] },
  { name: "LLM_TIMEOUT_MS", get: llmTimeoutMs, fallback: 120_000, valid: [1, 120_000, 2_147_483_647], invalid: ["0", "1.5", "2147483648"] },
];

afterEach(() => vi.unstubAllEnvs());

describe.each(settings)("$name numeric configuration", ({ name, get, fallback, valid, invalid }) => {
  it("keeps the existing absent default and reads valid values at call time", () => {
    vi.stubEnv(name, undefined);
    expect(get()).toBe(fallback);
    for (const value of valid) {
      vi.stubEnv(name, String(value));
      expect(get()).toBe(value);
    }
  });

  it.each(["", " ", "NaN", "Infinity", "-Infinity", "-1", "9007199254740992", "sensitive-invalid-value", ...invalid])("rejects explicit invalid input (%j) without echoing it", (raw) => {
    vi.stubEnv(name, raw);
    expect(get).toThrow(RuntimeConfigError);
    expect(get).toThrow(name);
    try { get(); } catch (error) {
      expect((error as Error).message).not.toContain("sensitive-invalid-value");
    }
  });
});

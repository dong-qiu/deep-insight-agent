import { describe, expect, it } from "vitest";
import {
  AI_REVIEW_DEFAULT_MAX_TOKENS,
  AI_REVIEW_MIN_MAX_TOKENS,
  aiReviewMaxTokens,
  aiReviewResponseBudgetVersion,
} from "./a1-ai-review-runtime.js";

describe("AI reviewer runtime configuration", () => {
  it("uses the existing response cap by default and records its version", () => {
    expect(aiReviewMaxTokens(undefined)).toBe(AI_REVIEW_DEFAULT_MAX_TOKENS);
    expect(aiReviewResponseBudgetVersion(1536)).toBe("output-1536-v1");
  });

  it("allows a bounded reduced cap that still accommodates validator thinking", () => {
    expect(aiReviewMaxTokens("1536")).toBe(AI_REVIEW_MIN_MAX_TOKENS);
  });

  it("fails closed for malformed or thinking-incompatible response caps", () => {
    expect(() => aiReviewMaxTokens("1535")).toThrow("至少");
    expect(() => aiReviewMaxTokens("1.5k")).toThrow("整数");
  });
});

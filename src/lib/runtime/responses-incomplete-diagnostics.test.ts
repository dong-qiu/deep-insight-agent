import { describe, expect, it } from "vitest";
import { readIncompleteDiagnostic, sanitizeIncompleteDiagnostic } from "./responses-incomplete-diagnostics.js";

describe("safe incomplete observations", () => {
  it.each(["max_output_tokens", "max_tokens", "content_filter"])("retains only allowlisted reason %s", (reason) => {
    expect(readIncompleteDiagnostic({ incomplete_details: { reason } }).reason).toBe(reason);
  });

  it("projects presence and reported numeric usage without private descriptions or IDs", () => {
    const result = readIncompleteDiagnostic({ id: "private-id", incomplete_details: {
      reason: "private-reason", content_filter: { type: "private-type", details: "private-source" },
    }, usage: { input_tokens: 11, output_tokens: 2048, output_tokens_details: { reasoning_tokens: 1900 } } });
    expect(result).toEqual({ reason: "other", reasonShape: "string", contentFilterPresent: true,
      usagePresent: true, inputTokens: 11, outputTokens: 2048, reasoningTokens: 1900 });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([undefined, null, [], "private-body", { usage: [] }, { incomplete_details: [] }])("does not turn absent/malformed usage into reported zero: %j", (body) => {
    expect(readIncompleteDiagnostic(body)).toEqual({ reasonShape: "missing", contentFilterPresent: false, usagePresent: false });
  });

  it("distinguishes invalid reason, explicit zero and invalid token values", () => {
    expect(readIncompleteDiagnostic({ incomplete_details: { reason: { secret: "private" }, content_filter: "private" },
      usage: { input_tokens: 0, output_tokens: -1, output_tokens_details: { reasoning_tokens: "2048" } } }))
      .toEqual({ reason: "other", reasonShape: "invalid", contentFilterPresent: false, usagePresent: true, inputTokens: 0 });
    for (const output_tokens of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
      expect(readIncompleteDiagnostic({ usage: { output_tokens } })).not.toHaveProperty("outputTokens");
    }
  });

  it("re-sanitizes mutated typed objects at persistence boundaries", () => {
    const result = sanitizeIncompleteDiagnostic({ reason: "private", reasonShape: "private", contentFilterPresent: "private",
      usagePresent: false, inputTokens: 10, requestId: "private", response: "private" });
    expect(result).toEqual({ reason: "other", reasonShape: "invalid", contentFilterPresent: false, usagePresent: false });
  });
});

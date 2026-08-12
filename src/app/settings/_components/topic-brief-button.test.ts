import { describe, expect, it } from "vitest";
import { generationTraceHref } from "./topic-brief-button.js";

describe("TopicBriefButton trace link", () => {
  it("keeps the trace route admin-scoped and path-safe", () => {
    expect(generationTraceHref("trace_abc123")).toBe("/api/generation-traces/trace_abc123");
    expect(generationTraceHref("trace/a b")).toBe("/api/generation-traces/trace%2Fa%20b");
  });
});

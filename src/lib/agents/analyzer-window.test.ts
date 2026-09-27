import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime/llm.js", () => ({
  callStructured: vi.fn(),
  assertCoverageModelSeparation: vi.fn(),
  MODELS: { analyzer: "test-analyzer", validator: "test-validator", coverage: "test-coverage" },
}));
import { chunkWindows } from "./analyzer.js";

// Frozen pre-change algorithm, evaluated only for valid positive integers.
function legacyWindows(body: string, size: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + size, body.length);
    if (end < body.length) {
      const sp = body.lastIndexOf(" ", end);
      if (sp > start) end = sp;
    }
    const seg = body.slice(start, end).trim();
    if (seg) out.push(seg);
    start = end;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Analyzer window configuration guard", () => {
  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid explicit size %s, including for empty input", (size) => {
    expect(() => chunkWindows("alpha beta", size)).toThrow(RangeError);
    expect(() => chunkWindows("", size)).toThrow(RangeError);
  });

  it("preserves window bytes and boundaries for valid sizes", () => {
    const bodies = ["", "single", "alpha beta gamma", "  alpha   beta\ngamma  ", "中文原文与English words混合。", "word ".repeat(1000), "x".repeat(2100)];
    for (const body of bodies) {
      for (const size of [1, 2, 8, 12, 1000, 10_000]) {
        expect(chunkWindows(body, size)).toEqual(legacyWindows(body, size));
        for (const window of chunkWindows(body, size)) expect(body).toContain(window);
      }
    }
  });

  it.each(["ANALYZE_BODY_CHARS", "SELECT_WINDOW_CHARS"])("rejects invalid %s when the actual analyzer module loads", async (name) => {
    vi.resetModules();
    vi.stubEnv(name, "-1");
    await expect(import("./analyzer.js")).rejects.toThrow(name);
  });

  it("keeps explicit legal lengths, including truncation and implicit window size", async () => {
    vi.resetModules();
    vi.stubEnv("ANALYZE_BODY_CHARS", "7");
    vi.stubEnv("SELECT_WINDOW_CHARS", "3");
    const analyzer = await import("./analyzer.js");
    expect(analyzer.ANALYZE_BODY_CHARS).toBe(7);
    expect(analyzer.SELECT_WINDOW_CHARS).toBe(3);
    expect(analyzer.truncateForAnalyze("abcdefghijk")).toBe("abcdefg");
    expect(analyzer.chunkWindows("alpha beta")).toEqual(legacyWindows("alpha beta", 3));
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quote-self-contained coverage benchmark", () => {
  it("keeps a separate manually-labelled quote-only negative set for Coverage calibration", () => {
    const fixture = JSON.parse(readFileSync("evals/dataset/quote-self-contained-benchmark.json", "utf8")) as {
      version: string;
      labeling_provenance: string;
      cases: Array<{ id: string; expected: "accept" | "reject"; quote: string; locator: string }>;
    };
    expect(fixture.version).toBe("quote-self-contained-v1");
    expect(fixture.labeling_provenance).toContain("manually labelled");
    expect(fixture.cases.filter((item) => item.expected === "reject")).toHaveLength(4);
    expect(fixture.cases.filter((item) => item.expected === "accept")).toHaveLength(4);
    expect(new Set(fixture.cases.map((item) => item.id)).size).toBe(fixture.cases.length);
    expect(fixture.cases.every((item) => item.quote.length > 0 && /^\d+:\d+:\d+$/.test(item.locator))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Case { id: string; expected: "accept" | "reject"; field: string; facets: string[]; }

describe("display coverage hand-labelled benchmark", () => {
  it("pins the historical expansion failures, bilingual bypasses, composite claims, and controlled evaluation anchors", () => {
    const data = JSON.parse(readFileSync("evals/dataset/display-coverage-benchmark.json", "utf8")) as { version: string; cases: Case[] };
    expect(data.version).toBe("display-coverage-v1");
    const rejected = new Set(data.cases.filter((c) => c.expected === "reject").map((c) => c.id));
    for (const id of [
      "controlled-poc-to-blackbox",
      "specbench-task-scope-to-universal",
      "kv-certification-to-not-merely-empirical",
      "llamaweb-combinations-to-edge-portability",
      "chinese-production-bypass",
      "composite-evidence-stitching",
      "bad-evaluation-anchor",
    ]) expect(rejected.has(id)).toBe(true);
    expect(data.cases.every((c) => c.field.length > 0 && c.facets.length > 0)).toBe(true);
  });
});

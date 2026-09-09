import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Case { id: string; expected: "accept" | "reject"; field: string; facets: string[]; statement_citation_index: number; }

describe("display coverage hand-labelled benchmark", () => {
  it("pins the historical expansion failures, bilingual bypasses, composite claims, and controlled evaluation anchors", () => {
    const data = JSON.parse(readFileSync("evals/dataset/display-coverage-benchmark.json", "utf8")) as { version: string; cases: Case[] };
    expect(data.version).toBe("display-coverage-v4");
    const rejected = new Set(data.cases.filter((c) => c.expected === "reject").map((c) => c.id));
    for (const id of [
      "controlled-poc-to-blackbox",
      "specbench-task-scope-to-universal",
      "kv-certification-to-not-merely-empirical",
      "llamaweb-combinations-to-edge-portability",
      "chinese-production-bypass",
      "composite-evidence-stitching",
      "statement-expands-bound-claim-with-automatic",
      "bound-claim-still-needs-quote-support",
      "bound-claim-cannot-supply-elided-scope",
      "bad-evaluation-anchor",
    ]) expect(rejected.has(id)).toBe(true);
    const accepted = new Set(data.cases.filter((c) => c.expected === "accept").map((c) => c.id));
    for (const id of [
      "recursive-chunking-direct-positive",
      "chinese-scoped-numeric-direct-positive",
      "headline-direct-positive",
    ]) expect(accepted.has(id)).toBe(true);
    expect(data.cases.every((c) => c.field.length > 0 && c.facets.length > 0 && c.statement_citation_index >= 1)).toBe(true);
  });
});

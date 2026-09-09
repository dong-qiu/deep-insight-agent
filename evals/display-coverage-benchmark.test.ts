import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Case {
  id: string;
  expected: "accept" | "reject";
  field: string;
  facets: string[];
  statement_citation_index: number;
  expected_statement?: string;
  citations: Array<{ quote: string }>;
}

describe("display coverage hand-labelled benchmark", () => {
  it("pins source-quote projection, unsafe expansions, and self-contained reader counterexamples", () => {
    const data = JSON.parse(readFileSync("evals/dataset/display-coverage-benchmark.json", "utf8")) as { version: string; cases: Case[] };
    expect(data.version).toBe("display-coverage-v6");
    const rejected = new Set(data.cases.filter((c) => c.expected === "reject").map((c) => c.id));
    for (const id of [
      "controlled-poc-to-blackbox",
      "kv-certification-to-not-merely-empirical",
      "llamaweb-combinations-to-edge-portability",
      "chinese-production-bypass",
      "composite-evidence-stitching",
      "statement-expands-bound-claim-with-automatic",
      "specbench-task-scope-to-universal",
      "bound-claim-still-needs-quote-support",
      "bound-claim-cannot-supply-elided-scope",
      "livepi-is-not-proven-benchmark",
      "stable-token-cannot-match-a-longer-substring",
      "generic-agent-cannot-become-coding-agent",
      "generic-gap-cannot-become-reward-hacking-gap",
      "generic-it-cannot-become-frontier-comparison",
      "bound-token-cannot-come-from-second-citation",
      "importance-fact-expansion-is-safely-cleared",
      "chinese-scoped-numeric-direct-positive",
      "controlled-evaluation-positive",
      "leading-it-quote-reject",
      "leading-the-gap-quote-reject",
      "inline-it-quote-reject",
      "former-latter-quote-reject",
      "respectively-quote-reject",
      "chinese-demonstrative-quote-reject",
      "our-approach-quote-reject",
      "full-system-quote-reject",
      "top-systems-quote-reject",
      "no-single-model-quote-reject",
      "int8-keys-quote-reject",
      "bad-evaluation-anchor",
    ]) expect(rejected.has(id)).toBe(true);
    const accepted = new Set(data.cases.filter((c) => c.expected === "accept").map((c) => c.id));
    for (const id of [
      "recursive-chunking-direct-positive",
      "headline-direct-positive",
      "generic-subject-direct-positive",
      "headline-expansion-is-safely-cleared",
      "source-quote-projects-correlation-not-causality",
      "source-quote-projects-synthetic-scope",
      "source-quote-projects-explicit-architecture",
      "source-quote-explicit-openai-positive",
      "source-quote-we-present-gsqa-positive",
    ]) expect(accepted.has(id)).toBe(true);
    expect(data.cases.every((c) => c.field.length > 0 && c.facets.length > 0 && c.statement_citation_index >= 1)).toBe(true);
    expect(data.cases.every((c) => c.expected === "reject" || (
      c.expected_statement === c.citations[c.statement_citation_index - 1]?.quote
    ))).toBe(true);
  });
});

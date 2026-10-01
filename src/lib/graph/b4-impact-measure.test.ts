import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { deriveCandidateGraph, pickEdgeWeightForBudget, selectGraph } from "./cooccurrence.js";
import { entitiesMentionedInStatement } from "../utils/reader-visible-entities.js";
import type { Entity } from "../types.js";

const require = createRequire(import.meta.url);
const { createCategorizer, graphCounts } = require("../../../ops/b4-visibility-impact.cjs") as {
  createCategorizer: (verifier: { check: (row: unknown) => string }) => {
    category: (row: { content_item_id: string; body: string; quote: string }) => string;
    byContent: Map<string, string>;
  };
  graphCounts: (rows: Array<{ statement: string; entities: string }>) => Record<string, number>;
};

it("B4 impact diagnostic checks every quote while reading a shared content archive once", () => {
  const verifier = { check: vi.fn(() => "v1_valid") };
  const { category, byContent } = createCategorizer(verifier);
  const current = { content_item_id: "ci_same", body: "Current model supports local execution.", quote: "local execution" };
  const stale = { ...current, quote: "cloud-only execution" };

  expect(category(stale)).toBe("quote_missing_from_current_body");
  expect(category(current)).toBe("v1_valid");
  expect(category(stale)).toBe("quote_missing_from_current_body");
  expect(verifier.check).toHaveBeenCalledTimes(1);
  expect(byContent.get("ci_same")).toBe("v1_valid");
});

it("B4 impact diagnostic matches a simple production graph fixture", () => {
  const rows: Array<{ statement: string; entities: Entity[] }> = [
    { statement: "OpenAI and Cursor released an agent", entities: [
      { name: "OpenAI", type: "organization" }, { name: "Cursor", type: "product" }, { name: "FAIR", type: "organization" }] },
    { statement: "OpenAI and Cursor tested it", entities: [
      { name: "OpenAI", type: "organization" }, { name: "Cursor", type: "product" }] },
    { statement: "Sakana AI described a model", entities: [
      { name: "Sakana AI", type: "organization" }, { name: "Sakana", type: "organization" }] },
  ];
  const filtered = rows.map((row) => ({ entities: entitiesMentionedInStatement(row.statement, row.entities) }));
  const candidate = deriveCandidateGraph(filtered);
  const threshold = pickEdgeWeightForBudget(filtered);
  const selected = selectGraph(candidate.nodes, candidate.candidateEdges, { minEdgeWeight: threshold });
  const measured = graphCounts(rows.map((row) => ({ statement: row.statement, entities: JSON.stringify(row.entities) })));
  expect(measured).toMatchObject({
    with_entities: filtered.filter((row) => row.entities.length > 0).length,
    candidate_nodes: candidate.nodes.length,
    candidate_edges: candidate.candidateEdges.length,
    default_threshold: threshold,
    default_nodes: selected.nodes.length,
    default_edges: selected.edges.length,
    node_drill_occurrences: candidate.nodes.reduce((sum, node) => sum + node.mentions, 0),
    candidate_edge_drill_occurrences: candidate.candidateEdges.reduce((sum, edge) => sum + edge.weight, 0),
    default_edge_drill_occurrences: selected.edges.reduce((sum, edge) => sum + edge.weight, 0),
  });
});

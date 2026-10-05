import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { summarize } from "../src/lib/agents/validator.js";
import type { AnalysisBatch, CitationCheck, Insight } from "../src/lib/types.js";
import type { CoverageDecision } from "../src/lib/agents/analyzer.js";
import {
  appendA1QualityCheckpointChunk, completeA1QualityCheckpointCase, createA1QualityCheckpoint,
  loadA1QualityCheckpoint, writeA1QualityCheckpoint,
} from "./a1-quality-checkpoint.js";

const context = {
  eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64),
  recovery_identity_sha256: "c".repeat(64),
};
const plan = [{ case_index: 0, topic_id: "synthetic", stratum: "arxiv", chunk_input_sha256: ["input"] }];
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function file() {
  const root = mkdtempSync(join(tmpdir(), "c4b-checkpoint-")); roots.push(root);
  return join(root, "quality-checkpoint.json");
}
const insight = { id: "synthetic-insight", citations: [{ content_item_id: "synthetic-item", quote: "synthetic quote" }] } as Insight;
const batch: AnalysisBatch = {
  id: "synthetic-batch", topic_id: "synthetic", time_window: { start: "", end: "" },
  status: "done", no_significant_event: false, insights: [insight],
};
const supported: CitationCheck = {
  insight_id: insight.id, citation_index: 0, reachability: "pass", reachability_reason: "ok",
  consistency: "support", consistency_reason: "ok", verdict: "pass",
};
function state() {
  const checkpoint = createA1QualityCheckpoint(context);
  appendA1QualityCheckpointChunk(checkpoint, plan, 0, { input_sha256: "input", insights: [], coverage_decisions: [], execution_complete: true });
  return checkpoint;
}

it("rejects missing or changed recovery judgment identity even with matching EvalConfig", () => {
  const path = file(); const checkpoint = state(); writeA1QualityCheckpoint(path, checkpoint);
  expect(() => loadA1QualityCheckpoint(path, { ...context, recovery_identity_sha256: "d".repeat(64) }, plan)).toThrow();
  const raw = JSON.parse(readFileSync(path, "utf8")); delete raw.recovery_identity_sha256;
  writeFileSync(path, JSON.stringify(raw));
  expect(() => loadA1QualityCheckpoint(path, context, plan)).toThrow();
});

it("does not complete or restore a topic with a failed reachable citation judge", () => {
  const failed: CitationCheck = { ...supported, consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "flagged" };
  const completed = { batch, validation: { checks: [failed], report: summarize([failed]) }, execution_complete: true as const };
  expect(() => completeA1QualityCheckpointCase(state(), plan, 0, completed)).toThrow();
  const checkpoint = state(); checkpoint.cases[0]!.completed = completed;
  const path = file(); writeA1QualityCheckpoint(path, checkpoint);
  expect(() => loadA1QualityCheckpoint(path, context, plan)).toThrow();
});

it.each([{ checks: [] }, { checks: [supported, supported] }])("rejects missing or duplicate citation checks ($checks)", ({ checks }) => {
  expect(() => completeA1QualityCheckpointCase(state(), plan, 0, {
    batch, validation: { checks, report: summarize(checks) }, execution_complete: true,
  })).toThrow();
});

it("accepts a deterministic unreachable rejection, uncertain and not_support without turning them into pass", () => {
  for (const check of [
    { ...supported, reachability: "fail", reachability_reason: "quote_not_in_source", consistency: "not_evaluated", consistency_reason: "not_evaluated", verdict: "blocked" },
    { ...supported, consistency: "uncertain", consistency_reason: "not_evaluated", verdict: "flagged" },
    { ...supported, consistency: "not_support", consistency_reason: "exaggeration", verdict: "blocked" },
  ] as CitationCheck[]) {
    const checkpoint = state();
    completeA1QualityCheckpointCase(checkpoint, plan, 0, { batch, validation: { checks: [check], report: summarize([check]) }, execution_complete: true });
    const path = file(); writeA1QualityCheckpoint(path, checkpoint);
    expect(loadA1QualityCheckpoint(path, context, plan).cases[0]!.completed!.validation.checks).toEqual([check]);
  }
});

it.each(["dropped_coverage_error", "dropped_truncated"] as const)("does not checkpoint incomplete analyzer coverage (%s)", (terminal_reason) => {
  const decision: CoverageDecision = { candidate_id: "synthetic-candidate", gate_version: "display-coverage-v6", terminal_reason, claims: [] };
  expect(() => appendA1QualityCheckpointChunk(createA1QualityCheckpoint(context), plan, 0, {
    input_sha256: "input", insights: [], coverage_decisions: [decision], execution_complete: true,
  })).toThrow();
});

it("rejects infrastructure failure hidden in a degraded optional claim", () => {
  const decision: CoverageDecision = {
    candidate_id: "synthetic-candidate", gate_version: "display-coverage-v6", terminal_reason: "kept_degraded",
    claims: [{ claim_id: "headline:1", field: "headline", text: "synthetic", kind: "factual", supports: false,
      citation_indexes: [], evidence_spans: [], reason: "primary_unavailable" }],
  };
  expect(() => appendA1QualityCheckpointChunk(createA1QualityCheckpoint(context), plan, 0, {
    input_sha256: "input", insights: [], coverage_decisions: [decision], execution_complete: true,
  })).toThrow();
});

it("rejects an incomplete source audit hidden under a repaired reader-language decision", () => {
  const decision: CoverageDecision = {
    candidate_id: "synthetic-candidate", gate_version: "display-coverage-v6", terminal_reason: "kept",
    claims: [], reader_language_repair: { status: "repaired", prompt_hash: "hash", source_draft_sha256: "hash",
      source_audit_input_hash: "hash", source_claims: [{ claim_id: "statement:1", field: "statement", text: "synthetic",
        kind: "factual", supports: false, citation_indexes: [], evidence_spans: [], reason: "primary_unavailable" }] },
  };
  expect(() => appendA1QualityCheckpointChunk(createA1QualityCheckpoint(context), plan, 0, {
    input_sha256: "input", insights: [], coverage_decisions: [decision], execution_complete: true,
  })).toThrow();
});

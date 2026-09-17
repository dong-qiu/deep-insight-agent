import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  addCandidateCheckpointProbeMetrics,
  appendCandidateCheckpointBatch,
  assertCandidateCheckpointProbeIntegrity,
  candidateFeasibilityEdgeProvenanceSha256,
  candidateCheckpointPath,
  createCandidateCheckpoint,
  loadCandidateCheckpoint,
  writeCandidateCheckpoint,
  type CandidateCheckpointContext,
  type CandidateCheckpointBatchPlan,
} from "./a1-consistency-candidate-checkpoint.js";
import { consistencyPairHash } from "./a1-consistency-label-receipt.js";
import { candidateFeasibilityProbeId, type CandidateIntent } from "./a1-consistency-label-candidate-plan.js";

const digest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const intents: CandidateIntent[] = ["support", "uncertain", "exaggeration", "out_of_context", "misattribution"];
const context: CandidateCheckpointContext = {
  quality_input_sha256: digest("quality"), candidate_input_sha256: digest("inputs"), probe_matrix_sha256: digest("matrix"), slot_plan_sha256: digest("slots"), matcher_version: "matcher-v1",
  model: "analyzer", prompt_version: "v1", prompt_sha256: digest("prompt"), generator_response_schema_sha256: digest("generator-schema"), generator_thinking: false,
  generator_batch_size: 5, generator_max_tokens: 8000,
  calibration_model: "validator", calibration_thinking: false, calibration_prompt_version: "v1", calibration_prompt_sha256: digest("calibration"), calibration_response_schema_sha256: digest("calibration-schema"), calibration_max_tokens: 5000,
  calibration_max_generation_attempts: 3, calibration_minimum_drafts_per_attempt: 3, calibration_maximum_drafts_per_attempt: 5,
  generator_max_returned_drafts_per_attempt: 12, generator_max_structural_response_attempts: 2, structured_transport_version: "transport-v1",
};
const sourceText = (id: string): string => `The complete controlled source excerpt for ${id}.`;
const coordinate = (id: string) => ({
  id, topic_id: `topic-${id}`, source_id: `source-${id}`,
  source_text_sha256: digest(sourceText(id)), source_body_sha256: digest(`body-${id}`),
});
const checkpointCandidate = (id: string) => ({ ...coordinate(id), probes: probes(id) });
const plan: CandidateCheckpointBatchPlan[] = [
  { start: 0, candidates: [coordinate("one"), coordinate("two")] },
  { start: 2, candidates: [coordinate("three")] },
];
const probes = (id: string) => intents.map((intent) => {
  const statement = `A complete ${intent} statement 1.`;
  const probe_id = candidateFeasibilityProbeId(id, intent);
  const edge = {
    intent, statement, statement_sha256: digest(statement), source_text_sha256: digest(sourceText(id)), pair_sha256: consistencyPairHash({ id, statement, source_text: sourceText(id) }), calibration_provenance_sha256: "", requested_intent: intent, observed_intent: intent,
  };
  return {
    probe_id, intent,
    attempts: [{ drafts: [1, 2, 3].map((index) => ({ statement: `A complete ${intent} statement ${index}.`, observed_intent: intent })) }],
    feasible_edge: { ...edge, calibration_provenance_sha256: candidateFeasibilityEdgeProvenanceSha256(edge, id, probe_id, context) },
  };
});

describe("consistency candidate checkpoint", () => {
  it("persists only complete probe prefixes and rejects input, matcher, model, Thinking, and transport drift", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-checkpoint-"));
    const path = candidateCheckpointPath(join(root, "candidates.local.jsonl"));
    const checkpoint = createCandidateCheckpoint(context);
    appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0,
      candidates: [checkpointCandidate("one"), checkpointCandidate("two")],
    });
    writeCandidateCheckpoint(path, checkpoint);

    expect(loadCandidateCheckpoint(path, context, plan)?.completed_batches).toHaveLength(1);
    expect(() => assertCandidateCheckpointProbeIntegrity(checkpoint.completed_batches.flatMap((batch) => batch.candidates), [
      { id: "one", source_text: sourceText("one") }, { id: "two", source_text: sourceText("two") },
    ], context)).not.toThrow();
    expect(() => loadCandidateCheckpoint(path, { ...context, generator_batch_size: 10 }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, matcher_version: "other-matcher" }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, slot_plan_sha256: digest("other-slots") }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, calibration_model: "other-validator" }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, calibration_thinking: true }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, generator_response_schema_sha256: digest("other-generator-schema") }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, calibration_response_schema_sha256: digest("other-calibration-schema") }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, structured_transport_version: "transport-v2" }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, context, [{ start: 0, candidates: [coordinate("one"), coordinate("other")] }, plan[1]!])).toThrow("连续完整前缀");
  });

  it("rejects a v2 checkpoint and skipped, incomplete, or uncalibrated probe batches", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-checkpoint-v2-"));
    const path = candidateCheckpointPath(join(root, "candidates.local.jsonl"));
    writeFileSync(path, JSON.stringify({ schema_version: "a1-v2-consistency-candidate-checkpoint-v2", completed_batches: [] }));
    expect(() => loadCandidateCheckpoint(path, context, plan)).toThrow("不匹配");

    const checkpoint = createCandidateCheckpoint(context);
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 2, candidates: [checkpointCandidate("three")],
    })).toThrow("下一个完整批次");
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0, candidates: [{ ...coordinate("one"), probes: probes("one").slice(1) }, checkpointCandidate("two")],
    })).toThrow("下一个完整批次");
    const overBudget = checkpointCandidate("one");
    overBudget.probes[0]!.attempts = Array.from({ length: context.calibration_max_generation_attempts + 1 }, () => overBudget.probes[0]!.attempts[0]!);
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0, candidates: [overBudget, checkpointCandidate("two")],
    })).toThrow("下一个完整批次");
    const overDrafts = checkpointCandidate("one");
    overDrafts.probes[0]!.attempts[0]!.drafts = Array.from({ length: context.calibration_maximum_drafts_per_attempt + 1 }, (_, index) => ({
      statement: `A structurally valid but over-budget draft ${index}.`, observed_intent: overDrafts.probes[0]!.intent,
    }));
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0, candidates: [overDrafts, checkpointCandidate("two")],
    })).toThrow("下一个完整批次");
  });

  it("rejects a restored edge whose statement, probe identity, observation, or provenance was tampered", () => {
    const candidate = checkpointCandidate("one");
    const integrity = () => assertCandidateCheckpointProbeIntegrity([candidate], [{ id: "one", source_text: sourceText("one") }], context);
    expect(integrity).not.toThrow();

    candidate.probes[0]!.feasible_edge!.statement = "Injected but uncalibrated statement.";
    expect(integrity).toThrow("hash/provenance");
    candidate.probes[0] = probes("one")[0]!;

    candidate.probes[0]!.probe_id = "probe_tampered";
    expect(integrity).toThrow("probe id");
    candidate.probes[0] = probes("one")[0]!;

    candidate.probes[0]!.attempts[0]!.drafts[0]!.observed_intent = "support";
    if (candidate.probes[0]!.intent === "support") candidate.probes[0]!.attempts[0]!.drafts[0]!.observed_intent = "uncertain";
    expect(integrity).toThrow("not independently calibrated");
    candidate.probes[0] = probes("one")[0]!;

    candidate.probes[0]!.feasible_edge!.calibration_provenance_sha256 = digest("tampered");
    expect(integrity).toThrow("hash/provenance");
  });

  it("persists aggregate probe metrics so a missing paired diagnostic can be recreated byte-for-byte", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-checkpoint-metrics-"));
    const path = candidateCheckpointPath(join(root, "candidates.local.jsonl"));
    const checkpoint = createCandidateCheckpoint(context);
    addCandidateCheckpointProbeMetrics(checkpoint, {
      generation_calls: 17, structural_response_retries: 3, calibration_calls: 14, retry_probe_attempts: 9,
    });
    writeCandidateCheckpoint(path, checkpoint);
    const restored = loadCandidateCheckpoint(path, context, plan)!;
    expect(restored.probe_metrics).toEqual(checkpoint.probe_metrics);
    const firstCompanionBytes = Buffer.from(`${JSON.stringify({ calibration: { probe_metrics: checkpoint.probe_metrics } }, null, 2)}\n`);
    const recoveredCompanionBytes = Buffer.from(`${JSON.stringify({ calibration: { probe_metrics: restored.probe_metrics } }, null, 2)}\n`);
    expect(recoveredCompanionBytes.equals(firstCompanionBytes)).toBe(true);
  });
});

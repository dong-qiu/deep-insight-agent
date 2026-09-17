import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendCandidateCheckpointBatch,
  candidateCheckpointPath,
  createCandidateCheckpoint,
  loadCandidateCheckpoint,
  writeCandidateCheckpoint,
  type CandidateCheckpointContext,
  type CandidateCheckpointBatchPlan,
} from "./a1-consistency-candidate-checkpoint.js";

const context: CandidateCheckpointContext = {
  quality_input_sha256: "quality", candidate_input_sha256: "inputs", model: "analyzer",
  prompt_version: "v1", prompt_sha256: "prompt", generator_batch_size: 5,
  calibration_model: "validator", calibration_thinking: false, calibration_prompt_version: "v1",
  calibration_prompt_sha256: "calibration", calibration_max_generation_attempts: 3, calibration_minimum_drafts_per_attempt: 3, generator_max_returned_drafts_per_attempt: 12, generator_max_structural_response_attempts: 2,
};
const plan: CandidateCheckpointBatchPlan[] = [
  { start: 0, ids: ["one", "two"] },
  { start: 2, ids: ["three"] },
];

describe("consistency candidate checkpoint", () => {
  it("persists only complete prefix batches and rejects input/configuration drift", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-checkpoint-"));
    const path = candidateCheckpointPath(join(root, "candidates.local.jsonl"));
    const checkpoint = createCandidateCheckpoint(context);
    appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0,
      candidates: [{ id: "one", statement: "One complete statement." }, { id: "two", statement: "Two complete statement." }],
    });
    writeCandidateCheckpoint(path, checkpoint);

    expect(loadCandidateCheckpoint(path, context, plan)?.completed_batches).toHaveLength(1);
    expect(() => loadCandidateCheckpoint(path, { ...context, generator_batch_size: 10 }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, calibration_model: "other-validator" }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, calibration_minimum_drafts_per_attempt: 2 }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, generator_max_returned_drafts_per_attempt: 10 }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, { ...context, generator_max_structural_response_attempts: 3 }, plan)).toThrow("不匹配");
    expect(() => loadCandidateCheckpoint(path, context, [{ start: 0, ids: ["one", "other"] }, plan[1]!])).toThrow("连续完整前缀");
  });

  it("refuses skipped or incomplete batches", () => {
    const checkpoint = createCandidateCheckpoint(context);
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 2, candidates: [{ id: "three", statement: "Three complete statement." }],
    })).toThrow("下一个完整批次");
    expect(() => appendCandidateCheckpointBatch(checkpoint, plan, {
      start: 0, candidates: [{ id: "one", statement: "Too short" }],
    })).toThrow("下一个完整批次");
  });
});

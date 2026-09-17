import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  appendCandidateCheckpointBatch,
  candidateFeasibilityEdgeProvenanceSha256,
  createCandidateCheckpoint,
  setCandidateCheckpointSelectedMatching,
  type CandidateCheckpointContext,
} from "./a1-consistency-candidate-checkpoint.js";
import { consistencyPairHash } from "./a1-consistency-label-receipt.js";
import { candidateFeasibilityProbeId, MATCHER_VERSION, plannedSourceIntentSlots, type CandidateIntent } from "./a1-consistency-label-candidate-plan.js";
import { assertCompletedCandidateManifest, makeConsistencyBlindWorklist, readConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};
const intents: CandidateIntent[] = ["support", "uncertain", "exaggeration", "out_of_context", "misattribution"];
const digest = (seed: string): string => hash(`blind-worklist:${seed}`);
const context: CandidateCheckpointContext = {
  quality_input_sha256: digest("quality"), candidate_input_sha256: digest("candidate-input"), probe_matrix_sha256: digest("probes"), slot_plan_sha256: digest("slots"),
  matcher_version: MATCHER_VERSION, model: "analyzer-model", prompt_version: "generator-v1", prompt_sha256: digest("generator-prompt"),
  generator_response_schema_sha256: digest("generator-schema"), generator_thinking: false, generator_batch_size: 20, generator_max_tokens: 8000,
  calibration_model: "validator-model", calibration_thinking: false, calibration_prompt_version: "calibration-v1", calibration_prompt_sha256: digest("calibration-prompt"),
  calibration_response_schema_sha256: digest("calibration-schema"), calibration_max_tokens: 5000,
  calibration_max_generation_attempts: 5, calibration_minimum_drafts_per_attempt: 3, calibration_maximum_drafts_per_attempt: 5,
  generator_max_returned_drafts_per_attempt: 12, generator_max_structural_response_attempts: 2, structured_transport_version: "structured-v1",
};

type TestCandidate = {
  id: string; topic_id: string; source_id: string; selected_intent: CandidateIntent;
  statement: string; alternate_statement: string; source_text: string; source_body_sha256: string;
};

function candidates(): TestCandidate[] {
  const output: TestCandidate[] = [];
  for (let topic = 0; topic < 5; topic++) {
    const items = ["a", "b"].flatMap((source) => Array.from({ length: 10 }, (_, index) => ({
      id: `t${topic}-${source}-${index}`, topic_id: `topic-${topic}`, source_id: `source-${source}`,
    })));
    const slots = plannedSourceIntentSlots(items);
    for (const source of ["a", "b"]) {
      const sourceItems = items.filter((item) => item.source_id === `source-${source}`);
      const selectedIntents = intents.flatMap((intent) => Array.from({ length: slots.get(`source-${source}`)![intent] }, () => intent));
      sourceItems.forEach((item, index) => {
        const selectedIntent = selectedIntents[index]!;
        output.push({
          ...item, selected_intent: selectedIntent,
          statement: `Selected ${selectedIntent} statement for ${item.id}.`,
          alternate_statement: `Alternative ${intents.find((intent) => intent !== selectedIntent)!} statement for ${item.id}.`,
          source_text: `Complete controlled source excerpt for ${item.id}.`, source_body_sha256: digest(`body:${item.id}`),
        });
      });
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

const row = (pair: TestCandidate) => ({
  id: pair.id, statement: pair.statement, source_text: pair.source_text, source_body_sha256: pair.source_body_sha256,
});

function checkpointBytes(population: readonly TestCandidate[]): Buffer {
  const checkpoint = createCandidateCheckpoint(context);
  const batchCandidates = population.map((pair) => ({
    id: pair.id, topic_id: pair.topic_id, source_id: pair.source_id,
    source_text_sha256: hash(pair.source_text), source_body_sha256: pair.source_body_sha256,
    probes: intents.map((intent) => {
      const statement = intent === pair.selected_intent ? pair.statement : `Alternative ${intent} statement for ${pair.id}.`;
      const probeId = candidateFeasibilityProbeId(pair.id, intent);
      const edge = {
        intent, statement, statement_sha256: hash(statement), source_text_sha256: hash(pair.source_text),
        pair_sha256: consistencyPairHash({ id: pair.id, statement, source_text: pair.source_text }), calibration_provenance_sha256: "",
        requested_intent: intent, observed_intent: intent,
      };
      return {
        probe_id: probeId, intent,
        attempts: [{ drafts: [statement, `${statement} Draft two.`, `${statement} Draft three.`].map((draft) => ({ statement: draft, observed_intent: intent })) }],
        feasible_edge: { ...edge, calibration_provenance_sha256: candidateFeasibilityEdgeProvenanceSha256(edge, pair.id, probeId, context) },
      };
    }),
  }));
  appendCandidateCheckpointBatch(checkpoint, [{ start: 0, candidates: batchCandidates.map(({ probes: _probes, ...coordinate }) => coordinate) }], {
    start: 0, candidates: batchCandidates,
  });
  setCandidateCheckpointSelectedMatching(checkpoint, population.map((pair) => ({
    id: pair.id, topic_id: pair.topic_id, source_id: pair.source_id, intent: pair.selected_intent,
    pair_sha256: consistencyPairHash({ id: pair.id, statement: pair.statement, source_text: pair.source_text }),
  })));
  return Buffer.from(`${JSON.stringify(checkpoint)}\n`);
}

function completedManifest(rows: readonly ReturnType<typeof row>[], candidateBytes: Buffer, candidateCheckpointBytes: Buffer) {
  const worklist = makeConsistencyBlindWorklist(rows);
  return {
    schema_version: "a1-v2-consistency-candidate-diagnostic-v3", matcher_version: MATCHER_VERSION,
    status: "completed_feasibility_match", candidate_output_written: true, blind_worklist_written: false,
    candidate_output_sha256: hash(candidateBytes), candidate_checkpoint_sha256: hash(candidateCheckpointBytes), candidate_count: rows.length,
    quality_input_sha256: context.quality_input_sha256, candidate_input_sha256: context.candidate_input_sha256,
    probe_matrix_sha256: context.probe_matrix_sha256, slot_plan_sha256: context.slot_plan_sha256,
    candidate_pair_hashes_sha256: hash(stable(worklist.map(({ id, pair_sha256 }) => ({ id, pair_sha256 })))),
    generator: {
      model: context.model, thinking: context.generator_thinking, prompt_version: context.prompt_version, prompt_sha256: context.prompt_sha256,
      response_schema_sha256: context.generator_response_schema_sha256, batch_size: context.generator_batch_size, max_tokens: context.generator_max_tokens,
      maximum_returned_drafts_per_attempt: context.generator_max_returned_drafts_per_attempt,
      maximum_structural_response_attempts: context.generator_max_structural_response_attempts,
    },
    calibration: {
      model: context.calibration_model, thinking: context.calibration_thinking, prompt_version: context.calibration_prompt_version, prompt_sha256: context.calibration_prompt_sha256,
      response_schema_sha256: context.calibration_response_schema_sha256, max_tokens: context.calibration_max_tokens,
      max_generation_attempts: context.calibration_max_generation_attempts, minimum_drafts_per_attempt: context.calibration_minimum_drafts_per_attempt,
      maximum_drafts_per_attempt: context.calibration_maximum_drafts_per_attempt,
      maximum_returned_drafts_per_attempt: context.generator_max_returned_drafts_per_attempt,
      structured_transport_version: context.structured_transport_version,
    },
  };
}

describe("v2 consistency blind worklist", () => {
  it("keeps only the source pair and its stable binding hash", () => {
    const pair = row(candidates()[0]!);
    expect(makeConsistencyBlindWorklist([pair])).toEqual([{
      id: pair.id, statement: pair.statement, source_text: pair.source_text, pair_sha256: consistencyPairHash(pair),
    }]);
  });

  it("rejects a leaked label or diagnostic field and duplicate case ids", () => {
    const pair = row(candidates()[0]!);
    expect(() => makeConsistencyBlindWorklist([{ ...pair, expected_consistency: "support" }])).toThrow(/标签或生成诊断字段/);
    expect(() => makeConsistencyBlindWorklist([{ ...pair, future_diagnostic: "must fail closed" }])).toThrow(/标签或生成诊断字段/);
    expect(() => makeConsistencyBlindWorklist([pair, pair])).toThrow(/重复 id/);
  });

  it("accepts only a hash-bound persisted worklist, not a candidate or a label-bearing row", () => {
    const pair = row(candidates()[0]!);
    const worklist = makeConsistencyBlindWorklist([pair]);
    expect(readConsistencyBlindWorklist(worklist)).toEqual(worklist);
    expect(() => readConsistencyBlindWorklist([{ ...worklist[0], pair_sha256: "b".repeat(64) }])).toThrow(/pair_sha256/);
    expect(() => readConsistencyBlindWorklist([{ ...worklist[0], expected_consistency: "support" }])).toThrow(/标签或非 worklist 字段/);
    expect(() => readConsistencyBlindWorklist([pair])).toThrow(/标签或非 worklist 字段/);
  });

  it("requires a completed manifest plus its exact v5 feasibility checkpoint, matching, and source-body hash", () => {
    const population = candidates();
    const rows = population.map(row);
    const bytes = Buffer.from(`${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const checkpoint = checkpointBytes(population);
    const manifest = completedManifest(rows, bytes, checkpoint);
    expect(() => assertCompletedCandidateManifest(manifest, bytes, checkpoint, rows)).not.toThrow();
    expect(() => assertCompletedCandidateManifest({ ...manifest, status: "failed_matching" }, bytes, checkpoint, rows)).toThrow(/未完成匹配/);
    expect(() => assertCompletedCandidateManifest(manifest, Buffer.from(`${JSON.stringify({ ...rows[0]!, statement: "Changed candidate statement." })}\n`), checkpoint, rows)).toThrow(/不一致/);
    expect(() => assertCompletedCandidateManifest({ ...manifest, candidate_checkpoint_sha256: hash("{}") }, bytes, Buffer.from("{}"), rows)).toThrow(/checkpoint/);
    expect(() => assertCompletedCandidateManifest(manifest, bytes, checkpoint, [{ ...rows[0]!, source_body_sha256: "not-a-hash" }, ...rows.slice(1)])).toThrow(/source_body_sha256/);
  });

  it("rejects a self-declared completed manifest whose calibration, schema, matching, or selected pair differs from the checkpoint", () => {
    const population = candidates();
    const rows = population.map(row);
    const bytes = Buffer.from(`${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const checkpoint = checkpointBytes(population);
    const manifest = completedManifest(rows, bytes, checkpoint);
    expect(() => assertCompletedCandidateManifest({ ...manifest, matcher_version: "other-matcher" }, bytes, checkpoint, rows)).toThrow(/未完成匹配/);
    expect(() => assertCompletedCandidateManifest({ ...manifest, calibration: { ...manifest.calibration, response_schema_sha256: digest("forged-schema") } }, bytes, checkpoint, rows)).toThrow(/模型、schema 或匹配绑定/);
    expect(() => assertCompletedCandidateManifest({ ...manifest, generator: { ...manifest.generator, thinking: true } }, bytes, checkpoint, rows)).toThrow(/模型、schema 或匹配绑定/);

    const changed = rows.map((entry, index) => index === 0 ? { ...entry, statement: population[0]!.alternate_statement } : entry);
    const changedBytes = Buffer.from(`${changed.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const forged = completedManifest(changed, changedBytes, checkpoint);
    expect(() => assertCompletedCandidateManifest(forged, changedBytes, checkpoint, changed)).toThrow(/最终受限 matching 所选 pair/);
  });
});

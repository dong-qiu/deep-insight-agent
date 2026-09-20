import { consistencyPairHash } from "./a1-consistency-label-receipt.js";
import { createHash } from "node:crypto";
import { assertCandidateCheckpointCandidateProjection, type CandidateCheckpointOutputRow } from "./a1-consistency-candidate-checkpoint.js";
import { MATCHER_VERSION } from "./a1-consistency-label-candidate-plan.js";

export interface BlindWorklistCandidate {
  id: string;
  statement: string;
  source_text: string;
}

export interface BlindWorklistRow extends BlindWorklistCandidate {
  pair_sha256: string;
}

const allowedCandidateFields = new Set(["id", "statement", "source_text", "source_body_sha256"]);
const allowedWorklistFields = new Set(["id", "statement", "source_text", "pair_sha256"]);
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};

/**
 * Create the only pair fields a blind reviewer needs. The generator's source/topic metadata and
 * every label-like field are deliberately excluded, so this output can be given to each reviewer.
 */
export function makeConsistencyBlindWorklist(rows: readonly unknown[]): BlindWorklistRow[] {
  const ids = new Set<string>();
  return rows.map((value, index) => {
    if (value == null || typeof value !== "object") throw new Error(`candidate row ${index} 不是对象`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !allowedCandidateFields.has(key))) {
      throw new Error(`candidate row ${index} 含标签或生成诊断字段，不能用于盲标`);
    }
    if (typeof row.id !== "string" || !row.id.trim() || typeof row.statement !== "string" || !row.statement.trim()
      || typeof row.source_text !== "string" || !row.source_text.trim()
      || typeof row.source_body_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.source_body_sha256)) {
      throw new Error(`candidate row ${index} 缺少 id、statement、source_text 或 source_body_sha256`);
    }
    if (ids.has(row.id)) throw new Error(`candidate 含重复 id：${row.id}`);
    ids.add(row.id);
    const candidate = { id: row.id, statement: row.statement, source_text: row.source_text, source_body_sha256: row.source_body_sha256 };
    return { id: candidate.id, statement: candidate.statement, source_text: candidate.source_text, pair_sha256: consistencyPairHash(candidate) };
  });
}

/**
 * Read an already-created blind worklist without treating its binding hash as a leaked label.
 * This is deliberately separate from `makeConsistencyBlindWorklist`: the latter accepts only
 * generator candidates, whereas consumers must accept exactly the persisted pair projection
 * and re-derive its hash before sending any row to a reviewer or adjudicator.
 */
export function readConsistencyBlindWorklist(rows: readonly unknown[]): BlindWorklistRow[] {
  const ids = new Set<string>();
  return rows.map((value, index) => {
    if (value == null || typeof value !== "object") throw new Error(`blind worklist row ${index} 不是对象`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !allowedWorklistFields.has(key))) {
      throw new Error(`blind worklist row ${index} 含标签或非 worklist 字段，不能用于盲标`);
    }
    if (typeof row.id !== "string" || !row.id.trim() || typeof row.statement !== "string" || !row.statement.trim()
      || typeof row.source_text !== "string" || !row.source_text.trim() || typeof row.pair_sha256 !== "string") {
      throw new Error(`blind worklist row ${index} 缺少 id、statement、source_text 或 pair_sha256`);
    }
    if (ids.has(row.id)) throw new Error(`blind worklist 含重复 id：${row.id}`);
    ids.add(row.id);
    const candidate = { id: row.id, statement: row.statement, source_text: row.source_text };
    if (row.pair_sha256 !== consistencyPairHash(candidate)) {
      throw new Error(`blind worklist row ${index} pair_sha256 与原文-结论对不一致`);
    }
    return { ...candidate, pair_sha256: row.pair_sha256 };
  });
}

/**
 * A candidate file may reach blind review only through a completed feasibility manifest that
 * binds both its exact bytes and its pair population. This rejects hand-assembled or failed
 * matching outputs before they become reviewer input.
 */
export function assertCompletedCandidateManifest(
  manifest: unknown,
  candidateBytes: Buffer,
  checkpointBytes: Buffer,
  rows: readonly unknown[],
): void {
  if (manifest == null || typeof manifest !== "object") throw new Error("候选缺少可解析的 feasibility diagnostic");
  const diagnostic = manifest as Record<string, unknown>;
  if (diagnostic.schema_version !== "a1-v2-consistency-candidate-diagnostic-v3" || diagnostic.matcher_version !== MATCHER_VERSION
    || diagnostic.status !== "completed_feasibility_match" || diagnostic.candidate_output_written !== true || diagnostic.blind_worklist_written !== false) {
    throw new Error("候选 feasibility diagnostic 未完成匹配，不能创建盲审 worklist");
  }
  if (diagnostic.candidate_output_sha256 !== hash(candidateBytes) || diagnostic.candidate_checkpoint_sha256 !== hash(checkpointBytes)
    || diagnostic.candidate_count !== rows.length
    || ["quality_input_sha256", "candidate_input_sha256", "probe_matrix_sha256", "slot_plan_sha256"].some((key) => typeof diagnostic[key] !== "string" || !/^[a-f0-9]{64}$/u.test(diagnostic[key] as string))) {
    throw new Error("候选文件与 completed feasibility diagnostic 不一致");
  }
  const pairs = makeConsistencyBlindWorklist(rows);
  const pairPopulationHash = hash(stable(pairs.map(({ id, pair_sha256 }) => ({ id, pair_sha256 }))));
  if (diagnostic.candidate_pair_hashes_sha256 !== pairPopulationHash) {
    throw new Error("候选 pair population 与 completed feasibility diagnostic 不一致");
  }
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  } catch {
    throw new Error("candidate checkpoint 无法解析，不能创建盲审 worklist");
  }
  assertCandidateCheckpointCandidateProjection(checkpoint, rows as CandidateCheckpointOutputRow[]);
  const bound = checkpoint as Record<string, unknown>;
  if (bound.quality_input_sha256 !== diagnostic.quality_input_sha256 || bound.candidate_input_sha256 !== diagnostic.candidate_input_sha256
    || bound.probe_matrix_sha256 !== diagnostic.probe_matrix_sha256 || bound.slot_plan_sha256 !== diagnostic.slot_plan_sha256
    || bound.matcher_version !== diagnostic.matcher_version
    || !sameGenerationConfig(bound, diagnostic)) {
    throw new Error("candidate feasibility diagnostic 与 checkpoint 的模型、schema 或匹配绑定不一致");
  }
}

function sameGenerationConfig(checkpoint: Record<string, unknown>, diagnostic: Record<string, unknown>): boolean {
  const generator = diagnostic.generator as Record<string, unknown> | undefined;
  const calibration = diagnostic.calibration as Record<string, unknown> | undefined;
  return generator != null && calibration != null
    && generator.model === checkpoint.model && generator.prompt_version === checkpoint.prompt_version && generator.prompt_sha256 === checkpoint.prompt_sha256
    && generator.thinking === checkpoint.generator_thinking && generator.response_schema_sha256 === checkpoint.generator_response_schema_sha256
    && generator.batch_size === checkpoint.generator_batch_size && generator.max_tokens === checkpoint.generator_max_tokens
    && generator.maximum_returned_drafts_per_attempt === checkpoint.generator_max_returned_drafts_per_attempt
    && generator.maximum_structural_response_attempts === checkpoint.generator_max_structural_response_attempts
    && calibration.model === checkpoint.calibration_model && calibration.thinking === checkpoint.calibration_thinking
    && calibration.prompt_version === checkpoint.calibration_prompt_version && calibration.prompt_sha256 === checkpoint.calibration_prompt_sha256
    && calibration.response_schema_sha256 === checkpoint.calibration_response_schema_sha256
    && calibration.max_tokens === checkpoint.calibration_max_tokens
    && calibration.max_generation_attempts === checkpoint.calibration_max_generation_attempts
    && calibration.minimum_drafts_per_attempt === checkpoint.calibration_minimum_drafts_per_attempt
    && calibration.maximum_drafts_per_attempt === checkpoint.calibration_maximum_drafts_per_attempt
    && calibration.maximum_returned_drafts_per_attempt === checkpoint.generator_max_returned_drafts_per_attempt
    && calibration.structured_transport_version === checkpoint.structured_transport_version;
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION = "a1-v2-consistency-candidate-checkpoint-v1";

export interface CandidateCheckpointContext {
  quality_input_sha256: string;
  candidate_input_sha256: string;
  model: string;
  prompt_version: string;
  prompt_sha256: string;
  generator_batch_size: number;
}

export interface CandidateCheckpointBatchPlan {
  start: number;
  ids: string[];
}

export interface CandidateCheckpointBatch {
  start: number;
  candidates: Array<{ id: string; statement: string }>;
}

export interface CandidateCheckpoint extends CandidateCheckpointContext {
  schema_version: typeof CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION;
  completed_batches: CandidateCheckpointBatch[];
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function candidateCheckpointPath(outputPath: string): string {
  return outputPath.replace(/\.local\.jsonl$/u, ".candidate-checkpoint.local.json");
}

export function createCandidateCheckpoint(context: CandidateCheckpointContext): CandidateCheckpoint {
  return { schema_version: CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION, ...context, completed_batches: [] };
}

function sameContext(checkpoint: CandidateCheckpoint, context: CandidateCheckpointContext): boolean {
  return checkpoint.quality_input_sha256 === context.quality_input_sha256
    && checkpoint.candidate_input_sha256 === context.candidate_input_sha256
    && checkpoint.model === context.model
    && checkpoint.prompt_version === context.prompt_version
    && checkpoint.prompt_sha256 === context.prompt_sha256
    && checkpoint.generator_batch_size === context.generator_batch_size;
}

function isCandidate(value: unknown): value is { id: string; statement: string } {
  return value != null && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { statement?: unknown }).statement === "string"
    && (value as { id: string }).id.trim().length > 0
    && (value as { statement: string }).statement.trim().length >= 10;
}

function validateCheckpoint(
  checkpoint: CandidateCheckpoint,
  context: CandidateCheckpointContext,
  plan: readonly CandidateCheckpointBatchPlan[],
): void {
  if (checkpoint.schema_version !== CONSISTENCY_CANDIDATE_CHECKPOINT_VERSION || !sameContext(checkpoint, context)) {
    throw new Error("candidate checkpoint 与当前输入、模型、prompt 或 batch 配置不匹配");
  }
  if (!Array.isArray(checkpoint.completed_batches) || checkpoint.completed_batches.length > plan.length) {
    throw new Error("candidate checkpoint 批次结构无效");
  }
  for (const [index, batch] of checkpoint.completed_batches.entries()) {
    const expected = plan[index];
    if (!expected || batch == null || typeof batch !== "object" || batch.start !== expected.start
      || !Array.isArray(batch.candidates) || batch.candidates.length !== expected.ids.length
      || batch.candidates.some((candidate, candidateIndex) => !isCandidate(candidate) || candidate.id !== expected.ids[candidateIndex])) {
      throw new Error("candidate checkpoint 不是当前候选计划的连续完整前缀");
    }
  }
}

export function loadCandidateCheckpoint(
  path: string,
  context: CandidateCheckpointContext,
  plan: readonly CandidateCheckpointBatchPlan[],
): CandidateCheckpoint | null {
  if (!existsSync(path)) return null;
  let checkpoint: CandidateCheckpoint;
  try {
    checkpoint = JSON.parse(readFileSync(path, "utf8")) as CandidateCheckpoint;
  } catch {
    throw new Error("candidate checkpoint 无法解析；拒绝混入未知进度");
  }
  validateCheckpoint(checkpoint, context, plan);
  return checkpoint;
}

export function appendCandidateCheckpointBatch(
  checkpoint: CandidateCheckpoint,
  plan: readonly CandidateCheckpointBatchPlan[],
  batch: CandidateCheckpointBatch,
): void {
  const expected = plan[checkpoint.completed_batches.length];
  if (!expected || batch.start !== expected.start || batch.candidates.length !== expected.ids.length
    || batch.candidates.some((candidate, index) => !isCandidate(candidate) || candidate.id !== expected.ids[index])) {
    throw new Error("candidate checkpoint 只能追加当前计划的下一个完整批次");
  }
  checkpoint.completed_batches.push({
    start: batch.start,
    candidates: batch.candidates.map((candidate) => ({ id: candidate.id, statement: candidate.statement.trim() })),
  });
}

/** Atomically persist local-only generated statements; source excerpts never enter this file. */
export function writeCandidateCheckpoint(path: string, checkpoint: CandidateCheckpoint): void {
  const temporary = `${path}.${process.pid}.${hash(JSON.stringify(checkpoint)).slice(0, 12)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

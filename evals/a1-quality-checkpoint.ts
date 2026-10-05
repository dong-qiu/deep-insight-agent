/**
 * Durable, local-only continuation state for one A1 quality pass.
 *
 * Unlike progress.json this contains post-audit model output (including short source quotes), so
 * it is an artifact in the same controlled run directory, never a repository fixture or a
 * portable approval record.  Its context and plan make a stale result fail closed on resume.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AnalysisBatch, ValidationResult } from "../src/lib/types.js";
import type { AnalyzeChunkCheckpoint, CoverageClaimDecision } from "../src/lib/agents/analyzer.js";
import { summarize } from "../src/lib/agents/validator.js";
import { isA1CoverageExecutionFailure } from "./a1-coverage-execution.js";
import { writeJson } from "./a1-artifacts.js";

export const A1_QUALITY_CHECKPOINT_VERSION = "a1-quality-checkpoint-v2";

export interface A1QualityCheckpointContext {
  /** Hash of the complete EvalConfig, including models, prompts, thinking and fixture hashes. */
  eval_config_sha256: string;
  quality_dataset_sha256: string;
  /** Null permits a cold run, but never permits recovery. Source and runtime conditions are bound. */
  recovery_identity_sha256: string | null;
}

export interface A1QualityCheckpointChunk extends AnalyzeChunkCheckpoint {
  /** Producer checked provider terminals and the complete coverage audit before appending. */
  execution_complete: true;
}

export interface A1QualityCheckpointPlanCase {
  case_index: number;
  topic_id: string;
  stratum: string;
  /** Ordered deterministic analyzer chunks; no source body is stored here. */
  chunk_input_sha256: string[];
}

export interface A1QualityCheckpointCase {
  case_index: number;
  topic_id: string;
  stratum: string;
  chunks: A1QualityCheckpointChunk[];
  /** A completed topic reuses both analysis and validator outputs; a partial topic has no result. */
  completed?: {
    batch: AnalysisBatch;
    validation: ValidationResult;
    execution_complete: true;
  };
}

export interface A1QualityCheckpoint extends A1QualityCheckpointContext {
  schema_version: typeof A1_QUALITY_CHECKPOINT_VERSION;
  cases: A1QualityCheckpointCase[];
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Stable object hashing makes a checkpoint reject any EvalConfig drift without storing secrets. */
export function a1QualityCheckpointConfigSha256(config: object): string {
  const encode = (value: unknown): string => {
    if (value == null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  };
  return sha256(encode(config));
}

export function createA1QualityCheckpoint(context: A1QualityCheckpointContext): A1QualityCheckpoint {
  return { schema_version: A1_QUALITY_CHECKPOINT_VERSION, ...context, cases: [] };
}

function expectedCase(plan: readonly A1QualityCheckpointPlanCase[], caseIndex: number): A1QualityCheckpointPlanCase {
  const expected = plan[caseIndex];
  if (!expected || expected.case_index !== caseIndex) throw new Error("A1 quality checkpoint plan 不是连续 case 序列");
  return expected;
}

function validCompleted(value: unknown, topicId: string): value is NonNullable<A1QualityCheckpointCase["completed"]> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const batch = record.batch as Partial<AnalysisBatch> | undefined;
  const validation = record.validation as Partial<ValidationResult> | undefined;
  if (record.execution_complete !== true || batch?.topic_id !== topicId || batch.status !== "done" || !Array.isArray(batch.insights)
    || !Array.isArray(validation?.checks) || validation.report == null || typeof validation.report !== "object") return false;
  const expected = new Set<string>();
  for (const insight of batch.insights) {
    if (!insight || typeof insight.id !== "string" || !Array.isArray(insight.citations)) return false;
    for (const [index] of insight.citations.entries()) {
      const key = JSON.stringify([insight.id, index]);
      if (expected.has(key)) return false;
      expected.add(key);
    }
  }
  for (const check of validation.checks) {
    if (!check || !expected.delete(JSON.stringify([check.insight_id, check.citation_index]))) return false;
    if (check.reachability === "fail") {
      if (check.consistency !== "not_evaluated" || check.verdict !== "blocked") return false;
    } else if (check.reachability === "pass") {
      const verdict = { support: "pass", uncertain: "flagged", not_support: "blocked" }[check.consistency as "support" | "uncertain" | "not_support"];
      if (!verdict || check.verdict !== verdict) return false;
    } else return false;
  }
  if (expected.size) return false;
  const report = summarize(validation.checks);
  return report.errored === 0 && Object.entries(report).every(([key, value]) =>
    (validation.report as unknown as Record<string, unknown>)[key] === value);
}

function completeClaim(claim: CoverageClaimDecision): boolean {
  return claim != null && typeof claim.reason === "string" && !isA1CoverageExecutionFailure(claim.reason)
    && claim.countercheck?.error == null
    && (claim.countercheck == null || !isA1CoverageExecutionFailure(claim.countercheck.reason));
}

function validChunk(chunk: A1QualityCheckpointChunk): boolean {
  return chunk != null && chunk.execution_complete === true && Array.isArray(chunk.insights)
    && Array.isArray(chunk.coverage_decisions) && chunk.coverage_decisions.every((decision) => (
      decision != null && ["kept", "kept_degraded", "dropped_invalid_citation", "dropped_no_displayable_citation", "dropped_coverage"].includes(decision.terminal_reason)
      && Array.isArray(decision.claims)
      && !["unavailable", "invalid"].includes(decision.reader_language_repair?.status ?? "")
      && decision.claims.every(completeClaim)
      && (decision.reader_language_repair == null || (Array.isArray(decision.reader_language_repair.source_claims)
        && decision.reader_language_repair.source_claims.every(completeClaim)))
    ));
}

/** Verify that this is one continuous prefix of this exact quality case and chunk population. */
export function assertValidA1QualityCheckpoint(
  checkpoint: A1QualityCheckpoint,
  context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
): void {
  if (typeof context.recovery_identity_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(context.recovery_identity_sha256)) {
    throw new Error("A1 quality checkpoint 缺少可验证恢复身份");
  }
  assertCheckpointState(checkpoint, context, plan);
}

/** A cold run without Git can record diagnostic state; that state is never reusable. */
function assertCheckpointState(
  checkpoint: A1QualityCheckpoint, context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
): void {
  if (checkpoint.schema_version !== A1_QUALITY_CHECKPOINT_VERSION
    || checkpoint.eval_config_sha256 !== context.eval_config_sha256
    || checkpoint.quality_dataset_sha256 !== context.quality_dataset_sha256
    || checkpoint.recovery_identity_sha256 !== context.recovery_identity_sha256
    || !Array.isArray(checkpoint.cases)) {
    throw new Error("A1 quality checkpoint 与当前配置或质量数据集不匹配");
  }
  if (checkpoint.cases.length > plan.length) throw new Error("A1 quality checkpoint 含有超出当前样本的 case");
  let partialSeen = false;
  for (const [caseIndex, saved] of checkpoint.cases.entries()) {
    const expected = expectedCase(plan, caseIndex);
    if (partialSeen || saved == null || saved.case_index !== caseIndex
      || saved.topic_id !== expected.topic_id || saved.stratum !== expected.stratum
      || !Array.isArray(saved.chunks) || saved.chunks.length > expected.chunk_input_sha256.length
      || saved.chunks.some((chunk, chunkIndex) => chunk == null
        || chunk.input_sha256 !== expected.chunk_input_sha256[chunkIndex]
        || !validChunk(chunk))) {
      throw new Error("A1 quality checkpoint 不是当前样本的连续完整分块前缀");
    }
    if (saved.completed != null) {
      if (saved.chunks.length !== expected.chunk_input_sha256.length || !validCompleted(saved.completed, expected.topic_id)) {
        throw new Error("A1 quality checkpoint 的完成主题不完整或无效");
      }
    } else {
      // A deadline may fire after the last analyzer chunk but before validateBatch completes.
      // That state is resumable (without another analyzer call), but it still blocks later topics.
      partialSeen = true;
      if (caseIndex !== checkpoint.cases.length - 1) {
        throw new Error("A1 quality checkpoint 的未完成 topic 后不得有后续 case");
      }
    }
  }
}

/** A resume source must exist and validate completely; callers decide whether it came from a failed run. */
export function loadA1QualityCheckpoint(
  path: string,
  context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
  expectedSha256?: string,
): A1QualityCheckpoint {
  if (!existsSync(path)) throw new Error("A1_RESUME_FROM 缺少 quality-checkpoint.json");
  return parseCheckpointBytes(readFileSync(path), context, plan, expectedSha256);
}

function parseCheckpointBytes(
  bytes: Buffer, context: A1QualityCheckpointContext, plan: readonly A1QualityCheckpointPlanCase[],
  expectedSha256?: string,
): A1QualityCheckpoint {
  let parsed: A1QualityCheckpoint;
  try {
    if (expectedSha256 != null && sha256(bytes) !== expectedSha256) {
      throw new Error("A1 checkpoint bytes changed");
    }
    parsed = JSON.parse(bytes.toString("utf8")) as A1QualityCheckpoint;
  } catch {
    throw new Error("A1 quality checkpoint 无法解析；拒绝混入未知进度");
  }
  assertValidA1QualityCheckpoint(parsed, context, plan);
  return parsed;
}

export function writeA1QualityCheckpoint(path: string, checkpoint: A1QualityCheckpoint): void {
  writeJson(path, checkpoint);
}

/** A resume file is trusted only when its terminal failed-run manifest binds the same bytes. */
export function verifiedFailedA1CheckpointSha256(manifestPath: string, checkpointPath: string): string {
  return readVerifiedFailedA1Checkpoint(manifestPath, checkpointPath).checkpoint_sha256;
}

/** Hash and parse the same single read: a file replacement cannot change the verified evidence. */
export function loadVerifiedA1QualityCheckpoint(
  manifestPath: string, checkpointPath: string, context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
): { checkpoint: A1QualityCheckpoint; checkpoint_sha256: string } {
  const verified = readVerifiedFailedA1Checkpoint(manifestPath, checkpointPath);
  return { checkpoint: parseCheckpointBytes(verified.bytes, context, plan), checkpoint_sha256: verified.checkpoint_sha256 };
}

function readVerifiedFailedA1Checkpoint(manifestPath: string, checkpointPath: string): { bytes: Buffer; checkpoint_sha256: string } {
  if (!existsSync(manifestPath) || !existsSync(checkpointPath)) {
    throw new Error("A1 resume 缺少 manifest 或 quality checkpoint");
  }
  let manifest: { status?: unknown; artifacts?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { status?: unknown; artifacts?: unknown };
  } catch {
    throw new Error("A1 resume manifest 无法解析");
  }
  const bytes = readFileSync(checkpointPath);
  const checkpointSha256 = sha256(bytes);
  const artifactHash = manifest.artifacts != null && typeof manifest.artifacts === "object" && !Array.isArray(manifest.artifacts)
    ? (manifest.artifacts as Record<string, unknown>)["quality-checkpoint.json"]
    : null;
  if (manifest.status !== "failed" || artifactHash !== checkpointSha256) {
    throw new Error("A1 resume 必须是哈希绑定 quality-checkpoint 的失败 A1 run");
  }
  return { bytes, checkpoint_sha256: checkpointSha256 };
}

function ensureCase(
  checkpoint: A1QualityCheckpoint,
  plan: readonly A1QualityCheckpointPlanCase[],
  caseIndex: number,
): A1QualityCheckpointCase {
  assertCheckpointState(checkpoint, checkpoint, plan);
  const expected = expectedCase(plan, caseIndex);
  const existing = checkpoint.cases[caseIndex];
  if (existing) return existing;
  if (caseIndex !== checkpoint.cases.length) throw new Error("A1 quality checkpoint 不能跳过前序 topic");
  const added: A1QualityCheckpointCase = {
    case_index: caseIndex, topic_id: expected.topic_id, stratum: expected.stratum, chunks: [],
  };
  checkpoint.cases.push(added);
  return added;
}

/** Mutate only by appending the next complete analyzer chunk, never an arbitrary chunk. */
export function appendA1QualityCheckpointChunk(
  checkpoint: A1QualityCheckpoint,
  plan: readonly A1QualityCheckpointPlanCase[],
  caseIndex: number,
  chunk: A1QualityCheckpointChunk,
): void {
  const entry = ensureCase(checkpoint, plan, caseIndex);
  const expected = expectedCase(plan, caseIndex);
  if (entry.completed != null || entry.chunks.length >= expected.chunk_input_sha256.length
    || chunk.input_sha256 !== expected.chunk_input_sha256[entry.chunks.length]
    || !validChunk(chunk)) {
    throw new Error("A1 quality checkpoint 只能追加当前 topic 的下一个完整分块");
  }
  entry.chunks.push(chunk);
}

/** Mark a topic reusable only after every analyzer chunk and one full validator result are present. */
export function completeA1QualityCheckpointCase(
  checkpoint: A1QualityCheckpoint,
  plan: readonly A1QualityCheckpointPlanCase[],
  caseIndex: number,
  completed: NonNullable<A1QualityCheckpointCase["completed"]>,
): void {
  const entry = ensureCase(checkpoint, plan, caseIndex);
  const expected = expectedCase(plan, caseIndex);
  if (entry.completed != null || entry.chunks.length !== expected.chunk_input_sha256.length
    || !validCompleted(completed, expected.topic_id)) {
    throw new Error("A1 quality checkpoint 只能完成已有全部 analyzer 分块的 topic");
  }
  entry.completed = completed;
}

/** Crash-safe, non-final progress for a long-running prototype AI reviewer.
 * The checkpoint holds labels and binding hashes only—never the source excerpts—and it can never
 * be used as a reviewer submission. A formal submission is written separately only after 100/100.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ConsistencyLabelMark } from "./a1-consistency-label-receipt.js";
import type { BlindWorklistRow } from "./a1-consistency-label-blind-worklist.js";

export const AI_REVIEW_CHECKPOINT_VERSION = "a1-v2-ai-assisted-review-checkpoint-v1";

export interface AiReviewCheckpointContext {
  reviewer_id: string;
  role: "validator" | "coverage";
  model: string;
  thinking: boolean;
  structured_thinking_transport_version: string;
  response_budget_version: string;
  max_tokens: number;
  prompt_version: string;
  prompt_sha256: string;
  worklist_sha256: string;
  pair_population_sha256: string;
}

export interface AiReviewCheckpoint extends AiReviewCheckpointContext {
  schema_version: typeof AI_REVIEW_CHECKPOINT_VERSION;
  usage: { calls: number; tokens: number; amount_usd: number };
  decisions: ConsistencyLabelMark[];
}

export const checkpointPathFor = (outputPath: string): string => outputPath.replace(/\.local\.json$/u, ".checkpoint.local.json");

const sameContext = (checkpoint: AiReviewCheckpoint, context: AiReviewCheckpointContext): boolean => (
  checkpoint.reviewer_id === context.reviewer_id
  && checkpoint.role === context.role
  && checkpoint.model === context.model
  && checkpoint.thinking === context.thinking
  && checkpoint.structured_thinking_transport_version === context.structured_thinking_transport_version
  && checkpoint.response_budget_version === context.response_budget_version
  && checkpoint.max_tokens === context.max_tokens
  && checkpoint.prompt_version === context.prompt_version
  && checkpoint.prompt_sha256 === context.prompt_sha256
  && checkpoint.worklist_sha256 === context.worklist_sha256
  && checkpoint.pair_population_sha256 === context.pair_population_sha256
);

type ReviewResponseDecision = Pick<ConsistencyLabelMark, "case_id" | "expected_consistency"> & { negative_type?: unknown };

function validLabelShape(mark: ReviewResponseDecision): boolean {
  const labelOk = mark.expected_consistency === "support" || mark.expected_consistency === "uncertain" || mark.expected_consistency === "not_support";
  return labelOk && (mark.expected_consistency === "not_support"
    ? mark.negative_type === "exaggeration" || mark.negative_type === "out_of_context" || mark.negative_type === "misattribution"
    : mark.negative_type == null);
}

function validDecision(mark: ConsistencyLabelMark, row: BlindWorklistRow): boolean {
  return validLabelShape(mark) && mark.case_id === row.id && mark.pair_sha256 === row.pair_sha256;
}

/** A response is usable only when it covers this exact batch once and its label shape is coherent. */
export function validAiReviewBatch(
  batch: readonly BlindWorklistRow[],
  decisions: readonly ReviewResponseDecision[],
): boolean {
  const byId = new Map(decisions.map((decision) => [decision.case_id, decision]));
  return byId.size === batch.length && batch.every((row) => {
    const decision = byId.get(row.id);
    return decision != null && validLabelShape(decision);
  });
}

function validUsage(usage: AiReviewCheckpoint["usage"]): boolean {
  return Number.isInteger(usage.calls) && usage.calls >= 0
    && Number.isFinite(usage.tokens) && usage.tokens >= 0
    && Number.isFinite(usage.amount_usd) && usage.amount_usd >= 0;
}

/** Load only an all-whole-batch prefix tied to this exact reviewer configuration and worklist. */
export function loadAiReviewCheckpoint(
  path: string,
  context: AiReviewCheckpointContext,
  worklist: readonly BlindWorklistRow[],
  batchSize: number,
): Pick<AiReviewCheckpoint, "usage" | "decisions"> {
  if (!existsSync(path)) return { usage: { calls: 0, tokens: 0, amount_usd: 0 }, decisions: [] };
  let checkpoint: AiReviewCheckpoint;
  try {
    checkpoint = JSON.parse(readFileSync(path, "utf8")) as AiReviewCheckpoint;
  } catch {
    throw new Error("AI reviewer checkpoint 无法解析；拒绝混入未知进度");
  }
  if (checkpoint.schema_version !== AI_REVIEW_CHECKPOINT_VERSION || !sameContext(checkpoint, context)) {
    throw new Error("AI reviewer checkpoint 与当前模型、prompt 或 worklist 不匹配");
  }
  if (!Array.isArray(checkpoint.decisions) || !validUsage(checkpoint.usage)
    || checkpoint.decisions.length > worklist.length || checkpoint.decisions.length % batchSize !== 0
    || checkpoint.usage.calls < checkpoint.decisions.length / batchSize
    || checkpoint.decisions.some((decision, index) => !validDecision(decision, worklist[index]!))) {
    throw new Error("AI reviewer checkpoint 不是此 worklist 的完整批次前缀");
  }
  return { usage: checkpoint.usage, decisions: checkpoint.decisions };
}

/** Atomically replace a non-final checkpoint after one complete successful batch. */
export function writeAiReviewCheckpoint(
  path: string,
  context: AiReviewCheckpointContext,
  usage: AiReviewCheckpoint["usage"],
  decisions: readonly ConsistencyLabelMark[],
): void {
  const checkpoint: AiReviewCheckpoint = {
    schema_version: AI_REVIEW_CHECKPOINT_VERSION,
    ...context,
    usage,
    decisions: [...decisions],
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "w" });
  renameSync(temporary, path);
}

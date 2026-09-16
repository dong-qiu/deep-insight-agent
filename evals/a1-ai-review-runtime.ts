import { STRUCTURED_THINKING_BUDGET_TOKENS } from "../src/lib/runtime/llm.js";

/**
 * Keep the reviewer response cap explicit: it changes completion/timeout behaviour, so a
 * checkpoint and final prototype submission must bind it rather than silently resuming across it.
 * 1536 leaves the validator's fixed 1024-token thinking budget plus 512 tokens for forced-tool
 * output; the latter is ample for the at-most-five compact decisions in one reviewer batch.
 */
export const AI_REVIEW_DEFAULT_MAX_TOKENS = 3_072;
export const AI_REVIEW_MIN_MAX_TOKENS = STRUCTURED_THINKING_BUDGET_TOKENS + 512;

export function aiReviewMaxTokens(raw = process.env.AI_REVIEW_MAX_TOKENS): number {
  if (raw == null || raw.trim() === "") return AI_REVIEW_DEFAULT_MAX_TOKENS;
  if (!/^\d+$/u.test(raw.trim())) throw new Error("AI_REVIEW_MAX_TOKENS 必须是整数");
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < AI_REVIEW_MIN_MAX_TOKENS) {
    throw new Error(`AI_REVIEW_MAX_TOKENS 必须至少为 ${AI_REVIEW_MIN_MAX_TOKENS}，以保留 thinking 和结构化输出预算`);
  }
  return value;
}

export function aiReviewResponseBudgetVersion(maxTokens: number): string {
  return `output-${maxTokens}-v1`;
}

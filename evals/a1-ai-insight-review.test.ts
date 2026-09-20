import { describe, expect, it } from "vitest";
import type { A1ReviewBinding } from "./a1-review-receipt.js";
import {
  AI_INSIGHT_REVIEW_VERSION,
  assertAiInsightReviewerSeparation,
  compareAiInsightReviews,
  insightReviewBinding,
  type AiInsightReviewerSubmission,
} from "./a1-ai-insight-review.js";

const binding: A1ReviewBinding = {
  run_id: "a1-run",
  manifest_sha256: "a".repeat(64),
  queue_sha256: "b".repeat(64),
  dataset_lock_sha256: "c".repeat(64),
  insight_ids_sha256: "d".repeat(64),
  insight_texts_sha256: "e".repeat(64),
  insights: [
    { id: "ins-1", text_sha256: "1".repeat(64) },
    { id: "ins-2", text_sha256: "2".repeat(64) },
  ],
};

const submission = (role: "validator" | "coverage", decisions: AiInsightReviewerSubmission["decisions"]): AiInsightReviewerSubmission => ({
  schema_version: AI_INSIGHT_REVIEW_VERSION,
  status: "diagnostic_only",
  reviewer_id: `ai-${role}`,
  reviewer_kind: "ai",
  role,
  model: role === "validator" ? "deepseek-v4-pro" : "glm-5.2",
  thinking: false,
  structured_thinking_transport_version: "transport-v1",
  response_budget_version: "max_tokens:1024",
  max_tokens: 1024,
  prompt_version: "prompt-v1",
  prompt_sha256: "f".repeat(64),
  binding: insightReviewBinding(binding),
  usage: { calls: 2, tokens: 1, amount_usd: 0 },
  decisions,
});

const decision = (id: string, hash: string, values: Partial<AiInsightReviewerSubmission["decisions"][number]> = {}) => ({
  insight_id: id,
  insight_text_sha256: hash,
  non_obvious: "yes" as const,
  hallucination: "no" as const,
  importance_reasonable: "yes" as const,
  rationale: "仅作本地诊断。",
  ...values,
});

describe("prototype AI insight review", () => {
  it("keeps only decisive complete agreement and routes uncertainty to a human dispute", () => {
    const first = submission("validator", [decision("ins-1", "1".repeat(64)), decision("ins-2", "2".repeat(64))]);
    const second = submission("coverage", [
      decision("ins-1", "1".repeat(64)),
      decision("ins-2", "2".repeat(64), { importance_reasonable: "uncertain" }),
    ]);

    const result = compareAiInsightReviews(binding, first, second);

    expect(result.receipt).toMatchObject({ status: "diagnostic_only", lock_eligible: false, human_adjudication_mode: "human_with_ai_advice" });
    expect(result.receipt.agreement).toMatchObject({ consensus_count: 1, dispute_count: 1, field_consensus_count: 5, field_dispute_count: 1 });
    expect(result.consensus_ids).toEqual(["ins-1"]);
    expect(result.disputes.map((item) => ({ id: item.insight_id, fields: item.fields }))).toEqual([{ id: "ins-2", fields: ["importance_reasonable"] }]);
  });

  it("rejects a same-model pair and a reviewer submission with a stale insight binding", () => {
    const first = submission("validator", [decision("ins-1", "1".repeat(64)), decision("ins-2", "2".repeat(64))]);
    const second = submission("coverage", [decision("ins-1", "1".repeat(64)), decision("ins-2", "0".repeat(64))]);
    second.model = first.model;

    const result = compareAiInsightReviews(binding, first, second);

    expect(result.receipt.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("文本 hash 不匹配"),
      expect.stringContaining("同一模型"),
    ]));
  });

  it("fails before calls when reviewer models are not independent", () => {
    expect(() => assertAiInsightReviewerSeparation("same", "same")).toThrow("不同模型");
  });
});

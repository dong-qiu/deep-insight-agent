/**
 * Prototype-only, double-AI review of an A1 reader-visible insight queue.
 *
 * This intentionally does not reuse the human receipt schema: agreement is a diagnostic signal
 * only, and every artifact produced by this module is ineligible for a DCP/baseline sign-off.
 */
import { createHash } from "node:crypto";
import type { A1ReviewBinding } from "./a1-review-receipt.js";

export const AI_INSIGHT_REVIEW_VERSION = "a1-ai-insight-review-v2";
export const AI_INSIGHT_HUMAN_ADJUDICATION_PROGRESS_VERSION = "a1-ai-insight-human-adjudication-progress-v1";
export const AI_INSIGHT_HUMAN_ADJUDICATION_VERSION = "a1-ai-insight-human-adjudication-v1";
export type AiInsightReviewRole = "validator" | "coverage";
export type AiInsightVerdict = "yes" | "no" | "uncertain";
export type AiInsightReviewField = "non_obvious" | "hallucination" | "importance_reasonable";

export interface AiInsightReviewDecision {
  insight_id: string;
  insight_text_sha256: string;
  non_obvious: AiInsightVerdict;
  hallucination: AiInsightVerdict;
  importance_reasonable: AiInsightVerdict;
  rationale: string;
}

export interface AiInsightReviewerSubmission {
  schema_version: typeof AI_INSIGHT_REVIEW_VERSION;
  status: "diagnostic_only";
  reviewer_id: string;
  reviewer_kind: "ai";
  role: AiInsightReviewRole;
  model: string;
  thinking: boolean;
  structured_thinking_transport_version: string;
  response_budget_version: string;
  max_tokens: number;
  prompt_version: string;
  prompt_sha256: string;
  binding: Omit<A1ReviewBinding, "insights">;
  usage: { calls: number; tokens: number; amount_usd: number };
  decisions: AiInsightReviewDecision[];
}

export interface AiInsightReviewDispute {
  insight_id: string;
  fields: AiInsightReviewField[];
  first: AiInsightReviewDecision;
  second: AiInsightReviewDecision;
}

export interface AiInsightReviewReceipt {
  schema_version: typeof AI_INSIGHT_REVIEW_VERSION;
  status: "diagnostic_only";
  lock_eligible: false;
  human_adjudication_mode: "human_with_ai_advice";
  binding: Omit<A1ReviewBinding, "insights">;
  reviewers: Array<{
    reviewer_id: string;
    role: AiInsightReviewRole;
    model: string;
    thinking: boolean;
    prompt_sha256: string;
    submission_sha256: string;
  }>;
  agreement: {
    consensus_count: number;
    dispute_count: number;
    field_consensus_count: number;
    field_dispute_count: number;
    dispute_ids_sha256: string;
  };
  issues: string[];
  note: string;
}

/**
 * An explicitly AI-advised, human-entered decision. It is intentionally tri-state: this is a
 * diagnostic calibration record, not a replacement for the boolean marks in a blind receipt.
 */
export interface AiInsightHumanAdjudicationDecision {
  insight_id: string;
  insight_text_sha256: string;
  non_obvious: AiInsightVerdict;
  hallucination: AiInsightVerdict;
  importance_reasonable: AiInsightVerdict;
  human_reason: string;
}

/**
 * Local input surface for a human who has already seen the AI dispute pack. This must never
 * claim blind review: the finalizer below verifies that declaration before binding it.
 */
export interface AiInsightHumanAdjudicationProgress {
  schema_version: typeof AI_INSIGHT_HUMAN_ADJUDICATION_PROGRESS_VERSION;
  status: "completed";
  adjudication_mode: "human_with_ai_advice";
  blind_attestation: false;
  decisions: readonly AiInsightHumanAdjudicationDecision[];
}

/**
 * Hash-bound, prototype-only record of a chat/user adjudication. It deliberately has no
 * `reviewers` field, uses tri-state marks, and cannot satisfy `review:receipt`'s two-human,
 * blind-submission contract.
 */
export interface AiInsightHumanAdjudicationRecord {
  schema_version: typeof AI_INSIGHT_HUMAN_ADJUDICATION_VERSION;
  status: "diagnostic_only";
  lock_eligible: false;
  human_adjudication_mode: "human_with_ai_advice";
  human_adjudication_blind_attestation: false;
  adjudicator_id: string;
  adjudicator_kind: "human";
  binding: Omit<A1ReviewBinding, "insights">;
  ai_review_receipt_sha256: string;
  dispute_pack_sha256: string;
  progress_sha256: string;
  decisions: readonly AiInsightHumanAdjudicationDecision[];
  note: string;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};

const verdict = (value: unknown): value is AiInsightVerdict => value === "yes" || value === "no" || value === "uncertain";
const exactBinding = (binding: A1ReviewBinding): Omit<A1ReviewBinding, "insights"> => ({
  run_id: binding.run_id,
  manifest_sha256: binding.manifest_sha256,
  queue_sha256: binding.queue_sha256,
  dataset_lock_sha256: binding.dataset_lock_sha256,
  insight_ids_sha256: binding.insight_ids_sha256,
  insight_texts_sha256: binding.insight_texts_sha256,
});

export function insightReviewBinding(binding: A1ReviewBinding): Omit<A1ReviewBinding, "insights"> {
  return exactBinding(binding);
}

/** Different role labels do not make a same-model pair independent. */
export function assertAiInsightReviewerSeparation(validatorModel: string, coverageModel: string): void {
  if (!validatorModel.trim() || !coverageModel.trim()) {
    throw new Error("AI 双审要求同时显式配置 VALIDATOR_MODEL 与 COVERAGE_MODEL");
  }
  if (validatorModel === coverageModel) {
    throw new Error("AI 双审的 validator 与 coverage 必须使用不同模型");
  }
}

function sameBinding(a: Omit<A1ReviewBinding, "insights">, b: Omit<A1ReviewBinding, "insights">): boolean {
  return stable(a) === stable(b);
}

function validDecision(decision: AiInsightReviewDecision, expectedHash: string | undefined): boolean {
  return Boolean(decision.insight_id)
    && expectedHash === decision.insight_text_sha256
    && verdict(decision.non_obvious)
    && verdict(decision.hallucination)
    && verdict(decision.importance_reasonable)
    && typeof decision.rationale === "string"
    && decision.rationale.trim().length > 0
    && decision.rationale.length <= 600;
}

function validHumanDecision(decision: AiInsightHumanAdjudicationDecision, expectedHash: string | undefined): boolean {
  return Boolean(decision.insight_id)
    && expectedHash === decision.insight_text_sha256
    && verdict(decision.non_obvious)
    && verdict(decision.hallucination)
    && verdict(decision.importance_reasonable)
    && typeof decision.human_reason === "string"
    && decision.human_reason.trim().length > 0
    && decision.human_reason.length <= 600;
}

function validateSubmission(binding: A1ReviewBinding, submission: AiInsightReviewerSubmission, label: string): string[] {
  const issues: string[] = [];
  if (submission.schema_version !== AI_INSIGHT_REVIEW_VERSION || submission.status !== "diagnostic_only") {
    issues.push(`${label} 不是 diagnostic_only AI 洞察审阅产物`);
  }
  if (submission.reviewer_kind !== "ai" || !submission.reviewer_id.trim()) issues.push(`${label} reviewer 身份无效`);
  if (submission.role !== "validator" && submission.role !== "coverage") issues.push(`${label} role 无效`);
  if (!submission.model.trim() || !submission.prompt_sha256 || !submission.prompt_version || !submission.structured_thinking_transport_version
    || !submission.response_budget_version || !Number.isSafeInteger(submission.max_tokens) || submission.max_tokens < 1) {
    issues.push(`${label} 缺少模型、prompt 或传输 provenance`);
  }
  if (!sameBinding(exactBinding(binding), submission.binding)) issues.push(`${label} 未绑定当前 manifest/review queue`);
  const expected = new Map(binding.insights.map((item) => [item.id, item.text_sha256]));
  const seen = new Set<string>();
  for (const decision of submission.decisions) {
    if (seen.has(decision.insight_id)) issues.push(`${label} 重复判断 ${decision.insight_id}`);
    seen.add(decision.insight_id);
    if (!validDecision(decision, expected.get(decision.insight_id))) issues.push(`${label} 的 ${decision.insight_id} 无效或文本 hash 不匹配`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push(`${label} 缺少 ${id}`);
  return issues;
}

const reviewFields: readonly AiInsightReviewField[] = ["non_obvious", "hallucination", "importance_reasonable"];

function decisiveAgreement(field: AiInsightReviewField, first: AiInsightReviewDecision, second: AiInsightReviewDecision): boolean {
  return first[field] !== "uncertain" && first[field] === second[field];
}

/**
 * Return only diagnostic agreement/disagreement. The caller must preserve this as prototype
 * evidence and may only send disagreement rows to a human who is explicitly told AI advice is
 * visible; it cannot be passed to review:receipt.
 */
export function compareAiInsightReviews(
  binding: A1ReviewBinding,
  first: AiInsightReviewerSubmission,
  second: AiInsightReviewerSubmission,
): { receipt: AiInsightReviewReceipt; consensus_ids: string[]; disputes: AiInsightReviewDispute[] } {
  const issues = [
    ...validateSubmission(binding, first, "first reviewer"),
    ...validateSubmission(binding, second, "second reviewer"),
  ];
  if (first.reviewer_id === second.reviewer_id) issues.push("两个 AI reviewer_id 不可相同");
  if (first.model === second.model) issues.push("两个 AI reviewer 不可使用同一模型");
  if (first.role === second.role) issues.push("两个 AI reviewer 不可使用同一 role");

  const firstById = new Map(first.decisions.map((decision) => [decision.insight_id, decision]));
  const secondById = new Map(second.decisions.map((decision) => [decision.insight_id, decision]));
  const consensus_ids: string[] = [];
  const disputes: AiInsightReviewDispute[] = [];
  let fieldConsensusCount = 0;
  let fieldDisputeCount = 0;
  for (const insight of binding.insights) {
    const a = firstById.get(insight.id);
    const b = secondById.get(insight.id);
    if (!a || !b) continue;
    const disputedFields = reviewFields.filter((field) => !decisiveAgreement(field, a, b));
    fieldConsensusCount += reviewFields.length - disputedFields.length;
    fieldDisputeCount += disputedFields.length;
    if (disputedFields.length === 0) consensus_ids.push(insight.id);
    else disputes.push({ insight_id: insight.id, fields: disputedFields, first: a, second: b });
  }
  const disputeIds = disputes.map((item) => item.insight_id).sort();
  const receipt: AiInsightReviewReceipt = {
    schema_version: AI_INSIGHT_REVIEW_VERSION,
    status: "diagnostic_only",
    lock_eligible: false,
    human_adjudication_mode: "human_with_ai_advice",
    binding: exactBinding(binding),
    reviewers: [first, second].map((reviewer) => ({
      reviewer_id: reviewer.reviewer_id,
      role: reviewer.role,
      model: reviewer.model,
      thinking: reviewer.thinking,
      prompt_sha256: reviewer.prompt_sha256,
      submission_sha256: hash(stable(reviewer)),
    })),
    agreement: {
      consensus_count: consensus_ids.length,
      dispute_count: disputes.length,
      field_consensus_count: fieldConsensusCount,
      field_dispute_count: fieldDisputeCount,
      dispute_ids_sha256: hash(disputeIds.join("\n")),
    },
    issues,
    note: "Prototype-only AI consensus. It is diagnostic_only, lock_eligible=false, and must never be passed to review:receipt, a DCP decision, baseline promotion, or release sign-off.",
  };
  return { receipt, consensus_ids, disputes };
}

/**
 * Binds an explicitly AI-advised human decision to the exact review artifacts. The caller must
 * supply the dispute IDs from the comparator's immutable local pack; every and only such insight
 * must be adjudicated, so a partial chat transcript can never look complete.
 */
export function bindAiInsightHumanAdjudication(
  binding: A1ReviewBinding,
  aiReceipt: AiInsightReviewReceipt,
  disputeIds: readonly string[],
  progress: AiInsightHumanAdjudicationProgress,
  adjudicatorId: string,
  artifactHashes: { ai_review_receipt_sha256: string; dispute_pack_sha256: string; progress_sha256: string },
): AiInsightHumanAdjudicationRecord {
  const issues: string[] = [];
  if (!adjudicatorId.trim()) issues.push("human chat adjudicator_id 不可为空");
  if (aiReceipt.schema_version !== AI_INSIGHT_REVIEW_VERSION || aiReceipt.status !== "diagnostic_only" || aiReceipt.lock_eligible !== false
    || aiReceipt.human_adjudication_mode !== "human_with_ai_advice" || !sameBinding(exactBinding(binding), aiReceipt.binding)
    || aiReceipt.issues.length > 0) {
    issues.push("AI review receipt 不是当前 run 的合格 diagnostic_only 产物");
  }
  const sortedDisputeIds = [...disputeIds].sort();
  if (!sortedDisputeIds.length || new Set(sortedDisputeIds).size !== sortedDisputeIds.length) {
    issues.push("AI dispute population 为空或含重复 insight_id");
  }
  if (aiReceipt.agreement.dispute_ids_sha256 !== hash(sortedDisputeIds.join("\n"))) {
    issues.push("AI dispute pack 与 receipt 的 dispute population 不匹配");
  }
  if (progress.schema_version !== AI_INSIGHT_HUMAN_ADJUDICATION_PROGRESS_VERSION || progress.status !== "completed"
    || progress.adjudication_mode !== "human_with_ai_advice" || progress.blind_attestation !== false) {
    issues.push("human chat progress 必须显式声明 completed、human_with_ai_advice 且 blind_attestation=false");
  }
  const expected = new Map(binding.insights.map((item) => [item.id, item.text_sha256]));
  const seen = new Set<string>();
  for (const decision of progress.decisions) {
    if (seen.has(decision.insight_id)) issues.push(`human chat adjudication 重复判断 ${decision.insight_id}`);
    seen.add(decision.insight_id);
    if (!validHumanDecision(decision, expected.get(decision.insight_id))) {
      issues.push(`human chat adjudication 的 ${decision.insight_id} 无效、无理由或文本 hash 不匹配`);
    }
    if (!sortedDisputeIds.includes(decision.insight_id)) issues.push(`human chat adjudication 含非分歧项 ${decision.insight_id}`);
  }
  for (const id of sortedDisputeIds) if (!seen.has(id)) issues.push(`human chat adjudication 缺少分歧项 ${id}`);
  if (issues.length) throw new Error(`human chat insight adjudication 不合格：${issues.join("；")}`);
  return {
    schema_version: AI_INSIGHT_HUMAN_ADJUDICATION_VERSION,
    status: "diagnostic_only",
    lock_eligible: false,
    human_adjudication_mode: "human_with_ai_advice",
    human_adjudication_blind_attestation: false,
    adjudicator_id: adjudicatorId.trim(),
    adjudicator_kind: "human",
    binding: exactBinding(binding),
    ...artifactHashes,
    decisions: progress.decisions,
    note: "Prototype-only AI-advised human insight adjudication. It is diagnostic_only, lock_eligible=false, and must never be passed to review:receipt, baseline promotion, a DCP decision, or release sign-off.",
  };
}

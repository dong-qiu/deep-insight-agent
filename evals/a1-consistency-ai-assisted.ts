/**
 * Prototype-only AI double-review evidence. This deliberately has no `eligible_for_lock` state:
 * the formal v2 human-label receipt remains the only input accepted by a controlled dataset lock.
 */
import { createHash } from "node:crypto";
import type {
  ConsistencyLabel,
  ConsistencyLabelCase,
  ConsistencyLabelMark,
  NegativeType,
} from "./a1-consistency-label-receipt.js";
import type { BlindWorklistRow } from "./a1-consistency-label-blind-worklist.js";

export const AI_ASSISTED_REVIEW_VERSION = "a1-v2-ai-assisted-review-v1";
export const AI_ASSISTED_ADJUDICATION_VERSION = "a1-v2-ai-assisted-adjudication-v1";
export const AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION = "a1-v2-ai-assisted-chat-adjudication-progress-v1";
export const AI_ASSISTED_CHAT_ADJUDICATION_VERSION = "a1-v2-ai-assisted-chat-adjudication-v1";

export interface AiAssistedReviewerSubmission {
  schema_version: typeof AI_ASSISTED_REVIEW_VERSION;
  reviewer_id: string;
  reviewer_kind: "ai";
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
  usage: { calls: number; tokens: number; amount_usd: number };
  decisions: ConsistencyLabelMark[];
}

export interface AiAssistedHumanAdjudication {
  schema_version: typeof AI_ASSISTED_ADJUDICATION_VERSION;
  adjudicator_id: string;
  adjudicator_kind: "human";
  blind_attestation: true;
  dispute_pair_population_sha256: string;
  decisions: ConsistencyLabelMark[];
}

/** A user decision made after an AI advisor was deliberately shown. Never call this blind. */
export interface AiAssistedChatAdjudicationDecision extends ConsistencyLabelMark {
  human_reason: string;
}

/** Local, conversation-derived input before it is bound to an opaque human adjudicator ID. */
export interface AiAssistedChatAdjudicationProgress {
  schema_version: typeof AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION;
  status: "complete_pending_provenance_safe_finalization";
  adjudication_mode: "human_with_ai_advice";
  blind_attestation: false;
  dispute_worklist_sha256: string;
  decisions: AiAssistedChatAdjudicationDecision[];
}

/** Prototype-only output for a human who received AI advice while deciding every AI disagreement. */
export interface AiAssistedChatHumanAdjudication {
  schema_version: typeof AI_ASSISTED_CHAT_ADJUDICATION_VERSION;
  adjudicator_id: string;
  adjudicator_kind: "human";
  adjudication_mode: "human_with_ai_advice";
  blind_attestation: false;
  dispute_pair_population_sha256: string;
  decisions: AiAssistedChatAdjudicationDecision[];
}

export interface AiAssistedReceipt {
  schema_version: "a1-v2-ai-assisted-receipt-v1";
  status: "prototype_ai_assisted" | "ineligible";
  lock_eligible: false;
  binding: { worklist_sha256: string; pair_population_sha256: string };
  reviewers: Array<{
    reviewer_id: string; role: "validator" | "coverage"; model: string; thinking: boolean;
    prompt_sha256: string; submission_sha256: string;
  }>;
  disagreement: { count: number; case_ids_sha256: string; pair_population_sha256: string };
  issues: string[];
  note: string;
}

export interface AiAssistedFinalizationReceipt extends AiAssistedReceipt {
  final_dataset_sha256: string | null;
  final_distribution: { total: number; not_support: number; negative_types: Record<NegativeType, number> } | null;
  dataset_shape_issues: string[];
  human_adjudication_sha256: string | null;
}

export interface AiAssistedChatFinalizationReceipt extends AiAssistedFinalizationReceipt {
  human_adjudication_mode: "human_with_ai_advice";
  human_adjudication_blind_attestation: false;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};
const validLabel = (value: unknown): value is ConsistencyLabel => value === "support" || value === "uncertain" || value === "not_support";
const validNegativeType = (value: unknown): value is NegativeType => value === "exaggeration" || value === "out_of_context" || value === "misattribution";
const validDecision = (mark: Pick<ConsistencyLabelMark, "expected_consistency" | "negative_type">): boolean => (
  validLabel(mark.expected_consistency) && (mark.expected_consistency === "not_support" ? validNegativeType(mark.negative_type) : mark.negative_type == null)
);

export function pairPopulationSha(worklist: readonly Pick<BlindWorklistRow, "id" | "pair_sha256">[]): string {
  return hash(stable([...worklist].map(({ id, pair_sha256 }) => ({ id, pair_sha256 })).sort((a, b) => a.id.localeCompare(b.id))));
}

function caseIdsSha(rows: readonly Pick<BlindWorklistRow, "id">[]): string {
  return hash(rows.map((row) => row.id).sort().join("\n"));
}

function sameDecision(a: ConsistencyLabelMark, b: ConsistencyLabelMark): boolean {
  return a.expected_consistency === b.expected_consistency && a.negative_type === b.negative_type;
}

function validateDecisionPopulation(
  expected: ReadonlyMap<string, string>,
  decisions: readonly ConsistencyLabelMark[],
  label: string,
  requireReason: boolean,
): { issues: string[]; decisions: Map<string, ConsistencyLabelMark> } {
  const issues: string[] = [];
  const resolved = new Map<string, ConsistencyLabelMark>();
  for (const decision of decisions) {
    if (resolved.has(decision.case_id)) issues.push(`${label} 重复决定 ${decision.case_id}`);
    resolved.set(decision.case_id, decision);
    if (expected.get(decision.case_id) !== decision.pair_sha256) issues.push(`${label} 的 ${decision.case_id} pair hash 不匹配`);
    if (!validDecision(decision)) issues.push(`${label} 的 ${decision.case_id} 标签或 negative_type 无效`);
    if (requireReason && (!("human_reason" in decision) || typeof decision.human_reason !== "string" || !decision.human_reason.trim())) {
      issues.push(`${label} 的 ${decision.case_id} 缺少 human_reason`);
    }
  }
  for (const id of expected.keys()) if (!resolved.has(id)) issues.push(`${label} 缺少 ${id}`);
  return { issues, decisions: resolved };
}

/** Bind chat-derived, AI-advised human decisions to the exact label-free dispute population. */
export function bindAiAssistedChatAdjudication(
  disputes: readonly BlindWorklistRow[],
  disputeWorklistSha: string,
  progress: AiAssistedChatAdjudicationProgress,
  adjudicatorId: string,
): AiAssistedChatHumanAdjudication {
  const issues: string[] = [];
  const id = adjudicatorId.trim();
  if (!id) issues.push("human chat adjudicator_id 不可为空");
  if (progress.schema_version !== AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION) issues.push("human chat progress schema_version 不受支持");
  if (progress.status !== "complete_pending_provenance_safe_finalization") issues.push("human chat progress 未完成");
  if (progress.adjudication_mode !== "human_with_ai_advice" || progress.blind_attestation !== false) {
    issues.push("human chat progress 必须显式声明 human_with_ai_advice 且 blind_attestation=false");
  }
  if (progress.dispute_worklist_sha256 !== disputeWorklistSha) issues.push("human chat progress dispute worklist sha256 不匹配");
  const expected = new Map(disputes.map((row) => [row.id, row.pair_sha256]));
  issues.push(...validateDecisionPopulation(expected, progress.decisions, "human chat adjudication", true).issues);
  if (issues.length) throw new Error(`human chat adjudication 不合格：${issues.join("；")}`);
  return {
    schema_version: AI_ASSISTED_CHAT_ADJUDICATION_VERSION,
    adjudicator_id: id,
    adjudicator_kind: "human",
    adjudication_mode: "human_with_ai_advice",
    blind_attestation: false,
    dispute_pair_population_sha256: pairPopulationSha(disputes),
    decisions: progress.decisions,
  };
}

function validateAiSubmission(
  worklist: readonly BlindWorklistRow[],
  worklistSha: string,
  submission: AiAssistedReviewerSubmission,
  label: string,
): string[] {
  const issues: string[] = [];
  if (submission.schema_version !== AI_ASSISTED_REVIEW_VERSION) issues.push(`${label} schema_version 不受支持`);
  if (!submission.reviewer_id.trim() || submission.reviewer_kind !== "ai") issues.push(`${label} 必须是具名 AI reviewer`);
  if (submission.role !== "validator" && submission.role !== "coverage") issues.push(`${label} role 必须是 validator 或 coverage`);
  if (!submission.model.trim() || typeof submission.thinking !== "boolean" || !submission.prompt_sha256 || !submission.prompt_version
    || !submission.response_budget_version || !Number.isSafeInteger(submission.max_tokens) || submission.max_tokens < 1) {
    issues.push(`${label} 缺少模型、thinking、响应预算或 prompt provenance`);
  }
  if (submission.worklist_sha256 !== worklistSha) issues.push(`${label} worklist sha256 不匹配`);
  if (submission.pair_population_sha256 !== pairPopulationSha(worklist)) issues.push(`${label} pair population 不匹配`);
  const expected = new Map(worklist.map((row) => [row.id, row.pair_sha256]));
  const seen = new Set<string>();
  for (const decision of submission.decisions) {
    if (seen.has(decision.case_id)) issues.push(`${label} 重复决定 ${decision.case_id}`);
    seen.add(decision.case_id);
    const pairSha = expected.get(decision.case_id);
    if (!pairSha) issues.push(`${label} 含不属于 worklist 的 ${decision.case_id}`);
    else if (pairSha !== decision.pair_sha256) issues.push(`${label} 的 ${decision.case_id} pair hash 不匹配`);
    if (!validDecision(decision)) issues.push(`${label} 的 ${decision.case_id} 标签或 negative_type 无效`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push(`${label} 缺少 ${id}`);
  return issues;
}

export function compareAiAssistedReviews(
  worklist: readonly BlindWorklistRow[],
  worklistSha: string,
  first: AiAssistedReviewerSubmission,
  second: AiAssistedReviewerSubmission,
): { receipt: AiAssistedReceipt; disputes: BlindWorklistRow[] } {
  const issues = [
    ...validateAiSubmission(worklist, worklistSha, first, "ai_reviewer[0]"),
    ...validateAiSubmission(worklist, worklistSha, second, "ai_reviewer[1]"),
  ];
  if (first.reviewer_id === second.reviewer_id) issues.push("两份 AI reviewer_id 不可相同");
  if (first.model === second.model) issues.push("两位 AI reviewer 必须使用不同模型，不能把同一模型的两次调用写成独立 review");
  if (first.role === second.role) issues.push("两位 AI reviewer 必须使用不同 role");
  const firstById = new Map(first.decisions.map((decision) => [decision.case_id, decision]));
  const secondById = new Map(second.decisions.map((decision) => [decision.case_id, decision]));
  const disputes = worklist.filter((row) => {
    const a = firstById.get(row.id); const b = secondById.get(row.id);
    return a != null && b != null && !sameDecision(a, b);
  });
  const receipt: AiAssistedReceipt = {
    schema_version: "a1-v2-ai-assisted-receipt-v1",
    status: issues.length ? "ineligible" : "prototype_ai_assisted",
    lock_eligible: false,
    binding: { worklist_sha256: worklistSha, pair_population_sha256: pairPopulationSha(worklist) },
    reviewers: [first, second].map((reviewer) => ({
      reviewer_id: reviewer.reviewer_id, role: reviewer.role, model: reviewer.model, thinking: reviewer.thinking,
      prompt_sha256: reviewer.prompt_sha256, submission_sha256: hash(stable(reviewer)),
    })),
    disagreement: { count: disputes.length, case_ids_sha256: caseIdsSha(disputes), pair_population_sha256: pairPopulationSha(disputes) },
    issues,
    note: "prototype_ai_assisted 仅记录两位不同 AI 的辅助判断与人工分歧裁决入口；lock_eligible 永远为 false，不能代替正式双 human receipt、v2 lock、A1 baseline 或 DCP 证据。",
  };
  return { receipt, disputes };
}

function distribution(cases: readonly ConsistencyLabelCase[]) {
  const negative_types: Record<NegativeType, number> = { exaggeration: 0, out_of_context: 0, misattribution: 0 };
  const notSupport = cases.filter((entry) => entry.expected_consistency === "not_support");
  for (const entry of notSupport) if (entry.negative_type) negative_types[entry.negative_type]++;
  return { total: cases.length, not_support: notSupport.length, negative_types };
}

/** Build a final, prototype-only label JSONL after a human resolves every AI disagreement. */
export function finalizeAiAssistedReviews(
  worklist: readonly BlindWorklistRow[],
  worklistSha: string,
  first: AiAssistedReviewerSubmission,
  second: AiAssistedReviewerSubmission,
  adjudication: AiAssistedHumanAdjudication | null,
): { cases: ConsistencyLabelCase[]; receipt: AiAssistedFinalizationReceipt } {
  const compared = compareAiAssistedReviews(worklist, worklistSha, first, second);
  const issues = [...compared.receipt.issues];
  const disputes = compared.disputes;
  let adjudicationSha: string | null = null;
  const adjudicated = new Map<string, ConsistencyLabelMark>();
  if (disputes.length) {
    if (!adjudication) issues.push("AI 分歧存在但缺少 human adjudication");
    else {
      adjudicationSha = hash(stable(adjudication));
      if (adjudication.schema_version !== AI_ASSISTED_ADJUDICATION_VERSION || !adjudication.adjudicator_id.trim()
        || adjudication.adjudicator_kind !== "human" || adjudication.blind_attestation !== true) {
        issues.push("AI 分歧裁决必须由具名 human、blind-attested adjudicator 提交");
      }
      if (adjudication.dispute_pair_population_sha256 !== pairPopulationSha(disputes)) issues.push("human adjudication dispute population 不匹配");
      const validated = validateDecisionPopulation(new Map(disputes.map((row) => [row.id, row.pair_sha256])), adjudication.decisions, "human adjudication", false);
      issues.push(...validated.issues);
      for (const [id, decision] of validated.decisions) adjudicated.set(id, decision);
    }
  } else if (adjudication?.decisions.length) {
    issues.push("AI 无分歧时不得提交 human adjudication");
  }

  const firstById = new Map(first.decisions.map((decision) => [decision.case_id, decision]));
  const secondById = new Map(second.decisions.map((decision) => [decision.case_id, decision]));
  const cases = issues.length ? [] : worklist.map((row) => {
    const a = firstById.get(row.id)!;
    const b = secondById.get(row.id)!;
    const decision = sameDecision(a, b) ? a : adjudicated.get(row.id)!;
    return {
      id: row.id, statement: row.statement, source_text: row.source_text,
      expected_consistency: decision.expected_consistency,
      ...(decision.negative_type ? { negative_type: decision.negative_type } : {}),
    };
  });
  const finalBytes = cases.length ? Buffer.from(`${cases.map((entry) => JSON.stringify(entry)).join("\n")}\n`) : null;
  const stats = cases.length ? distribution(cases) : null;
  const dataset_shape_issues: string[] = [];
  if (stats) {
    if (stats.total < 100) dataset_shape_issues.push(`标签总数 ${stats.total}/100 未达 A1 样本下限`);
    if (stats.not_support < 40) dataset_shape_issues.push(`not_support ${stats.not_support}/40 未达 A1 样本下限`);
    for (const kind of ["exaggeration", "out_of_context", "misattribution"] as const) if (!stats.negative_types[kind]) dataset_shape_issues.push(`not_support 缺少 ${kind} 类型`);
  }
  return {
    cases,
    receipt: {
      ...compared.receipt,
      status: issues.length ? "ineligible" : "prototype_ai_assisted",
      issues,
      final_dataset_sha256: finalBytes ? hash(finalBytes) : null,
      final_distribution: stats,
      dataset_shape_issues,
      human_adjudication_sha256: adjudicationSha,
    },
  };
}

/**
 * Build a final prototype dataset when the human deliberately received AI advice in the chat.
 * This is separate from finalizeAiAssistedReviews so the blind-adjudication contract stays strict.
 */
export function finalizeAiAssistedChatReviews(
  worklist: readonly BlindWorklistRow[],
  worklistSha: string,
  first: AiAssistedReviewerSubmission,
  second: AiAssistedReviewerSubmission,
  adjudication: AiAssistedChatHumanAdjudication | null,
): { cases: ConsistencyLabelCase[]; receipt: AiAssistedChatFinalizationReceipt } {
  const compared = compareAiAssistedReviews(worklist, worklistSha, first, second);
  const issues = [...compared.receipt.issues];
  const disputes = compared.disputes;
  let adjudicationSha: string | null = null;
  const adjudicated = new Map<string, ConsistencyLabelMark>();
  if (disputes.length) {
    if (!adjudication) issues.push("AI 分歧存在但缺少 human_with_ai_advice adjudication");
    else {
      adjudicationSha = hash(stable(adjudication));
      if (adjudication.schema_version !== AI_ASSISTED_CHAT_ADJUDICATION_VERSION || !adjudication.adjudicator_id.trim()
        || adjudication.adjudicator_kind !== "human" || adjudication.adjudication_mode !== "human_with_ai_advice"
        || adjudication.blind_attestation !== false) {
        issues.push("AI 辅助 human adjudication 必须显式声明 human_with_ai_advice 且 blind_attestation=false");
      }
      if (adjudication.dispute_pair_population_sha256 !== pairPopulationSha(disputes)) issues.push("human_with_ai_advice adjudication dispute population 不匹配");
      const validated = validateDecisionPopulation(new Map(disputes.map((row) => [row.id, row.pair_sha256])), adjudication.decisions, "human_with_ai_advice adjudication", true);
      issues.push(...validated.issues);
      for (const [id, decision] of validated.decisions) adjudicated.set(id, decision);
    }
  } else if (adjudication?.decisions.length) {
    issues.push("AI 无分歧时不得提交 human_with_ai_advice adjudication");
  }

  const firstById = new Map(first.decisions.map((decision) => [decision.case_id, decision]));
  const secondById = new Map(second.decisions.map((decision) => [decision.case_id, decision]));
  const cases = issues.length ? [] : worklist.map((row) => {
    const a = firstById.get(row.id)!;
    const b = secondById.get(row.id)!;
    const decision = sameDecision(a, b) ? a : adjudicated.get(row.id)!;
    return {
      id: row.id, statement: row.statement, source_text: row.source_text,
      expected_consistency: decision.expected_consistency,
      ...(decision.negative_type ? { negative_type: decision.negative_type } : {}),
    };
  });
  const finalBytes = cases.length ? Buffer.from(`${cases.map((entry) => JSON.stringify(entry)).join("\n")}\n`) : null;
  const stats = cases.length ? distribution(cases) : null;
  const dataset_shape_issues: string[] = [];
  if (stats) {
    if (stats.total < 100) dataset_shape_issues.push(`标签总数 ${stats.total}/100 未达 A1 样本下限`);
    if (stats.not_support < 40) dataset_shape_issues.push(`not_support ${stats.not_support}/40 未达 A1 样本下限`);
    for (const kind of ["exaggeration", "out_of_context", "misattribution"] as const) if (!stats.negative_types[kind]) dataset_shape_issues.push(`not_support 缺少 ${kind} 类型`);
  }
  return {
    cases,
    receipt: {
      ...compared.receipt,
      status: issues.length ? "ineligible" : "prototype_ai_assisted",
      issues,
      note: "prototype_ai_assisted 记录两位不同 AI 的辅助判断，以及已获 AI advice 的 human 决定；blind_attestation=false，lock_eligible 永远为 false，不能代替正式双 human receipt、v2 lock、A1 baseline 或 DCP 证据。",
      final_dataset_sha256: finalBytes ? hash(finalBytes) : null,
      final_distribution: stats,
      dataset_shape_issues,
      human_adjudication_sha256: adjudicationSha,
      human_adjudication_mode: "human_with_ai_advice",
      human_adjudication_blind_attestation: false,
    },
  };
}

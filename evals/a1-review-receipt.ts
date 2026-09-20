/**
 * Verifier-backed, additive evidence for the A1 human review.  CSV/Sheets are convenient entry
 * surfaces only; this module binds two complete blind review submissions to immutable A1
 * artifacts before a receipt can say `eligible_for_signoff`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const REVIEW_RECEIPT_VERSION = "a1-review-receipt-v1";
export const REVIEW_MIN_ITEMS = 50;
export const REVIEW_MAX_HALLUCINATIONS = 1;

export interface ReviewMark {
  insight_id: string;
  insight_text_sha256: string;
  non_obvious: boolean;
  hallucination: boolean;
  importance_reasonable: boolean;
}

export interface BlindReviewerSubmission {
  reviewer_id: string;
  /**
   * The verifier only permits human submissions in a sign-off receipt.  `ai` is accepted by
   * the input shape solely to fail closed with an actionable diagnostic rather than letting a
   * prelabel be mistaken for a blind review.
   */
  reviewer_kind: "human" | "ai";
  /** Human attestation: tooling can verify identity separation and order, not a person's view. */
  blind_attestation: true;
  decisions: ReviewMark[];
}

export interface ReviewAdjudication {
  insight_id: string;
  adjudicator_id: string;
  /** As with reviewer_kind, only a human adjudicator may contribute to a sign-off receipt. */
  adjudicator_kind: "human" | "ai";
  decision: Omit<ReviewMark, "insight_id" | "insight_text_sha256">;
}

export interface A1ReviewBinding {
  run_id: string;
  manifest_sha256: string;
  queue_sha256: string;
  dataset_lock_sha256: string;
  insight_ids_sha256: string;
  insight_texts_sha256: string;
  insights: Array<{ id: string; text_sha256: string }>;
}

export interface ReviewReceipt {
  schema_version: typeof REVIEW_RECEIPT_VERSION;
  status: "eligible_for_signoff" | "ineligible";
  binding: Omit<A1ReviewBinding, "insights">;
  reviewer_submission_sha256: string[];
  adjudication_sha256: string | null;
  metrics: {
    reviewed: number;
    non_obvious: number;
    non_obvious_ratio: number;
    hallucinations: number;
    hallucination_ratio: number;
    importance_reasonable: number;
    importance_reasonable_ratio: number;
  };
  issues: string[];
  /** This is deliberately not a DCP approval; human owners/architects remain the sign-off gate. */
  note: string;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

/** Hash exactly what a reviewer can read, rather than trusting a row number or a mutable CSV. */
export function reviewableInsightTextHash(insight: Record<string, unknown>): string {
  const readerView = {
    id: insight.id,
    topic_id: insight.topic_id,
    statement: insight.statement,
    headline: insight.headline ?? "",
    importance: insight.importance,
    importance_basis: insight.importance_basis,
    statement_citation_index: insight.statement_citation_index ?? null,
    citations: insight.citations ?? [],
  };
  return hash(stable(readerView));
}

function idsHash(ids: readonly string[]): string {
  return hash([...ids].sort().join("\n"));
}

/** Reads both artifacts and verifies the queue hash already recorded in the run manifest. */
export function bindReviewArtifacts(manifestPath: string, queuePath: string): A1ReviewBinding {
  const manifestBytes = readFileSync(manifestPath);
  const queueBytes = readFileSync(queuePath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const queue = JSON.parse(queueBytes.toString("utf8")) as { run_id?: string; insights?: Array<Record<string, unknown>> };
  const artifacts = manifest.artifacts as Record<string, unknown> | undefined;
  const recordedQueueHash = artifacts?.["review-queue.json"];
  if (typeof manifest.run_id !== "string" || queue.run_id !== manifest.run_id) throw new Error("review queue 与 manifest 的 run_id 不一致");
  if (recordedQueueHash !== hash(queueBytes)) throw new Error("review queue sha256 未与 manifest 绑定，拒绝生成 receipt");
  const config = manifest.config as Record<string, unknown> | undefined;
  if (typeof config?.dataset_lock_sha256 !== "string" || !config.dataset_lock_sha256) throw new Error("manifest 缺少 dataset_lock_sha256");
  if (!Array.isArray(queue.insights)) throw new Error("review queue 缺少 insights");
  const insights = queue.insights.map((insight) => {
    if (typeof insight.id !== "string" || !insight.id) throw new Error("review queue 含无效 insight id");
    return { id: insight.id, text_sha256: reviewableInsightTextHash(insight) };
  });
  if (new Set(insights.map((item) => item.id)).size !== insights.length) throw new Error("review queue 含重复 insight id");
  const manifestInsights = manifest.insights as { count?: unknown; ids_sha256?: unknown } | undefined;
  if (manifestInsights?.count !== insights.length || manifestInsights.ids_sha256 !== idsHash(insights.map((item) => item.id))) {
    throw new Error("review queue 的 insight population 未与 manifest 绑定");
  }
  return {
    run_id: manifest.run_id,
    manifest_sha256: hash(manifestBytes),
    queue_sha256: hash(queueBytes),
    dataset_lock_sha256: config.dataset_lock_sha256,
    insight_ids_sha256: idsHash(insights.map((item) => item.id)),
    insight_texts_sha256: hash(stable([...insights].sort((a, b) => a.id.localeCompare(b.id)))),
    insights,
  };
}

function validateSubmission(binding: A1ReviewBinding, submission: BlindReviewerSubmission, label: string): string[] {
  const issues: string[] = [];
  if (!submission.reviewer_id.trim()) issues.push(`${label} 缺少 reviewer_id`);
  if (submission.reviewer_kind !== "human") {
    issues.push(`${label} 必须声明 reviewer_kind=human；AI 预标注不得作为盲评签署证据`);
  }
  if (submission.blind_attestation !== true) issues.push(`${label} 未作 blind_attestation`);
  const expected = new Map(binding.insights.map((item) => [item.id, item.text_sha256]));
  const seen = new Set<string>();
  for (const mark of submission.decisions) {
    if (seen.has(mark.insight_id)) issues.push(`${label} 重复评审 ${mark.insight_id}`);
    seen.add(mark.insight_id);
    const textHash = expected.get(mark.insight_id);
    if (!textHash) issues.push(`${label} 含不属于此 run 的 ${mark.insight_id}`);
    else if (textHash !== mark.insight_text_sha256) issues.push(`${label} 的 ${mark.insight_id} 文本 hash 不匹配`);
    if (typeof mark.non_obvious !== "boolean" || typeof mark.hallucination !== "boolean" || typeof mark.importance_reasonable !== "boolean") {
      issues.push(`${label} 的 ${mark.insight_id} 含非布尔评审结果`);
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push(`${label} 缺少 ${id}`);
  return issues;
}

const differs = (a: ReviewMark, b: ReviewMark): boolean => (
  a.non_obvious !== b.non_obvious
  || a.hallucination !== b.hallucination
  || a.importance_reasonable !== b.importance_reasonable
);

/** Produces a verifier result only. Writing it beside an A1 run is additive; neither the
 * manifest nor the queue can be silently rewritten to make an old review fit new evidence. */
export function verifyReviewReceipt(
  binding: A1ReviewBinding,
  reviewers: readonly BlindReviewerSubmission[],
  adjudications: readonly ReviewAdjudication[],
): ReviewReceipt {
  const issues: string[] = [];
  if (reviewers.length !== 2) issues.push("必须恰有两份独立盲评提交");
  const [first, second] = reviewers;
  if (!first || !second) {
    return ineligible(binding, reviewers, adjudications, issues, []);
  }
  if (first.reviewer_id === second.reviewer_id) issues.push("两份盲评 reviewer_id 不可相同");
  issues.push(...validateSubmission(binding, first, "reviewer[0]"), ...validateSubmission(binding, second, "reviewer[1]"));
  const firstById = new Map(first.decisions.map((mark) => [mark.insight_id, mark]));
  const secondById = new Map(second.decisions.map((mark) => [mark.insight_id, mark]));
  const disagreements = binding.insights.map((item) => item.id).filter((id) => {
    const a = firstById.get(id); const b = secondById.get(id);
    return a != null && b != null && differs(a, b);
  });
  const adjudicated = new Map<string, ReviewAdjudication>();
  for (const adjudication of adjudications) {
    if (adjudicated.has(adjudication.insight_id)) issues.push(`重复 adjudication：${adjudication.insight_id}`);
    adjudicated.set(adjudication.insight_id, adjudication);
    if (!disagreements.includes(adjudication.insight_id)) issues.push(`非分歧项不可 adjudicate：${adjudication.insight_id}`);
    if (!adjudication.adjudicator_id.trim() || adjudication.adjudicator_id === first.reviewer_id || adjudication.adjudicator_id === second.reviewer_id) {
      issues.push(`adjudicator 必须是不同于两位 reviewer 的第三人：${adjudication.insight_id}`);
    }
    if (adjudication.adjudicator_kind !== "human") {
      issues.push(`adjudicator 必须声明 adjudicator_kind=human；AI 预标注不得作为裁决签署证据：${adjudication.insight_id}`);
    }
    if (typeof adjudication.decision.non_obvious !== "boolean" || typeof adjudication.decision.hallucination !== "boolean" || typeof adjudication.decision.importance_reasonable !== "boolean") {
      issues.push(`adjudication 结果必须全为布尔值：${adjudication.insight_id}`);
    }
  }
  for (const id of disagreements) if (!adjudicated.has(id)) issues.push(`分歧项缺少 adjudication：${id}`);

  const finalMarks = binding.insights.flatMap((item) => {
    const initial = firstById.get(item.id);
    if (!initial) return [];
    const resolved = adjudicated.get(item.id)?.decision;
    return [{ ...initial, ...resolved }];
  });
  if (binding.insights.length < REVIEW_MIN_ITEMS) issues.push(`人评样本 ${binding.insights.length}/${REVIEW_MIN_ITEMS} 未达下限`);
  const hallucinations = finalMarks.filter((mark) => mark.hallucination).length;
  if (hallucinations > REVIEW_MAX_HALLUCINATIONS) issues.push(`幻觉 ${hallucinations}/${binding.insights.length} 超过最多 ${REVIEW_MAX_HALLUCINATIONS} 条`);
  return ineligible(binding, reviewers, adjudications, issues, finalMarks);
}

function ineligible(
  binding: A1ReviewBinding,
  reviewers: readonly BlindReviewerSubmission[],
  adjudications: readonly ReviewAdjudication[],
  issues: string[],
  marks: readonly ReviewMark[],
): ReviewReceipt {
  const reviewed = marks.length;
  const nonObvious = marks.filter((mark) => mark.non_obvious).length;
  const hallucinations = marks.filter((mark) => mark.hallucination).length;
  const importance = marks.filter((mark) => mark.importance_reasonable).length;
  return {
    schema_version: REVIEW_RECEIPT_VERSION,
    status: issues.length === 0 ? "eligible_for_signoff" : "ineligible",
    binding: {
      run_id: binding.run_id,
      manifest_sha256: binding.manifest_sha256,
      queue_sha256: binding.queue_sha256,
      dataset_lock_sha256: binding.dataset_lock_sha256,
      insight_ids_sha256: binding.insight_ids_sha256,
      insight_texts_sha256: binding.insight_texts_sha256,
    },
    reviewer_submission_sha256: reviewers.map((reviewer) => hash(stable(reviewer))),
    adjudication_sha256: adjudications.length ? hash(stable(adjudications)) : null,
    metrics: {
      reviewed,
      non_obvious: nonObvious,
      non_obvious_ratio: reviewed ? nonObvious / reviewed : 0,
      hallucinations,
      hallucination_ratio: reviewed ? hallucinations / reviewed : 0,
      importance_reasonable: importance,
      importance_reasonable_ratio: reviewed ? importance / reviewed : 0,
    },
    issues,
    note: "eligible_for_signoff 只表示自动门、锁定样本与双盲人评证据齐全；DCP 最终批准仍须人类 owner/architect 签署。n=50 时最多 1 条幻觉是样本点估计≤2%，不是总体保证。",
  };
}

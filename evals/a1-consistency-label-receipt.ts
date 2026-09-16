/**
 * Verifier-backed evidence for the controlled v2 consistency labels. The final JSONL remains in
 * the controlled runner; this receipt only contains hashes, IDs, aggregate counts, and opaque
 * reviewer identities. It makes a prose claim of “two human labels” insufficient for a v2 lock.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CONSISTENCY_LABEL_RECEIPT_VERSION = "a1-consistency-label-receipt-v1";
export const CONSISTENCY_LABEL_MIN_TOTAL = 100;
export const CONSISTENCY_LABEL_MIN_NOT_SUPPORT = 40;

export type ConsistencyLabel = "support" | "not_support" | "uncertain";
export type NegativeType = "exaggeration" | "out_of_context" | "misattribution";

export interface ConsistencyLabelCase {
  id: string;
  statement: string;
  source_text: string;
  expected_consistency: ConsistencyLabel;
  negative_type?: NegativeType;
}

export interface ConsistencyLabelMark {
  case_id: string;
  pair_sha256: string;
  expected_consistency: ConsistencyLabel;
  negative_type?: NegativeType;
}

export interface ConsistencyBlindReviewerSubmission {
  reviewer_id: string;
  reviewer_kind: "human" | "ai";
  blind_attestation: true;
  decisions: ConsistencyLabelMark[];
}

export interface ConsistencyLabelAdjudication {
  case_id: string;
  adjudicator_id: string;
  adjudicator_kind: "human" | "ai";
  decision: Omit<ConsistencyLabelMark, "case_id" | "pair_sha256">;
}

export interface ConsistencyLabelBinding {
  dataset_sha256: string;
  case_ids_sha256: string;
  pair_texts_sha256: string;
  cases: Array<{ id: string; pair_sha256: string; expected_consistency: ConsistencyLabel; negative_type?: NegativeType }>;
}

export interface ConsistencyLabelReceipt {
  schema_version: typeof CONSISTENCY_LABEL_RECEIPT_VERSION;
  status: "eligible_for_lock" | "ineligible";
  binding: Omit<ConsistencyLabelBinding, "cases">;
  reviewer_submission_sha256: string[];
  adjudication_sha256: string | null;
  distribution: { total: number; not_support: number; negative_types: Record<NegativeType, number> };
  issues: string[];
  note: string;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function isLabel(value: unknown): value is ConsistencyLabel {
  return value === "support" || value === "not_support" || value === "uncertain";
}

function isNegativeType(value: unknown): value is NegativeType {
  return value === "exaggeration" || value === "out_of_context" || value === "misattribution";
}

function validDecision(label: unknown, negativeType: unknown): boolean {
  return isLabel(label) && (label === "not_support" ? isNegativeType(negativeType) : negativeType == null);
}

/** Hash exactly the source pair a human labels, never a row position or its mutable label. */
export function consistencyPairHash(entry: Pick<ConsistencyLabelCase, "id" | "statement" | "source_text">): string {
  return hash(stable({ id: entry.id, statement: entry.statement, source_text: entry.source_text }));
}

function parseCase(value: unknown, index: number): ConsistencyLabelCase {
  if (value == null || typeof value !== "object") throw new Error(`consistency label row ${index} 不是对象`);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) throw new Error(`consistency label row ${index} 缺少稳定 id`);
  if (typeof row.statement !== "string" || !row.statement.trim() || typeof row.source_text !== "string" || !row.source_text.trim()) {
    throw new Error(`consistency label row ${row.id} 缺少 statement/source_text`);
  }
  if (!validDecision(row.expected_consistency, row.negative_type)) {
    throw new Error(`consistency label row ${row.id} 的标签或 negative_type 无效`);
  }
  return {
    id: row.id,
    statement: row.statement,
    source_text: row.source_text,
    expected_consistency: row.expected_consistency as ConsistencyLabel,
    ...(row.negative_type == null ? {} : { negative_type: row.negative_type as NegativeType }),
  };
}

/** Bind a final controlled JSONL to the exact human-readable pair population. */
export function bindConsistencyLabelDataset(path: string): ConsistencyLabelBinding {
  const bytes = readFileSync(path);
  const rows = bytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line, index) => parseCase(JSON.parse(line), index));
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`consistency label dataset 含重复 id：${row.id}`);
    ids.add(row.id);
  }
  const cases = rows.map((row) => ({
    id: row.id,
    pair_sha256: consistencyPairHash(row),
    expected_consistency: row.expected_consistency,
    ...(row.negative_type ? { negative_type: row.negative_type } : {}),
  }));
  return {
    dataset_sha256: hash(bytes),
    case_ids_sha256: hash([...ids].sort().join("\n")),
    pair_texts_sha256: hash(stable([...cases].map(({ id, pair_sha256 }) => ({ id, pair_sha256 })).sort((a, b) => a.id.localeCompare(b.id)))),
    cases,
  };
}

function marksDiffer(a: ConsistencyLabelMark, b: ConsistencyLabelMark): boolean {
  return a.expected_consistency !== b.expected_consistency || a.negative_type !== b.negative_type;
}

function validateSubmission(
  binding: ConsistencyLabelBinding,
  submission: ConsistencyBlindReviewerSubmission,
  label: string,
): string[] {
  const issues: string[] = [];
  if (!submission.reviewer_id.trim()) issues.push(`${label} 缺少 reviewer_id`);
  if (submission.reviewer_kind !== "human") issues.push(`${label} 必须声明 reviewer_kind=human；AI 预标注不能作为 v2 标签证据`);
  if (submission.blind_attestation !== true) issues.push(`${label} 未作 blind_attestation`);
  const expected = new Map(binding.cases.map((entry) => [entry.id, entry.pair_sha256]));
  const seen = new Set<string>();
  for (const mark of submission.decisions) {
    if (seen.has(mark.case_id)) issues.push(`${label} 重复标注 ${mark.case_id}`);
    seen.add(mark.case_id);
    const pairHash = expected.get(mark.case_id);
    if (!pairHash) issues.push(`${label} 含不属于此数据集的 ${mark.case_id}`);
    else if (pairHash !== mark.pair_sha256) issues.push(`${label} 的 ${mark.case_id} 原文对 hash 不匹配`);
    if (!validDecision(mark.expected_consistency, mark.negative_type)) issues.push(`${label} 的 ${mark.case_id} 标签或 negative_type 无效`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push(`${label} 缺少 ${id}`);
  return issues;
}

function distribution(cases: readonly ConsistencyLabelBinding["cases"][number][]) {
  const counts: Record<NegativeType, number> = { exaggeration: 0, out_of_context: 0, misattribution: 0 };
  const notSupport = cases.filter((entry) => entry.expected_consistency === "not_support");
  for (const entry of notSupport) if (entry.negative_type) counts[entry.negative_type]++;
  return { total: cases.length, not_support: notSupport.length, negative_types: counts };
}

function receipt(
  binding: ConsistencyLabelBinding,
  reviewers: readonly ConsistencyBlindReviewerSubmission[],
  adjudications: readonly ConsistencyLabelAdjudication[],
  issues: string[],
): ConsistencyLabelReceipt {
  const stats = distribution(binding.cases);
  return {
    schema_version: CONSISTENCY_LABEL_RECEIPT_VERSION,
    status: issues.length ? "ineligible" : "eligible_for_lock",
    binding: {
      dataset_sha256: binding.dataset_sha256,
      case_ids_sha256: binding.case_ids_sha256,
      pair_texts_sha256: binding.pair_texts_sha256,
    },
    reviewer_submission_sha256: reviewers.map((reviewer) => hash(stable(reviewer))),
    adjudication_sha256: adjudications.length ? hash(stable(adjudications)) : null,
    distribution: stats,
    issues,
    note: "eligible_for_lock 仅证明最终 consistency JSONL 与两份独立 human 盲标、必要的第三人裁决及分布下限相绑定；它不替代来源条款 owner 决策、两次完整 A1 或 DCP owner/architect 签署。",
  };
}

export function verifyConsistencyLabelReceipt(
  binding: ConsistencyLabelBinding,
  reviewers: readonly ConsistencyBlindReviewerSubmission[],
  adjudications: readonly ConsistencyLabelAdjudication[],
): ConsistencyLabelReceipt {
  const issues: string[] = [];
  if (reviewers.length !== 2) issues.push("必须恰有两份独立盲标提交");
  const [first, second] = reviewers;
  if (!first || !second) return receipt(binding, reviewers, adjudications, issues);
  if (first.reviewer_id === second.reviewer_id) issues.push("两份盲标 reviewer_id 不可相同");
  issues.push(...validateSubmission(binding, first, "reviewer[0]"), ...validateSubmission(binding, second, "reviewer[1]"));
  const firstById = new Map(first.decisions.map((mark) => [mark.case_id, mark]));
  const secondById = new Map(second.decisions.map((mark) => [mark.case_id, mark]));
  const disagreements = binding.cases.map((entry) => entry.id).filter((id) => {
    const a = firstById.get(id); const b = secondById.get(id);
    return a != null && b != null && marksDiffer(a, b);
  });
  const byAdjudicatedId = new Map<string, ConsistencyLabelAdjudication>();
  for (const adjudication of adjudications) {
    if (byAdjudicatedId.has(adjudication.case_id)) issues.push(`重复 adjudication：${adjudication.case_id}`);
    byAdjudicatedId.set(adjudication.case_id, adjudication);
    if (!disagreements.includes(adjudication.case_id)) issues.push(`非分歧项不可 adjudicate：${adjudication.case_id}`);
    if (!adjudication.adjudicator_id.trim() || adjudication.adjudicator_id === first.reviewer_id || adjudication.adjudicator_id === second.reviewer_id) {
      issues.push(`adjudicator 必须是不同于两位 reviewer 的第三人：${adjudication.case_id}`);
    }
    if (adjudication.adjudicator_kind !== "human") issues.push(`adjudicator 必须声明 adjudicator_kind=human：${adjudication.case_id}`);
    if (!validDecision(adjudication.decision.expected_consistency, adjudication.decision.negative_type)) {
      issues.push(`adjudication 的 ${adjudication.case_id} 标签或 negative_type 无效`);
    }
  }
  for (const id of disagreements) if (!byAdjudicatedId.has(id)) issues.push(`分歧项缺少 adjudication：${id}`);

  for (const entry of binding.cases) {
    const firstMark = firstById.get(entry.id);
    const secondMark = secondById.get(entry.id);
    if (!firstMark || !secondMark) continue;
    const final = byAdjudicatedId.get(entry.id)?.decision ?? firstMark;
    if (entry.expected_consistency !== final.expected_consistency || entry.negative_type !== final.negative_type) {
      issues.push(`最终 JSONL 的 ${entry.id} 未绑定两份盲标/裁决的最终标签`);
    }
  }
  const stats = distribution(binding.cases);
  if (stats.total < CONSISTENCY_LABEL_MIN_TOTAL) issues.push(`标签总数 ${stats.total}/${CONSISTENCY_LABEL_MIN_TOTAL} 未达下限`);
  if (stats.not_support < CONSISTENCY_LABEL_MIN_NOT_SUPPORT) issues.push(`not_support ${stats.not_support}/${CONSISTENCY_LABEL_MIN_NOT_SUPPORT} 未达下限`);
  for (const kind of ["exaggeration", "out_of_context", "misattribution"] as const) {
    if (!stats.negative_types[kind]) issues.push(`not_support 缺少 ${kind} 类型`);
  }
  return receipt(binding, reviewers, adjudications, issues);
}

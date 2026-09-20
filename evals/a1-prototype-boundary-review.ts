/**
 * Derive a new prototype-only consistency label pair from a post-run human boundary review.
 *
 * This is deliberately stricter than a JSON patch: the parent labels, parent receipt, review
 * progress and no-source binding manifest must all agree before any source-bearing JSONL is
 * emitted. It never overwrites an existing artifact and never makes labels lock-eligible.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { consistencyPairHash, type ConsistencyLabel, type ConsistencyLabelCase, type NegativeType } from "./a1-consistency-label-receipt.js";
import { publishVerifiedLocalPair } from "./a1-local-paired-artifact.js";

export const PROTOTYPE_BOUNDARY_REVIEW_BINDING_VERSION = "a1-v2-prototype-boundary-review-binding-v1";
export const PROTOTYPE_BOUNDARY_REVIEW_RECEIPT_VERSION = "a1-v2-prototype-boundary-review-receipt-v1";

type LabelOutcome = { expected_consistency: ConsistencyLabel; negative_type?: NegativeType };
/** Keep all parent fields byte-for-byte semantically intact except the explicitly reviewed label fields. */
type ParentCase = ConsistencyLabelCase & Record<string, unknown>;

interface ReviewDecision {
  case_index: number;
  original_human_label: ConsistencyLabel;
  original_negative_type?: NegativeType;
  final_human_label: ConsistencyLabel;
  negative_type?: NegativeType;
}

interface ReviewProgress {
  schema_version: "a1-v2-validator-boundary-review-progress-v1";
  run_id: string;
  purpose: string;
  status: "completed";
  decisions: ReviewDecision[];
}

interface BoundPair {
  case_index: number;
  id: string;
  pair_sha256: string;
}

interface BoundOverride {
  id: string;
  pair_sha256: string;
  from: LabelOutcome;
  to: LabelOutcome;
}

interface BoundaryReviewBinding {
  schema_version: typeof PROTOTYPE_BOUNDARY_REVIEW_BINDING_VERSION;
  status: "completed";
  promotion_limits: {
    prototype_only: true;
    receipt_status: "prototype_ai_assisted";
    lock_eligible: false;
    baseline_eligible: false;
    dcp_eligible: false;
  };
  parents: {
    final_labels: {
      sha256: string;
      receipt_sha256: string;
      receipt_schema_version: string;
      receipt_status: "prototype_ai_assisted";
      human_adjudication_mode: "human_with_ai_advice";
      human_adjudication_blind_attestation: false;
    };
    boundary_review: { run_id: string; sha256: string; decision_count: number };
  };
  reviewed_pairs: BoundPair[];
  final_output_overrides: BoundOverride[];
  summary: {
    reviewed_pairs: number;
    changed_label_count: number;
    changed_negative_type_count: number;
    changed_output_row_count: number;
  };
}

interface PrototypeParentReceipt {
  schema_version: string;
  status: "prototype_ai_assisted";
  lock_eligible: false;
  final_dataset_sha256: string;
  human_adjudication_mode: "human_with_ai_advice";
  human_adjudication_blind_attestation: false;
}

export interface PrototypeBoundaryReviewReceipt {
  schema_version: typeof PROTOTYPE_BOUNDARY_REVIEW_RECEIPT_VERSION;
  status: "prototype_ai_assisted";
  lock_eligible: false;
  human_adjudication_mode: "human_with_ai_advice";
  human_adjudication_blind_attestation: false;
  parent: {
    dataset_sha256: string;
    receipt_sha256: string;
    receipt_schema_version: string;
    receipt_status: "prototype_ai_assisted";
  };
  boundary_review: {
    run_id: string;
    progress_sha256: string;
    binding_sha256: string;
    reviewed_pair_count: number;
    changed_label_count: number;
    changed_negative_type_count: number;
    changed_output_row_count: number;
  };
  derived_dataset_sha256: string;
  distribution: { total: number; support: number; uncertain: number; not_support: number; negative_types: Record<NegativeType, number> };
  note: string;
}

export interface DerivedPrototypeBoundaryReview {
  datasetBytes: Buffer;
  receiptBytes: Buffer;
  receipt: PrototypeBoundaryReviewReceipt;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const isLabel = (value: unknown): value is ConsistencyLabel => value === "support" || value === "uncertain" || value === "not_support";
const isNegativeType = (value: unknown): value is NegativeType => value === "exaggeration" || value === "out_of_context" || value === "misattribution";

function assertOutcome(value: unknown, label: string): asserts value is LabelOutcome {
  if (!isRecord(value) || !isLabel(value.expected_consistency)) throw new Error(`${label} 缺少有效 expected_consistency`);
  if (value.expected_consistency === "not_support") {
    if (!isNegativeType(value.negative_type)) throw new Error(`${label} 的 not_support 必须有有效 negative_type`);
  } else if (value.negative_type != null) {
    throw new Error(`${label} 的 ${value.expected_consistency} 不得有 negative_type`);
  }
}

function sameOutcome(a: LabelOutcome, b: LabelOutcome): boolean {
  return a.expected_consistency === b.expected_consistency && a.negative_type === b.negative_type;
}

function assertCase(value: unknown, index: number): asserts value is ParentCase {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()
    || typeof value.statement !== "string" || !value.statement.trim()
    || typeof value.source_text !== "string" || !value.source_text.trim()) {
    throw new Error(`parent labels 第 ${index} 行格式无效`);
  }
  assertOutcome(value, `parent labels 第 ${index} 行`);
}

function parseParentCases(bytes: Buffer): ParentCase[] {
  const seen = new Set<string>();
  const rows = bytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const row = JSON.parse(line) as unknown;
    assertCase(row, index);
    if (seen.has(row.id)) throw new Error(`parent labels 含重复 id：${row.id}`);
    seen.add(row.id);
    // Do not reconstruct a narrow schema here. A controlled parent may carry additional
    // audit fields, and dropping any of them would make a supposedly label-only derivation
    // silently alter evidence.
    return { ...row };
  });
  if (!rows.length) throw new Error("parent labels 为空");
  return rows;
}

function parseParentReceipt(bytes: Buffer): PrototypeParentReceipt {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value) || typeof value.schema_version !== "string" || value.status !== "prototype_ai_assisted"
    || value.lock_eligible !== false || typeof value.final_dataset_sha256 !== "string"
    || value.human_adjudication_mode !== "human_with_ai_advice" || value.human_adjudication_blind_attestation !== false) {
    throw new Error("parent receipt 不是受限的 prototype_ai_assisted human_with_ai_advice receipt");
  }
  return value as unknown as PrototypeParentReceipt;
}

function parseReviewProgress(bytes: Buffer): ReviewProgress {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value) || value.schema_version !== "a1-v2-validator-boundary-review-progress-v1"
    || typeof value.run_id !== "string" || !value.run_id || typeof value.purpose !== "string"
    || value.status !== "completed" || !Array.isArray(value.decisions)) {
    throw new Error("boundary review progress 格式或完成状态无效");
  }
  const progress = value as unknown as ReviewProgress;
  const seen = new Set<number>();
  for (const [index, decision] of progress.decisions.entries()) {
    if (!isRecord(decision) || !Number.isSafeInteger(decision.case_index) || decision.case_index < 0
      || !isLabel(decision.original_human_label) || !isLabel(decision.final_human_label)) {
      throw new Error(`boundary review 第 ${index} 条格式无效`);
    }
    if (seen.has(decision.case_index)) throw new Error(`boundary review 重复 case_index：${decision.case_index}`);
    seen.add(decision.case_index);
    if (decision.original_human_label === "not_support") {
      if (!isNegativeType(decision.original_negative_type)) {
        throw new Error(`boundary review 第 ${index} 条 not_support 缺少 original_negative_type`);
      }
    } else if (decision.original_negative_type != null) {
      throw new Error(`boundary review 第 ${index} 条非 not_support 不得有 original_negative_type`);
    }
    if (decision.final_human_label === "not_support") {
      if (!isNegativeType(decision.negative_type)) throw new Error(`boundary review 第 ${index} 条 not_support 缺少 negative_type`);
    } else if (decision.negative_type != null) {
      throw new Error(`boundary review 第 ${index} 条非 not_support 不得有 negative_type`);
    }
  }
  return progress;
}

function parseBinding(bytes: Buffer): BoundaryReviewBinding {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value) || value.schema_version !== PROTOTYPE_BOUNDARY_REVIEW_BINDING_VERSION || value.status !== "completed"
    || !isRecord(value.promotion_limits) || value.promotion_limits.prototype_only !== true
    || value.promotion_limits.receipt_status !== "prototype_ai_assisted" || value.promotion_limits.lock_eligible !== false
    || value.promotion_limits.baseline_eligible !== false || value.promotion_limits.dcp_eligible !== false
    || !isRecord(value.parents) || !isRecord(value.parents.final_labels) || !isRecord(value.parents.boundary_review)
    || !Array.isArray(value.reviewed_pairs) || !Array.isArray(value.final_output_overrides) || !isRecord(value.summary)) {
    throw new Error("boundary review binding 格式或原型边界无效");
  }
  const binding = value as unknown as BoundaryReviewBinding;
  const labels = binding.parents.final_labels;
  if (!isHash(labels.sha256) || !isHash(labels.receipt_sha256) || typeof labels.receipt_schema_version !== "string"
    || labels.receipt_status !== "prototype_ai_assisted" || labels.human_adjudication_mode !== "human_with_ai_advice"
    || labels.human_adjudication_blind_attestation !== false) throw new Error("binding 父标签元数据无效");
  const review = binding.parents.boundary_review;
  if (typeof review.run_id !== "string" || !review.run_id || !isHash(review.sha256) || !Number.isSafeInteger(review.decision_count) || review.decision_count < 1) {
    throw new Error("binding boundary review 元数据无效");
  }
  const ids = new Set<string>();
  for (const [index, pair] of binding.reviewed_pairs.entries()) {
    if (!isRecord(pair) || !Number.isSafeInteger(pair.case_index) || pair.case_index < 0 || typeof pair.id !== "string" || !pair.id || !isHash(pair.pair_sha256)) {
      throw new Error(`binding reviewed_pairs 第 ${index} 条无效`);
    }
    if (ids.has(pair.id)) throw new Error(`binding reviewed_pairs 重复 id：${pair.id}`);
    ids.add(pair.id);
  }
  const overrideIds = new Set<string>();
  for (const [index, override] of binding.final_output_overrides.entries()) {
    if (!isRecord(override) || typeof override.id !== "string" || !override.id || !isHash(override.pair_sha256)) {
      throw new Error(`binding final_output_overrides 第 ${index} 条无效`);
    }
    assertOutcome(override.from, `binding override ${override.id} 的 from`);
    assertOutcome(override.to, `binding override ${override.id} 的 to`);
    if (sameOutcome(override.from, override.to)) throw new Error(`binding override ${override.id} 不得是空变更`);
    if (!ids.has(override.id) || overrideIds.has(override.id)) throw new Error(`binding override ${override.id} 未绑定或重复`);
    overrideIds.add(override.id);
  }
  if (binding.reviewed_pairs.length !== binding.parents.boundary_review.decision_count || binding.summary.reviewed_pairs !== binding.reviewed_pairs.length
    || binding.summary.changed_output_row_count !== binding.final_output_overrides.length) throw new Error("binding 汇总计数不一致");
  return binding;
}

function decisionOutcome(decision: ReviewDecision): LabelOutcome {
  return decision.final_human_label === "not_support"
    ? { expected_consistency: "not_support", negative_type: decision.negative_type! }
    : { expected_consistency: decision.final_human_label };
}

function sourceOutcome(row: Pick<ConsistencyLabelCase, "expected_consistency" | "negative_type">): LabelOutcome {
  return row.expected_consistency === "not_support"
    ? { expected_consistency: "not_support", negative_type: row.negative_type! }
    : { expected_consistency: row.expected_consistency };
}

function distribution(cases: readonly ParentCase[]): PrototypeBoundaryReviewReceipt["distribution"] {
  const negative_types: Record<NegativeType, number> = { exaggeration: 0, out_of_context: 0, misattribution: 0 };
  let support = 0;
  let uncertain = 0;
  let not_support = 0;
  for (const row of cases) {
    if (row.expected_consistency === "support") support++;
    else if (row.expected_consistency === "uncertain") uncertain++;
    else {
      not_support++;
      negative_types[row.negative_type!]++;
    }
  }
  return { total: cases.length, support, uncertain, not_support, negative_types };
}

function assertBoundReview(
  parent: readonly ParentCase[],
  review: ReviewProgress,
  binding: BoundaryReviewBinding,
): Map<string, LabelOutcome> {
  if (review.run_id !== binding.parents.boundary_review.run_id || review.decisions.length !== binding.parents.boundary_review.decision_count) {
    throw new Error("boundary review 与 binding 的 run 或决策数不匹配");
  }
  const boundByIndex = new Map(binding.reviewed_pairs.map((pair) => [pair.case_index, pair]));
  const overridesById = new Map(binding.final_output_overrides.map((override) => [override.id, override]));
  if (boundByIndex.size !== binding.reviewed_pairs.length) throw new Error("binding reviewed_pairs 含重复 case_index");
  const outcomes = new Map<string, LabelOutcome>();
  for (const decision of review.decisions) {
    const bound = boundByIndex.get(decision.case_index);
    const row = parent[decision.case_index];
    if (!bound || !row || bound.id !== row.id || bound.pair_sha256 !== consistencyPairHash(row)) {
      throw new Error(`boundary review case_index ${decision.case_index} 未与父标签的 id + pair hash 绑定`);
    }
    const original = sourceOutcome(row);
    if (original.expected_consistency !== decision.original_human_label
      || (decision.original_human_label === "not_support" && original.negative_type !== decision.original_negative_type)) {
      throw new Error(`boundary review ${row.id} 的旧标签与父标签不一致`);
    }
    const final = decisionOutcome(decision);
    const override = overridesById.get(row.id);
    if (sameOutcome(original, final)) {
      if (override) throw new Error(`binding 为未变化的 ${row.id} 声明了 override`);
    } else {
      if (!override || override.pair_sha256 !== bound.pair_sha256
        || !sameOutcome(override.from, original) || !sameOutcome(override.to, final)) {
        throw new Error(`binding override 未与 human boundary decision 精确匹配：${row.id}`);
      }
    }
    outcomes.set(row.id, final);
  }
  if (outcomes.size !== binding.reviewed_pairs.length || overridesById.size !== binding.final_output_overrides.length) {
    throw new Error("binding reviewed_pairs 或 overrides 存在未被 boundary review 消费的条目");
  }
  return outcomes;
}

/** Pure derivation used by both the controlled CLI and its counterexample tests. */
export function derivePrototypeBoundaryReview(
  parentBytes: Buffer,
  parentReceiptBytes: Buffer,
  reviewBytes: Buffer,
  bindingBytes: Buffer,
): DerivedPrototypeBoundaryReview {
  const parent = parseParentCases(parentBytes);
  const parentReceipt = parseParentReceipt(parentReceiptBytes);
  const review = parseReviewProgress(reviewBytes);
  const binding = parseBinding(bindingBytes);
  if (sha256(parentBytes) !== binding.parents.final_labels.sha256 || parentReceipt.final_dataset_sha256 !== sha256(parentBytes)) {
    throw new Error("父标签字节或 parent receipt final_dataset_sha256 不匹配 binding");
  }
  if (sha256(parentReceiptBytes) !== binding.parents.final_labels.receipt_sha256 || parentReceipt.schema_version !== binding.parents.final_labels.receipt_schema_version
    || parentReceipt.status !== binding.parents.final_labels.receipt_status || parentReceipt.lock_eligible !== binding.promotion_limits.lock_eligible
    || parentReceipt.human_adjudication_mode !== binding.parents.final_labels.human_adjudication_mode
    || parentReceipt.human_adjudication_blind_attestation !== binding.parents.final_labels.human_adjudication_blind_attestation) {
    throw new Error("父 receipt 与 binding 的 prototype 边界不匹配");
  }
  if (sha256(reviewBytes) !== binding.parents.boundary_review.sha256) throw new Error("boundary review bytes 与 binding 不匹配");
  const outcomes = assertBoundReview(parent, review, binding);
  const derived: ParentCase[] = parent.map((row) => {
    const outcome = outcomes.get(row.id) ?? sourceOutcome(row);
    // `negative_type` is part of the reviewed outcome. It must disappear only when the
    // reviewed label changes away from not_support; every other parent key is retained.
    const { negative_type: _parentNegativeType, ...withoutNegativeType } = row;
    return {
      ...withoutNegativeType,
      expected_consistency: outcome.expected_consistency,
      ...(outcome.expected_consistency === "not_support" ? { negative_type: outcome.negative_type! } : {}),
    };
  });
  const datasetBytes = Buffer.from(`${derived.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const changed = parent.flatMap((row, index) => sameOutcome(sourceOutcome(row), sourceOutcome(derived[index]!))
    ? []
    : [{ before: row, after: derived[index]! }]);
  const changedLabels = changed.filter(({ before, after }) => before.expected_consistency !== after.expected_consistency).length;
  const changedTypes = changed.length - changedLabels;
  if (changed.length !== binding.summary.changed_output_row_count || changedLabels !== binding.summary.changed_label_count
    || changedTypes !== binding.summary.changed_negative_type_count) throw new Error("派生输出变更计数与 binding 汇总不一致");
  const receipt: PrototypeBoundaryReviewReceipt = {
    schema_version: PROTOTYPE_BOUNDARY_REVIEW_RECEIPT_VERSION,
    status: "prototype_ai_assisted",
    lock_eligible: false,
    human_adjudication_mode: "human_with_ai_advice",
    human_adjudication_blind_attestation: false,
    parent: {
      dataset_sha256: sha256(parentBytes),
      receipt_sha256: sha256(parentReceiptBytes),
      receipt_schema_version: parentReceipt.schema_version,
      receipt_status: "prototype_ai_assisted",
    },
    boundary_review: {
      run_id: review.run_id,
      progress_sha256: sha256(reviewBytes),
      binding_sha256: sha256(bindingBytes),
      reviewed_pair_count: review.decisions.length,
      changed_label_count: changedLabels,
      changed_negative_type_count: changedTypes,
      changed_output_row_count: changed.length,
    },
    derived_dataset_sha256: sha256(datasetBytes),
    distribution: distribution(derived),
    note: "Post-run human_with_ai_advice boundary calibration for internal prototype diagnostics only. This derived receipt is not a formal label receipt, never lock-eligible, and cannot support baseline, DCP, or release-quality claims.",
  };
  return { datasetBytes, receiptBytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), receipt };
}

function readBytes(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`无法读取 ${label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function isStrictDescendant(path: string, directory: string): boolean {
  const remainder = relative(directory, path);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !remainder.startsWith("../");
}

function resolveExistingControlledFile(path: string, label: string, isolatedRoot: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (error) {
    throw new Error(`无法解析 ${label}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!statSync(canonical).isFile() || !isStrictDescendant(canonical, isolatedRoot)) {
    throw new Error(`${label} 必须是 EVAL_ISOLATED_ROOT 内的常规文件`);
  }
  return canonical;
}

function resolveNewControlledOutput(path: string, label: string, suffix: string, isolatedRoot: string, cwd: string): string {
  if (!path.endsWith(suffix)) throw new Error(`${label} 必须以 ${suffix} 结尾`);
  const absolute = resolve(cwd, path);
  const outputDirectory = dirname(absolute);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = realpathSync(outputDirectory);
  } catch (error) {
    throw new Error(`${label} 的目录必须已存在且位于 EVAL_ISOLATED_ROOT 内：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!statSync(canonicalDirectory).isDirectory()) throw new Error(`${label} 的父路径不是目录`);
  const canonical = resolve(canonicalDirectory, basename(absolute));
  if (!isStrictDescendant(canonical, isolatedRoot)) throw new Error(`${label} 必须位于 EVAL_ISOLATED_ROOT 内`);
  // `existsSync` follows symlinks and reports false for a dangling target, which would turn a
  // future writer into an escape hatch. lstat observes the path entry itself instead.
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} 不得是符号链接`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A new, non-symlink output is the normal publication case.
    } else {
      throw error;
    }
  }
  return canonical;
}

export interface PrototypeBoundaryReviewCliPaths {
  parentPath: string;
  parentReceiptPath: string;
  reviewPath: string;
  bindingPath: string;
  outputPath: string;
  outputReceiptPath: string;
}

/**
 * Source-bearing prototype JSONL may only be read and emitted under an explicitly supplied,
 * non-repository controlled root. Resolve every existing path before the derivation, and resolve
 * the output directory before publishing, so `..` and symlink escapes fail before any write.
 */
export function resolvePrototypeBoundaryReviewCliPaths(
  paths: readonly string[],
  environment: { EVAL_ISOLATED_ROOT?: string } = { EVAL_ISOLATED_ROOT: process.env.EVAL_ISOLATED_ROOT },
  cwd = process.cwd(),
): PrototypeBoundaryReviewCliPaths {
  const [parentPath, parentReceiptPath, reviewPath, bindingPath, outputPath, outputReceiptPath] = paths;
  if (!parentPath || !parentReceiptPath || !reviewPath || !bindingPath || !outputPath || !outputReceiptPath) {
    throw new Error("用法：EVAL_ISOLATED_ROOT=<controlled-root> tsx evals/a1-prototype-boundary-review.ts <parent.local.jsonl> <parent-receipt.local.json> <review.json> <binding.json> <derived.local.jsonl> <derived-receipt.local.json>");
  }
  const rootValue = environment.EVAL_ISOLATED_ROOT?.trim();
  if (!rootValue) throw new Error("必须显式设置 EVAL_ISOLATED_ROOT，拒绝向未受控目录写入 source-bearing prototype JSONL");
  let isolatedRoot: string;
  try {
    isolatedRoot = realpathSync(resolve(cwd, rootValue));
  } catch (error) {
    throw new Error(`无法解析 EVAL_ISOLATED_ROOT：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!statSync(isolatedRoot).isDirectory()) throw new Error("EVAL_ISOLATED_ROOT 必须是已存在的目录");
  const repositoryRoot = realpathSync(cwd);
  if (isolatedRoot === repositoryRoot || isStrictDescendant(isolatedRoot, repositoryRoot)) {
    throw new Error("EVAL_ISOLATED_ROOT 不得位于仓库内");
  }
  return {
    parentPath: resolveExistingControlledFile(parentPath, "parent labels", isolatedRoot, cwd),
    parentReceiptPath: resolveExistingControlledFile(parentReceiptPath, "parent receipt", isolatedRoot, cwd),
    reviewPath: resolveExistingControlledFile(reviewPath, "boundary review", isolatedRoot, cwd),
    bindingPath: resolveExistingControlledFile(bindingPath, "boundary binding", isolatedRoot, cwd),
    outputPath: resolveNewControlledOutput(outputPath, "派生 prototype labels", ".local.jsonl", isolatedRoot, cwd),
    outputReceiptPath: resolveNewControlledOutput(outputReceiptPath, "派生 prototype receipt", ".local.json", isolatedRoot, cwd),
  };
}

function main(): void {
  const paths = resolvePrototypeBoundaryReviewCliPaths(process.argv.slice(2));
  const result = derivePrototypeBoundaryReview(
    readBytes(paths.parentPath, "parent labels"),
    readBytes(paths.parentReceiptPath, "parent receipt"),
    readBytes(paths.reviewPath, "boundary review"),
    readBytes(paths.bindingPath, "boundary binding"),
  );
  const status = publishVerifiedLocalPair(
    { path: paths.outputPath, bytes: result.datasetBytes, label: "派生 prototype labels" },
    { path: paths.outputReceiptPath, bytes: result.receiptBytes, label: "派生 prototype receipt" },
  );
  console.log(`${status}：${result.receipt.distribution.total} 条派生 prototype 标签；lock_eligible=false；receipt=${paths.outputReceiptPath}`);
}

if (process.argv[1]?.endsWith("a1-prototype-boundary-review.ts")) {
  main();
}

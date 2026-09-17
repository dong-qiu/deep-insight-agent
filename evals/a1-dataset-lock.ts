/**
 * A1 dataset locks bind a score to exact input bytes and to the provenance needed to decide
 * whether that score may become DCP evidence.  A committed fixture can still be useful for
 * regression tests, but it is deliberately not equivalent to a controlled external snapshot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  bindConsistencyLabelDataset,
  CONSISTENCY_LABEL_RECEIPT_VERSION,
  type ConsistencyLabelBinding,
} from "./a1-consistency-label-receipt.js";

export const DATASET_LOCK_VERSION = "a1-dataset-lock-v1";

export interface LockedFile {
  path: string;
  sha256: string;
}

export interface DatasetLock {
  schema_version: typeof DATASET_LOCK_VERSION;
  id: string;
  /** Legacy fixtures remain runnable but cannot be promoted. */
  tier: "legacy_repository_fixture" | "controlled_snapshot_v2";
  snapshot: {
    immutable_reference: string;
    collected_at: string;
    /** A manifest outside the source body that lists source URL/ID and provenance. */
    source_manifest_reference?: string;
    source_manifest_sha256?: string;
    license_and_retention: string;
    /** v2 snapshots must preserve the immutable retention boundary that the owner approved. */
    object_lock_retain_until?: string;
    /**
     * An opaque, hashed record in controlled evidence.  The verifier cannot decide copyright
     * terms; it can only refuse promotion unless the accountable owner recorded an all-source
     * approval whose permitted retention covers the immutable body snapshot.
     */
    source_terms_decision?: {
      record_id: string;
      sha256: string;
      status: "approved_all" | "blocked" | "pending";
      approved_at: string;
      permitted_retention_until: string;
    };
  };
  files: {
    quality: LockedFile;
    consistency: LockedFile;
    display_coverage: LockedFile;
  };
  quality_contract: {
    min_unique_topics: number;
    dedupe_key: "content_item_id_or_url";
  };
  consistency_contract: {
    min_total: number;
    min_not_support: number;
    required_negative_types: readonly ["exaggeration", "out_of_context", "misattribution"];
  };
  /** The v2 selection/labeling rules are versioned with the bytes they governed. */
  topic_mapping_rule: string;
  /** Legacy fixtures retain a description; v2 must bind the final JSONL to a human-label receipt. */
  labeling_provenance: string | {
    receipt_reference: string;
    receipt_sha256: string;
    status: "eligible_for_lock" | "ineligible";
  };
}

export interface DatasetFiles {
  qualityFile: string;
  consistencyFile: string;
  displayCoverageFixture: string;
  /** Local controlled copy of the receipt named by the immutable lock reference. Never needed for legacy fixtures. */
  consistencyReceiptFile?: string;
}

export interface DatasetLockValidation {
  lock_sha256: string;
  status: "verified_legacy" | "verified_v2" | "invalid";
  promotion_eligible: boolean;
  issues: string[];
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export function sha256DatasetFile(path: string): string {
  return sha256(readFileSync(path));
}

export function loadDatasetLock(path: string): DatasetLock {
  const lock = JSON.parse(readFileSync(path, "utf8")) as DatasetLock;
  if (lock.schema_version !== DATASET_LOCK_VERSION) {
    throw new Error(`不支持的 A1 dataset lock 版本：${String(lock.schema_version)}`);
  }
  return lock;
}

/** Only repository-owned fixture paths are eligible for byte validation.  A v2 external snapshot
 * is referenced by its immutable manifest; its body must be injected into a controlled runner,
 * never smuggled in through an arbitrary local path. */
function fixturePath(root: string, path: string): string | null {
  if (!path || path.includes("\0")) return null;
  const datasetRoot = resolve(root, "evals", "dataset");
  const absolute = resolve(root, path);
  const rel = relative(datasetRoot, absolute);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? absolute : null;
}

function jsonl(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Hex(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function equalBinding(value: unknown, binding: ConsistencyLabelBinding): boolean {
  const received = object(value);
  return received != null
    && received.dataset_sha256 === binding.dataset_sha256
    && received.case_ids_sha256 === binding.case_ids_sha256
    && received.pair_texts_sha256 === binding.pair_texts_sha256;
}

function distributionMatchesBinding(value: unknown, binding: ConsistencyLabelBinding): boolean {
  const received = object(value);
  const receivedNegativeTypes = object(received?.negative_types);
  const notSupport = binding.cases.filter((entry) => entry.expected_consistency === "not_support");
  const expected = {
    total: binding.cases.length,
    not_support: notSupport.length,
    negative_types: {
      exaggeration: notSupport.filter((entry) => entry.negative_type === "exaggeration").length,
      out_of_context: notSupport.filter((entry) => entry.negative_type === "out_of_context").length,
      misattribution: notSupport.filter((entry) => entry.negative_type === "misattribution").length,
    },
  };
  return received != null && received.total === expected.total && received.not_support === expected.not_support
    && receivedNegativeTypes != null
    && receivedNegativeTypes.exaggeration === expected.negative_types.exaggeration
    && receivedNegativeTypes.out_of_context === expected.negative_types.out_of_context
    && receivedNegativeTypes.misattribution === expected.negative_types.misattribution;
}

/**
 * A v2 lock is a decision over actual receipt bytes, not a declaration containing a URL and a
 * hash-shaped string. The receipt has no source body, so the controlled runner can inject it
 * alongside the three locked fixture files without expanding raw-content exposure.
 */
function validateControlledLabelReceipt(
  labels: Record<string, unknown>,
  consistencyPath: string | undefined,
  receiptFile: string | undefined,
  root: string,
): string[] {
  const issues: string[] = [];
  if (!consistencyPath) return ["v2 dataset lock 无法验证 consistency JSONL 与标签 receipt 绑定"];
  const receiptPath = receiptFile && fixturePath(root, receiptFile);
  if (!receiptPath) return ["v2 dataset lock 必须提供位于 evals/dataset/ 的实际 consistency label receipt 文件"];
  let bytes: Buffer;
  let receipt: Record<string, unknown> | null;
  try {
    bytes = readFileSync(receiptPath);
    receipt = object(JSON.parse(bytes.toString("utf8")));
  } catch {
    return ["v2 dataset lock 的 consistency label receipt 不可读取或不是 JSON 对象"];
  }
  if (labels.receipt_sha256 !== sha256(bytes)) issues.push("consistency label receipt sha256 与 dataset lock 不一致");
  if (!receipt || receipt.schema_version !== CONSISTENCY_LABEL_RECEIPT_VERSION) {
    issues.push("consistency label receipt schema_version 不受支持；AI-assisted/prototype receipt 不可用于 v2 lock");
    return issues;
  }
  if (receipt.status !== "eligible_for_lock" || !Array.isArray(receipt.issues) || receipt.issues.length !== 0) {
    issues.push("consistency label receipt 未处于无问题的 eligible_for_lock 状态");
  }
  let binding: ConsistencyLabelBinding;
  try {
    binding = bindConsistencyLabelDataset(consistencyPath);
  } catch {
    return [...issues, "无法从 consistency JSONL 建立 receipt 校验绑定"];
  }
  if (!equalBinding(receipt.binding, binding)) issues.push("consistency label receipt 未绑定当前 consistency JSONL 的 bytes、ID 和原文对 hash");
  if (!distributionMatchesBinding(receipt.distribution, binding)) issues.push("consistency label receipt 的分布与当前 consistency JSONL 不一致");

  const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers.map(object) : null;
  const submissionHashes = Array.isArray(receipt.reviewer_submission_sha256) ? receipt.reviewer_submission_sha256 : null;
  if (!reviewers || reviewers.length !== 2 || !submissionHashes || submissionHashes.length !== 2) {
    issues.push("consistency label receipt 必须记录恰两位 human reviewer 及其提交 hash");
  } else {
    const ids = new Set<string>();
    for (const [index, reviewer] of reviewers.entries()) {
      if (!reviewer || !nonEmpty(reviewer.reviewer_id) || reviewer.reviewer_kind !== "human" || reviewer.blind_attestation !== true
        || !sha256Hex(reviewer.submission_sha256) || reviewer.submission_sha256 !== submissionHashes[index]) {
        issues.push(`consistency label receipt reviewer[${index}] 不是已绑定的独立 human 盲标提交`);
      }
      if (reviewer && nonEmpty(reviewer.reviewer_id)) {
        if (ids.has(reviewer.reviewer_id as string)) issues.push("consistency label receipt 的两位 reviewer_id 不可相同");
        ids.add(reviewer.reviewer_id as string);
      }
    }
  }
  const adjudicators = Array.isArray(receipt.adjudicators) ? receipt.adjudicators.map(object) : null;
  if (!adjudicators) {
    issues.push("consistency label receipt 缺少 adjudicator provenance");
  } else {
    const reviewerIds = new Set((reviewers ?? []).flatMap((reviewer) => reviewer && nonEmpty(reviewer.reviewer_id) ? [reviewer.reviewer_id] : []));
    const ids = new Set<string>();
    for (const [index, adjudicator] of adjudicators.entries()) {
      if (!adjudicator || !nonEmpty(adjudicator.adjudicator_id) || adjudicator.adjudicator_kind !== "human"
        || !Number.isSafeInteger(adjudicator.adjudication_count) || (adjudicator.adjudication_count as number) < 1) {
        issues.push(`consistency label receipt adjudicator[${index}] 不是有效的 human provenance`);
        continue;
      }
      const id = adjudicator.adjudicator_id as string;
      if (reviewerIds.has(id) || ids.has(id)) issues.push("consistency label receipt adjudicator 必须是不同于 reviewer 的第三人");
      ids.add(id);
    }
    if ((adjudicators.length === 0 && receipt.adjudication_sha256 !== null)
      || (adjudicators.length > 0 && !sha256Hex(receipt.adjudication_sha256))) {
      issues.push("consistency label receipt adjudication hash 与 provenance 不一致");
    }
  }
  return issues;
}

/** The owner record and Object Lock dates are UTC instants so their order is unambiguous. */
function utcInstant(value: unknown): number | null {
  // S3 Object Lock returns RFC 3339 UTC instants with microseconds (for example `.960000Z`).
  // Keep the exact evidence string in the lock rather than rounding its retention boundary.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
}

/**
 * Validate both bytes and the minimum semantic distribution.  The latter is intentionally
 * repeated here rather than inferred from a human checklist: a lock with 100 identical positive
 * pairs cannot accidentally pass as an A1 consistency dataset.
 */
export function validateDatasetLock(lockPath: string, files: DatasetFiles, root = process.cwd()): DatasetLockValidation {
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8")) as DatasetLock;
  const issues: string[] = [];
  const lock_sha256 = sha256(lockBytes);
  if (lock.schema_version !== DATASET_LOCK_VERSION) issues.push("dataset lock schema_version 不受支持");
  if (!nonEmpty(lock.id)) issues.push("dataset lock 缺少 id");
  if (lock.tier !== "legacy_repository_fixture" && lock.tier !== "controlled_snapshot_v2") issues.push("dataset lock tier 不受支持");
  if (!nonEmpty(lock.snapshot?.immutable_reference) || !nonEmpty(lock.snapshot?.collected_at) || !nonEmpty(lock.snapshot?.license_and_retention)) {
    issues.push("dataset lock 缺少不可变快照、采集时间或 license/retention");
  }
  if (lock.tier === "controlled_snapshot_v2" && (!nonEmpty(lock.snapshot?.source_manifest_reference) || !nonEmpty(lock.snapshot?.source_manifest_sha256))) {
    issues.push("v2 dataset lock 必须绑定来源 URL/ID manifest 及其 sha256");
  }
  if (lock.tier === "controlled_snapshot_v2") {
    const decision = lock.snapshot?.source_terms_decision;
    const objectLockRetainUntil = utcInstant(lock.snapshot?.object_lock_retain_until);
    if (objectLockRetainUntil === null) {
      issues.push("v2 dataset lock 必须记录有效的 Object Lock 保留截止 UTC");
    }
    if (!decision || !nonEmpty(decision.record_id) || !sha256Hex(decision.sha256) || utcInstant(decision.approved_at) === null || utcInstant(decision.permitted_retention_until) === null) {
      issues.push("v2 dataset lock 必须绑定完整且已哈希的来源条款 owner 决策");
    } else {
      if (decision.status !== "approved_all") issues.push("来源条款 owner 决策未获全部批准");
      const permittedRetentionUntil = utcInstant(decision.permitted_retention_until);
      if (objectLockRetainUntil !== null && permittedRetentionUntil !== null && permittedRetentionUntil < objectLockRetainUntil) {
        issues.push("来源许可保留期早于 Object Lock 保留期");
      }
    }
    const labels = lock.labeling_provenance;
    if (labels == null || typeof labels !== "object" || Array.isArray(labels)
      || !nonEmpty((labels as Record<string, unknown>).receipt_reference)
      || !sha256Hex((labels as Record<string, unknown>).receipt_sha256)
      || (labels as Record<string, unknown>).status !== "eligible_for_lock") {
      issues.push("v2 dataset lock 必须绑定 eligible_for_lock 的双人标签 receipt 引用及 sha256");
    }
  }

  const pairs: Array<[keyof DatasetLock["files"], string]> = [
    ["quality", files.qualityFile],
    ["consistency", files.consistencyFile],
    ["display_coverage", files.displayCoverageFixture],
  ];
  const resolvedFiles: Partial<Record<keyof DatasetLock["files"], string>> = {};
  for (const [key, actualPath] of pairs) {
    const expected = lock.files?.[key];
    if (!expected || !nonEmpty(expected.path) || !nonEmpty(expected.sha256)) {
      issues.push(`dataset lock 缺少 ${key} 文件指纹`);
      continue;
    }
    const expectedPath = fixturePath(root, expected.path);
    const currentPath = fixturePath(root, actualPath);
    if (!expectedPath || !currentPath) {
      issues.push(`${key} 文件必须位于 evals/dataset/，拒绝路径穿越或外部文件`);
      continue;
    }
    resolvedFiles[key] = currentPath;
    if (expectedPath !== currentPath) issues.push(`${key} 文件与 dataset lock 不一致`);
    try {
      if (sha256DatasetFile(currentPath) !== expected.sha256) issues.push(`${key} 文件 sha256 与 dataset lock 不一致`);
    } catch {
      issues.push(`${key} 文件不可读取`);
    }
  }

  try {
    if (!resolvedFiles.quality) throw new Error("quality path rejected");
    const quality = jsonl(resolvedFiles.quality) as Array<{ topic?: { id?: string } }>;
    const topics = new Set(quality.map((item) => item.topic?.id).filter(nonEmpty));
    if (topics.size < (lock.quality_contract?.min_unique_topics ?? Infinity)) {
      issues.push(`quality 唯一 topic 数 ${topics.size} 未达 lock 下限`);
    }
  } catch {
    issues.push("quality JSONL 无法解析");
  }
  try {
    if (!resolvedFiles.consistency) throw new Error("consistency path rejected");
    const consistency = jsonl(resolvedFiles.consistency) as Array<{ expected_consistency?: string; negative_type?: string }>;
    const notSupport = consistency.filter((item) => item.expected_consistency === "not_support");
    if (consistency.length < (lock.consistency_contract?.min_total ?? Infinity)) issues.push(`consistency 总数 ${consistency.length} 未达 lock 下限`);
    if (notSupport.length < (lock.consistency_contract?.min_not_support ?? Infinity)) issues.push(`consistency not_support 数 ${notSupport.length} 未达 lock 下限`);
    for (const negativeType of lock.consistency_contract?.required_negative_types ?? []) {
      if (!notSupport.some((item) => item.negative_type === negativeType)) issues.push(`consistency 缺少 ${negativeType} 反例`);
    }
  } catch {
    issues.push("consistency JSONL 无法解析");
  }
  if (lock.tier === "controlled_snapshot_v2" && object(lock.labeling_provenance)) {
    issues.push(...validateControlledLabelReceipt(
      object(lock.labeling_provenance)!,
      resolvedFiles.consistency,
      files.consistencyReceiptFile,
      root,
    ));
  }

  const valid = issues.length === 0;
  return {
    lock_sha256,
    status: valid ? (lock.tier === "controlled_snapshot_v2" ? "verified_v2" : "verified_legacy") : "invalid",
    promotion_eligible: valid && lock.tier === "controlled_snapshot_v2",
    issues,
  };
}

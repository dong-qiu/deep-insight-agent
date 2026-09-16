/**
 * A1 dataset locks bind a score to exact input bytes and to the provenance needed to decide
 * whether that score may become DCP evidence.  A committed fixture can still be useful for
 * regression tests, but it is deliberately not equivalent to a controlled external snapshot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

  const valid = issues.length === 0;
  return {
    lock_sha256,
    status: valid ? (lock.tier === "controlled_snapshot_v2" ? "verified_v2" : "verified_legacy") : "invalid",
    promotion_eligible: valid && lock.tier === "controlled_snapshot_v2",
    issues,
  };
}

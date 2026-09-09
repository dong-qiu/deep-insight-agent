/** Baseline promotion is intentionally a two-run state machine.  The legacy aggregate baseline
 * remains readable for historical context, but cannot certify a changed contract. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EVAL_CONFIG_KEYS, sameEvalConfig, type EvalConfig } from "./a1-config.js";

export const BASELINE_REGISTRY_VERSION = "a1-baseline-registry-v1";

export type BaselineStatus = "legacy" | "provisional" | "dcp_accepted";

export interface BaselineCandidate {
  run_id: string;
  stratum: string;
  manifest_sha256: string;
  a1_run_sha256: string;
  config: EvalConfig;
  source: { commit: string | null; dirty_fingerprint: string | null };
  smoke: boolean;
  status: "completed" | "failed";
  auto_gate: "pass" | "fail" | "smoke" | "not_evaluated";
}

export interface BaselineRecord extends Omit<BaselineCandidate, "status"> {
  status: BaselineStatus;
  promoted_at: string;
}

export interface BaselinePromotion {
  next: BaselineRecord | null;
  reasons: string[];
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function isCompleteEvalConfig(value: unknown): value is EvalConfig {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return EVAL_CONFIG_KEYS.every((key) => Object.hasOwn(object, key));
}

/** Ensure the copied `a1-run.json` is the artifact whose hash the manifest recorded. */
export function baselineCandidateFromArtifacts(manifestPath: string, a1RunPath: string, stratum: string): BaselineCandidate {
  const manifestBytes = readFileSync(manifestPath);
  const a1RunBytes = readFileSync(a1RunPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const run = JSON.parse(a1RunBytes.toString("utf8")) as Record<string, unknown>;
  const artifacts = manifest.artifacts as Record<string, unknown> | undefined;
  if (artifacts?.["a1-run.json"] !== sha256(a1RunBytes)) throw new Error("a1-run.json sha256 与 manifest 不匹配");
  if (manifest.run_id !== run.run_id || typeof manifest.run_id !== "string") throw new Error("a1-run 与 manifest 的 run_id 不匹配");
  if (!isCompleteEvalConfig(manifest.config) || !isCompleteEvalConfig(run.config) || !sameEvalConfig(run.config as unknown as Record<string, unknown>, manifest.config)) {
    throw new Error("A1 config 缺失或 a1-run 与 manifest 不一致");
  }
  const source = manifest.source as BaselineCandidate["source"] | undefined;
  const dataset = manifest.dataset as { smoke?: unknown } | undefined;
  if (!source || typeof source.commit !== "string" && source.commit !== null || typeof source.dirty_fingerprint !== "string" && source.dirty_fingerprint !== null) {
    throw new Error("manifest 缺少 source state");
  }
  if (typeof dataset?.smoke !== "boolean") throw new Error("manifest 缺少 smoke state");
  if (!stratum.trim()) throw new Error("baseline stratum 不可为空");
  return {
    run_id: manifest.run_id,
    stratum,
    manifest_sha256: sha256(manifestBytes),
    a1_run_sha256: sha256(a1RunBytes),
    config: manifest.config,
    source,
    smoke: dataset.smoke,
    status: manifest.status as BaselineCandidate["status"],
    auto_gate: manifest.auto_gate as BaselineCandidate["auto_gate"],
  };
}

function candidateIssues(candidate: BaselineCandidate): string[] {
  const issues: string[] = [];
  if (candidate.status !== "completed" || candidate.auto_gate !== "pass") issues.push("只有完整 automatic pass 才能作为 baseline candidate");
  if (candidate.smoke) issues.push("smoke run 不能提升 baseline");
  if (!candidate.source.commit || candidate.source.dirty_fingerprint !== null) issues.push("baseline candidate 必须来自 clean commit");
  if (candidate.config.dataset_lock_status !== "verified_v2") issues.push("baseline candidate 必须使用 verified_v2 dataset lock");
  if (candidate.config.coverage_thinking_source !== "explicit") issues.push("baseline candidate 必须显式固定 COVERAGE_THINKING");
  if (!sha(candidate.manifest_sha256) || !sha(candidate.a1_run_sha256)) issues.push("baseline candidate 缺少已验证 artifact sha256");
  return issues;
}

/**
 * First eligible run is only provisional. A distinct second clean run on the same commit,
 * config and locked dataset is required before DCP acceptance; it cannot self-certify.
 */
export function promoteBaselineCandidate(candidate: BaselineCandidate, existing?: BaselineRecord, promotedAt = new Date().toISOString()): BaselinePromotion {
  const reasons = candidateIssues(candidate);
  if (reasons.length) return { next: null, reasons };
  if (!existing || existing.status === "legacy") {
    return { next: { ...candidate, status: "provisional", promoted_at: promotedAt }, reasons: [] };
  }
  if (existing.status === "dcp_accepted") {
    return { next: null, reasons: ["该 stratum 已有 dcp_accepted baseline；新配置须从 provisional 重新开始"] };
  }
  if (existing.run_id === candidate.run_id) return { next: null, reasons: ["第二次运行必须是不同 run_id，首跑不能自证"] };
  if (existing.stratum !== candidate.stratum || existing.source.commit !== candidate.source.commit) reasons.push("第二次运行必须在同一 clean commit / stratum");
  if (!sameEvalConfig(existing.config as unknown as Record<string, unknown>, candidate.config)) reasons.push("第二次运行必须使用相同 EvalConfig");
  if (existing.config.dataset_lock_sha256 !== candidate.config.dataset_lock_sha256) reasons.push("第二次运行必须使用相同 dataset lock");
  if (reasons.length) return { next: null, reasons };
  return { next: { ...candidate, status: "dcp_accepted", promoted_at: promotedAt }, reasons: [] };
}

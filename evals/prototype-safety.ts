import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROTOTYPE_POLICY_VERSION } from "../src/lib/runtime/prototype-policy.js";

export const PROTOTYPE_SAFETY_SCHEMA_VERSION = "prototype-safety-receipt-v1";
const REQUIRED_NEGATIVE_TYPES = ["exaggeration", "misattribution", "out_of_context"] as const;
const REQUIRED_LIMITATIONS = [
  "bounded_forced_smoke_subset",
  "no_formal_baseline_comparison",
  "no_dcp_or_source_terms_attestation",
] as const;

type UnknownRecord = Record<string, unknown>;

export interface PrototypeSafetyReceipt {
  schema_version: typeof PROTOTYPE_SAFETY_SCHEMA_VERSION;
  policy_version: typeof PROTOTYPE_POLICY_VERSION;
  stage: "prototype";
  run_id: string;
  generated_at: string;
  source: { commit: string };
  model_config_sha256: string;
  artifacts: { manifest_sha256: string; a1_run_sha256: string };
  safety: {
    core_complete: true;
    consistency_expected: { support: number; uncertain: number; not_support: number; negative_types: string[] };
    display_coverage: { unsafe_accept: number; false_reject: number; accept_cases: number; reject_cases: number };
    quote_self_contained: { unsafe_accept: number; false_reject: number; accept_cases: number; reject_cases: number };
  };
  limitations: readonly string[];
}

export interface PrototypeSafetyEvidence {
  manifest: unknown;
  a1_run: unknown;
  manifest_sha256: string;
  a1_run_sha256: string;
  generated_at?: string;
}

function record(value: unknown, label: string): UnknownRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as UnknownRecord;
}

/** Aggregate receipts are later operator inputs; reject both missing and smuggled fields. */
function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): UnknownRecord {
  const result = record(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不匹配`);
  }
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} 必须是非负整数`);
  return value as number;
}

function commit(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error(`${label} 必须是完整 git sha`);
  return result;
}

function sha256Text(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error(`${label} 必须是 sha256`);
  return result;
}

function runId(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^a1-\d{14}-[0-9a-f]{8}$/i.test(result)) throw new Error(`${label} 无效`);
  return result;
}

function isoTimestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error(`${label} 必须是 ISO UTC 时间`);
  }
  return result;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function declaredCount(summary: UnknownRecord, field: string): number {
  return count(record(summary[field], field).count, `${field}.count`);
}

function selectedConsistencyCases(a1Run: UnknownRecord): PrototypeSafetyReceipt["safety"]["consistency_expected"] {
  const cases = array(a1Run.judge_cases, "a1-run.judge_cases").map((entry, index) => record(entry, `judge_cases[${index}]`));
  const expected = { support: 0, uncertain: 0, not_support: 0 };
  const negativeTypes = new Set<string>();
  for (const entry of cases) {
    const label = text(entry.expected, "judge_cases.expected");
    if (label !== "support" && label !== "uncertain" && label !== "not_support") {
      throw new Error("prototype safety consistency fixture 含未知 expected label");
    }
    expected[label]++;
    if (label === "not_support") negativeTypes.add(text(entry.negative_type, "not_support case.negative_type"));
    if (entry.error != null) throw new Error("prototype safety consistency fixture 未完整执行");
  }
  if (!expected.support || !expected.uncertain || !expected.not_support) {
    throw new Error("prototype safety consistency fixture 必须覆盖 support、uncertain 和 not_support");
  }
  for (const required of REQUIRED_NEGATIVE_TYPES) {
    if (!negativeTypes.has(required)) throw new Error(`prototype safety consistency fixture 缺少 ${required}`);
  }
  return { ...expected, negative_types: [...negativeTypes].sort() };
}

function benchmarkSafety(
  raw: unknown,
  label: "display_coverage" | "quote_self_contained_coverage",
): { unsafe_accept: number; false_reject: number; accept_cases: number; reject_cases: number } {
  const benchmark = record(raw, label);
  const results = array(benchmark.results, `${label}.results`).map((entry, index) => record(entry, `${label}.results[${index}]`));
  let acceptCases = 0;
  let rejectCases = 0;
  let unsafeAccept = 0;
  let falseReject = 0;
  for (const result of results) {
    const expected = text(result.expected, `${label}.result.expected`);
    const actual = text(result.actual, `${label}.result.actual`);
    if (expected !== "accept" && expected !== "reject") throw new Error(`${label} 有未知 expected`);
    if (actual !== "accept" && actual !== "reject") throw new Error(`${label} 有未知 actual`);
    if (result.error != null) throw new Error(`${label} 未完整执行`);
    if (expected === "accept") {
      acceptCases++;
      if (actual === "reject") falseReject++;
    } else {
      rejectCases++;
      if (actual === "accept") unsafeAccept++;
    }
    if (label === "display_coverage" && actual === "accept" && result.projection_matches_expected === false) unsafeAccept++;
  }
  if (!acceptCases || !rejectCases) throw new Error(`${label} 必须同时含应接受与应拒绝样本`);
  const declaredUnsafe = declaredCount(benchmark, "unsafe_accept");
  const declaredFalseReject = declaredCount(benchmark, "false_reject");
  if (declaredUnsafe !== unsafeAccept || declaredFalseReject !== falseReject) {
    throw new Error(`${label} 汇总计数与逐例结果不一致`);
  }
  if (unsafeAccept !== 0) throw new Error(`${label} unsafe_accept=${unsafeAccept}，原型安全门拒绝`);
  return { unsafe_accept: unsafeAccept, false_reject: falseReject, accept_cases: acceptCases, reject_cases: rejectCases };
}

/**
 * Reduce a completed, forced-smoke A1 run to safe aggregate evidence. This rejects any artifact
 * that is incomplete, lacks the curated coverage distribution, or makes an unsafe acceptance.
 */
export function certifyPrototypeSafetyRun(input: PrototypeSafetyEvidence): PrototypeSafetyReceipt {
  const manifest = record(input.manifest, "manifest");
  const a1Run = record(input.a1_run, "a1-run");
  if (manifest.status !== "completed" || manifest.auto_gate !== "smoke") {
    throw new Error("prototype safety 只接受已完成的 forced-smoke A1 run");
  }
  const source = record(manifest.source, "manifest.source");
  const sourceCommit = commit(source.commit, "manifest.source.commit");
  const completion = record(a1Run.completion, "a1-run.completion");
  if (completion.core_complete !== true) throw new Error("prototype safety A1 core_complete 必须为 true");
  const dataset = record(a1Run.dataset, "a1-run.dataset");
  if (dataset.smoke !== true || dataset.smoke_forced !== true) {
    throw new Error("prototype safety 必须绑定强制 smoke 数据集运行");
  }
  const config = record(a1Run.config, "a1-run.config");
  const consistencyExpected = selectedConsistencyCases(a1Run);
  const displayCoverage = benchmarkSafety(a1Run.display_coverage, "display_coverage");
  const quoteSelfContained = benchmarkSafety(a1Run.quote_self_contained_coverage, "quote_self_contained_coverage");
  return {
    schema_version: PROTOTYPE_SAFETY_SCHEMA_VERSION,
    policy_version: PROTOTYPE_POLICY_VERSION,
    stage: "prototype",
    run_id: runId(a1Run.run_id, "a1-run.run_id"),
    generated_at: input.generated_at ?? new Date().toISOString(),
    source: { commit: sourceCommit },
    model_config_sha256: sha256(config),
    artifacts: {
      manifest_sha256: sha256Text(input.manifest_sha256, "manifest_sha256"),
      a1_run_sha256: sha256Text(input.a1_run_sha256, "a1_run_sha256"),
    },
    safety: {
      core_complete: true,
      consistency_expected: consistencyExpected,
      display_coverage: displayCoverage,
      quote_self_contained: quoteSelfContained,
    },
    limitations: REQUIRED_LIMITATIONS,
  };
}

/** Validate a previously written aggregate receipt before a release receipt can reference it. */
export function parsePrototypeSafetyReceipt(value: unknown): PrototypeSafetyReceipt {
  const receipt = exactRecord(value, "prototype safety receipt", [
    "schema_version", "policy_version", "stage", "run_id", "generated_at", "source", "model_config_sha256", "artifacts", "safety", "limitations",
  ]);
  if (receipt.schema_version !== PROTOTYPE_SAFETY_SCHEMA_VERSION || receipt.policy_version !== PROTOTYPE_POLICY_VERSION || receipt.stage !== "prototype") {
    throw new Error("prototype safety receipt schema/policy 不匹配");
  }
  const source = exactRecord(receipt.source, "prototype safety receipt.source", ["commit"]);
  const sourceCommit = commit(source.commit, "prototype safety receipt.source.commit");
  const artifacts = exactRecord(receipt.artifacts, "prototype safety receipt.artifacts", ["manifest_sha256", "a1_run_sha256"]);
  const manifestSha = sha256Text(artifacts.manifest_sha256, "prototype safety receipt.artifacts.manifest_sha256");
  const a1RunSha = sha256Text(artifacts.a1_run_sha256, "prototype safety receipt.artifacts.a1_run_sha256");
  const modelConfigSha = sha256Text(receipt.model_config_sha256, "prototype safety receipt.model_config_sha256");
  const safety = exactRecord(receipt.safety, "prototype safety receipt.safety", [
    "core_complete", "consistency_expected", "display_coverage", "quote_self_contained",
  ]);
  if (safety.core_complete !== true) throw new Error("prototype safety receipt 不是完整运行");
  const consistency = exactRecord(safety.consistency_expected, "prototype safety receipt.safety.consistency_expected", [
    "support", "uncertain", "not_support", "negative_types",
  ]);
  const expected = {
    support: count(consistency.support, "prototype safety receipt consistency.support"),
    uncertain: count(consistency.uncertain, "prototype safety receipt consistency.uncertain"),
    not_support: count(consistency.not_support, "prototype safety receipt consistency.not_support"),
  };
  if (!expected.support || !expected.uncertain || !expected.not_support) {
    throw new Error("prototype safety receipt consistency 必须覆盖全部标签");
  }
  const negativeTypes = array(consistency.negative_types, "prototype safety receipt consistency.negative_types").map((entry, index) => text(entry, `prototype safety receipt negative_types[${index}]`));
  if (negativeTypes.length !== REQUIRED_NEGATIVE_TYPES.length || [...negativeTypes].sort().some((value, index) => value !== REQUIRED_NEGATIVE_TYPES[index])) {
    throw new Error("prototype safety receipt consistency 缺少或含未知 negative_type");
  }
  const coverage = (field: "display_coverage" | "quote_self_contained") => {
    const item = exactRecord(safety[field], `prototype safety receipt.safety.${field}`, ["unsafe_accept", "false_reject", "accept_cases", "reject_cases"]);
    const unsafeAccept = count(item.unsafe_accept, `prototype safety receipt ${field}.unsafe_accept`);
    const falseReject = count(item.false_reject, `prototype safety receipt ${field}.false_reject`);
    const acceptCases = count(item.accept_cases, `prototype safety receipt ${field}.accept_cases`);
    const rejectCases = count(item.reject_cases, `prototype safety receipt ${field}.reject_cases`);
    if (unsafeAccept !== 0) throw new Error(`prototype safety receipt ${field} 存在 unsafe_accept`);
    if (!acceptCases || !rejectCases || falseReject > acceptCases) throw new Error(`prototype safety receipt ${field} 覆盖计数无效`);
    return { unsafe_accept: unsafeAccept, false_reject: falseReject, accept_cases: acceptCases, reject_cases: rejectCases };
  };
  const limitations = array(receipt.limitations, "prototype safety receipt.limitations").map((entry, index) => text(entry, `prototype safety receipt limitations[${index}]`));
  if (limitations.length !== REQUIRED_LIMITATIONS.length || limitations.some((value, index) => value !== REQUIRED_LIMITATIONS[index])) {
    throw new Error("prototype safety receipt limitations 不匹配");
  }
  return {
    schema_version: PROTOTYPE_SAFETY_SCHEMA_VERSION,
    policy_version: PROTOTYPE_POLICY_VERSION,
    stage: "prototype",
    run_id: runId(receipt.run_id, "prototype safety receipt.run_id"),
    generated_at: isoTimestamp(receipt.generated_at, "prototype safety receipt.generated_at"),
    source: { commit: sourceCommit },
    model_config_sha256: modelConfigSha,
    artifacts: { manifest_sha256: manifestSha, a1_run_sha256: a1RunSha },
    safety: {
      core_complete: true,
      consistency_expected: { ...expected, negative_types: [...REQUIRED_NEGATIVE_TYPES] },
      display_coverage: coverage("display_coverage"),
      quote_self_contained: coverage("quote_self_contained"),
    },
    limitations: REQUIRED_LIMITATIONS,
  };
}

/** Receipt files are append-only by run id; an existing path is treated as tampering/operator error. */
export function writePrototypeSafetyReceipt(path: string, receipt: PrototypeSafetyReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

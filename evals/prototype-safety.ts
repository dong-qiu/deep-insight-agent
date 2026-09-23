import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROTOTYPE_POLICY_VERSION } from "../src/lib/runtime/prototype-policy.js";

export const PROTOTYPE_SAFETY_SCHEMA_VERSION = "prototype-safety-receipt-v1";

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
  for (const required of ["exaggeration", "out_of_context", "misattribution"]) {
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
  const commit = text(source.commit, "manifest.source.commit");
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("manifest.source.commit 必须是完整 git sha");
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
    run_id: text(a1Run.run_id, "a1-run.run_id"),
    generated_at: input.generated_at ?? new Date().toISOString(),
    source: { commit },
    model_config_sha256: sha256(config),
    artifacts: {
      manifest_sha256: text(input.manifest_sha256, "manifest_sha256"),
      a1_run_sha256: text(input.a1_run_sha256, "a1_run_sha256"),
    },
    safety: {
      core_complete: true,
      consistency_expected: consistencyExpected,
      display_coverage: displayCoverage,
      quote_self_contained: quoteSelfContained,
    },
    limitations: [
      "bounded_forced_smoke_subset",
      "no_formal_baseline_comparison",
      "no_dcp_or_source_terms_attestation",
    ],
  };
}

/** Receipt files are append-only by run id; an existing path is treated as tampering/operator error. */
export function writePrototypeSafetyReceipt(path: string, receipt: PrototypeSafetyReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

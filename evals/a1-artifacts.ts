/**
 * A1 run artifacts are isolated by run id. A completed directory is only made visible after all
 * files and its manifest have been written into a sibling temporary directory; `latest-complete`
 * is a convenience pointer to an execution, never a statement that its quality gate passed.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RelayRecoveryStats } from "../src/lib/runtime/relay-recovery.js";

export interface A1RunWorkspace {
  runId: string;
  root: string;
  tempDir: string;
  finalDir: string;
  startedAt: string;
}

export interface A1RunManifest {
  run_id: string;
  /** `running` is written in the private temporary workspace; published runs are terminal. */
  status: "running" | "completed" | "failed";
  /** The automatic gate is deliberately separate from completion and human review. */
  auto_gate: "pass" | "fail" | "smoke" | "not_evaluated";
  /** A queue is evidence to review, not evidence that review occurred. */
  manual_review: "pending" | "not_generated";
  /** DCP cannot be eligible until a full automatic pass has a completed human review. */
  dcp_eligibility: "pending_manual_review" | "ineligible" | "not_evaluated";
  started_at: string;
  ended_at: string;
  config: object;
  dataset: object;
  source: { commit: string | null; dirty_fingerprint: string | null; dirty_fingerprint_algorithm?: string };
  /** A resumed execution binds the verified prior checkpoint by bytes, never by its local path. */
  resumed_from_checkpoint_sha256?: string;
  /** A pass on automatic thresholds is not a comparable-baseline or DCP approval. */
  baseline_comparison?: "comparable" | "incomparable" | "not_evaluated";
  /** Auditable DCP population: exactly production selectInsights() output, by real topic id. */
  dcp_sample?: {
    contract_version: string;
    min_topics: number;
    min_consistency_pairs: number;
    min_reader_visible_insights_per_topic: number;
    unique_topic_count: number;
    reader_visible_total: number;
    reader_visible_by_topic: Record<string, number>;
    duplicate_insight_ids?: readonly string[];
    duplicate_statement_quote_count?: number;
  };
  dcp_prerequisites?: readonly string[];
  /** Aggregate only: endpoint/key details intentionally never enter an eval artifact. */
  relay_recovery?: RelayRecoveryStats;
  /** Per-role call/failure/retry/P95 evidence; endpoint and key details never enter artifacts. */
  llm_role_telemetry?: Record<string, {
    calls: number;
    failures: number;
    requests: number;
    /** Includes successful-but-truncated `max_tokens` model responses. */
    output_stop_reasons: Record<string, number>;
    latency_ms: { p50: number; p95: number; max: number };
    /** Application-owned operation names distinguish validator phases without persisting prompts. */
    by_operation: Record<string, {
      calls: number;
      failures: number;
      requests: number;
      output_stop_reasons: Record<string, number>;
      latency_ms: { p50: number; p95: number; max: number };
    }>;
  }>;
  insights: { count: number; ids_sha256: string };
  artifacts: Record<string, string>;
  review_artifact_error?: string;
  error?: string;
}

/**
 * A small, redaction-safe checkpoint for a running A1 process. It intentionally contains only
 * case coordinates and aggregate counts: never source bodies, prompts, model output, or secrets.
 */
export interface A1RunProgress {
  run_id: string;
  updated_at: string;
  state: "running" | "failed" | "completed";
  phase: "setup" | "quality" | "consistency" | "coverage_benchmark" | "finalizing";
  topic_timeout_ms?: number;
  /** Total deadline for one labelled consistency judge, including nested retry budgets. */
  judge_timeout_ms?: number;
  /** Total deadline for one standalone display/quote benchmark case. */
  coverage_timeout_ms?: number;
  current_case?: { index: number; total: number; topic_id?: string };
  /** Analyzer-chunk coordinates are execution diagnostics only, never a reduced sample claim. */
  current_chunk?: { index: number; total: number };
  completed?: { quality_cases: number; consistency_cases: number };
  last_failure?: { phase: string; case_index?: number; topic_id?: string; error: string };
}

export function beginA1Run(root = "evals/out/runs", startedAt = new Date().toISOString()): A1RunWorkspace {
  const stamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const runId = `a1-${stamp}-${randomUUID().slice(0, 8)}`;
  const tempDir = join(root, `.${runId}.tmp`);
  const finalDir = join(root, runId);
  mkdirSync(root, { recursive: true });
  mkdirSync(tempDir, { recursive: false });
  const workspace = { runId, root, tempDir, finalDir, startedAt };
  writeJson(join(tempDir, "manifest.json"), {
    run_id: runId,
    status: "running",
    auto_gate: "not_evaluated",
    manual_review: "not_generated",
    dcp_eligibility: "not_evaluated",
    started_at: startedAt,
    config: {},
    dataset: {},
    source: { commit: null, dirty_fingerprint: null },
    insights: { count: 0, ids_sha256: createHash("sha256").update("").digest("hex") },
    artifacts: {},
  } satisfies Omit<A1RunManifest, "ended_at">);
  return workspace;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function writeA1RunProgress(
  workspace: A1RunWorkspace,
  progress: Omit<A1RunProgress, "run_id" | "updated_at">,
): void {
  writeJson(join(workspace.tempDir, "progress.json"), {
    run_id: workspace.runId,
    updated_at: new Date().toISOString(),
    ...progress,
  } satisfies A1RunProgress);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Atomic on a single filesystem: consumers see either no run directory or the complete one. */
export function finalizeA1Run(workspace: A1RunWorkspace, manifest: A1RunManifest): void {
  writeJson(join(workspace.tempDir, "manifest.json"), manifest);
  renameSync(workspace.tempDir, workspace.finalDir);
  if (manifest.status === "completed") {
    const pointer = join(workspace.root, "latest-complete.json");
    const pointerTmp = `${pointer}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
    writeJson(pointerTmp, {
      run_id: manifest.run_id,
      manifest: join(workspace.finalDir, "manifest.json"),
      completed_at: manifest.ended_at,
      // Deliberately duplicated so scripts do not accidentally treat `latest` as a pass badge.
      auto_gate: manifest.auto_gate,
      manual_review: manifest.manual_review,
      dcp_eligibility: manifest.dcp_eligibility,
    });
    renameSync(pointerTmp, pointer);
  }
}

/** Best-effort only: a secondary failure while recording a failed run must not hide its root cause. */
export function finalizeFailedA1Run(workspace: A1RunWorkspace, manifest: A1RunManifest): void {
  if (!existsSync(workspace.tempDir)) return;
  finalizeA1Run(workspace, manifest);
}

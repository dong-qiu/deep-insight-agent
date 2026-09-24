import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginA1Run, finalizeA1Run, sha256File, writeA1RunProgress } from "./a1-artifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "insight-a1-artifacts-"));
  roots.push(value);
  return value;
}

function manifest(runId: string, status: "completed" | "failed", autoGate: "pass" | "fail" | "smoke" | "not_evaluated") {
  return {
    run_id: runId, status, auto_gate: autoGate,
    manual_review: "pending", dcp_eligibility: autoGate === "pass" ? "pending_manual_review" : "ineligible",
    started_at: "2026-09-09T00:00:00.000Z", ended_at: "2026-09-09T00:01:00.000Z",
    config: {}, dataset: {}, source: { commit: "abc", dirty_fingerprint: "def", dirty_fingerprint_algorithm: "git-diff-and-untracked-sha256-v2" }, baseline_comparison: "comparable" as const, dcp_prerequisites: ["人工 review queue 尚未完成"], insights: { count: 0, ids_sha256: "empty" }, artifacts: {},
  } as const;
}

describe("A1 isolated artifacts", () => {
  it("records the early running manifest inside the private workspace", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(workspace.tempDir, "manifest.json"), "utf8"))).toMatchObject({
      run_id: workspace.runId, status: "running", auto_gate: "not_evaluated", dcp_eligibility: "not_evaluated",
    });
    expect(existsSync(workspace.finalDir)).toBe(false);
  });

  it("publishes a complete run then points latest-complete at it without implying pass", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    const artifact = join(workspace.tempDir, "review-queue.json");
    writeFileSync(artifact, "{}\n");
    finalizeA1Run(workspace, { ...manifest(workspace.runId, "completed", "fail"), artifacts: { "review-queue.json": sha256File(artifact) } });

    expect(existsSync(join(workspace.finalDir, "manifest.json"))).toBe(true);
    expect(existsSync(workspace.tempDir)).toBe(false);
    expect(JSON.parse(readFileSync(join(runs, "latest-complete.json"), "utf8"))).toMatchObject({
      run_id: workspace.runId, auto_gate: "fail", dcp_eligibility: "ineligible",
    });
  });

  it("persists the reader-visible DCP population by real topic id", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    finalizeA1Run(workspace, {
      ...manifest(workspace.runId, "completed", "fail"),
      dcp_sample: {
        contract_version: "reader-visible-v1", min_topics: 5, min_consistency_pairs: 100,
        min_reader_visible_insights_per_topic: 10, unique_topic_count: 5,
        reader_visible_total: 40, reader_visible_by_topic: { t_a: 10, t_b: 10, t_c: 10, t_d: 10, t_e: 0 },
      },
    });
    expect(JSON.parse(readFileSync(join(workspace.finalDir, "manifest.json"), "utf8"))).toMatchObject({
      dcp_sample: { contract_version: "reader-visible-v1", reader_visible_by_topic: { t_e: 0 } },
    });
  });

  it("persists non-sensitive relay recovery telemetry with the terminal manifest", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    finalizeA1Run(workspace, {
      ...manifest(workspace.runId, "completed", "fail"),
      relay_recovery: {
        policy_version: "relay-half-open-v1", capacity_errors: 1, recovery_cycles: 1,
        probes: 2, recovered: 1, exhausted: 0, fast_failed_while_open: 4, total_backoff_wait_ms: 30_250, gate_count: 1,
      },
    });
    expect(JSON.parse(readFileSync(join(workspace.finalDir, "manifest.json"), "utf8"))).toMatchObject({
      relay_recovery: { policy_version: "relay-half-open-v1", recovered: 1, gate_count: 1 },
    });
  });

  it("persists phase-level stop reasons without persisting a prompt or source body", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    finalizeA1Run(workspace, {
      ...manifest(workspace.runId, "completed", "fail"),
      llm_role_telemetry: {
        validator: {
          calls: 2, failures: 0, requests: 2, output_stop_reasons: { max_tokens: 1, tool_use: 1 },
          latency_ms: { p50: 10, p95: 20, max: 20 },
          by_operation: {
            citation_consistency_batch: {
              calls: 1, failures: 0, requests: 1, output_stop_reasons: { tool_use: 1 },
              latency_ms: { p50: 10, p95: 10, max: 10 },
            },
            display_quote_primary: {
              calls: 1, failures: 0, requests: 1, output_stop_reasons: { max_tokens: 1 },
              latency_ms: { p50: 20, p95: 20, max: 20 },
            },
          },
        },
      },
    });

    expect(JSON.parse(readFileSync(join(workspace.finalDir, "manifest.json"), "utf8"))).toMatchObject({
      llm_role_telemetry: {
        validator: {
          by_operation: { display_quote_primary: { output_stop_reasons: { max_tokens: 1 } } },
        },
      },
    });
  });

  it("records a failed run but never advances latest-complete", () => {
    const runs = root();
    const successful = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    finalizeA1Run(successful, manifest(successful.runId, "completed", "pass"));
    const failed = beginA1Run(runs, "2026-09-09T00:02:00.000Z");
    finalizeA1Run(failed, {
      ...manifest(failed.runId, "failed", "not_evaluated"),
      llm_role_telemetry: {
        coverage: {
          calls: 1, failures: 1, requests: 1, output_stop_reasons: {},
          provider_stream_failures: { incomplete: 1 }, provider_http_statuses: {},
          provider_sse_done: { false: 1 }, provider_function_arguments_done: { false: 1 },
          latency_ms: { p50: 10, p95: 10, max: 10 }, by_operation: {},
        },
      },
      error: "network",
    });

    expect(JSON.parse(readFileSync(join(runs, "latest-complete.json"), "utf8")).run_id).toBe(successful.runId);
    expect(JSON.parse(readFileSync(join(failed.finalDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "failed", error: "network",
      llm_role_telemetry: { coverage: { provider_stream_failures: { incomplete: 1 } } },
    });
  });

  it("publishes the bounded progress checkpoint with a terminal failure", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    writeA1RunProgress(workspace, {
      state: "failed", phase: "quality", topic_timeout_ms: 600_000,
      current_case: { index: 0, total: 5, topic_id: "topic-a" },
      benchmark: "display_coverage",
      settled: { consistency_cases: 12, display_coverage_cases: 3, quote_self_contained_cases: 0 },
      completed: { quality_cases: 0, consistency_cases: 0 },
      last_failure: { phase: "quality", case_index: 0, topic_id: "topic-a", error: "deadline" },
    });
    const progress = join(workspace.tempDir, "progress.json");
    finalizeA1Run(workspace, {
      ...manifest(workspace.runId, "failed", "not_evaluated"),
      artifacts: { "progress.json": sha256File(progress) }, error: "deadline",
    });

    expect(JSON.parse(readFileSync(join(workspace.finalDir, "progress.json"), "utf8"))).toMatchObject({
      state: "failed", phase: "quality", current_case: { topic_id: "topic-a" },
      benchmark: "display_coverage",
      settled: { consistency_cases: 12, display_coverage_cases: 3, quote_self_contained_cases: 0 },
    });
    expect(JSON.parse(readFileSync(join(workspace.finalDir, "manifest.json"), "utf8"))).toMatchObject({
      artifacts: { "progress.json": sha256File(join(workspace.finalDir, "progress.json")) },
    });
  });
});

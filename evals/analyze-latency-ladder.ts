/**
 * Diagnose analyzer-path liveness without running the full A1 judge suite or writing a baseline.
 * Every result contains only counts, hashes and sanitized errors; source body stays local.
 *
 * Example:
 * A1_QUALITY_FILE=evals/dataset/insight-quality-v2.local.jsonl \
 * A1_LADDER_TOPIC_ID=t_code_agents A1_LADDER_ITEM_COUNTS=4,8,12,20 \
 * LLM_TIMEOUT_MS=45000 LLM_MAX_RETRIES=0 LLM_TRANSIENT_RETRIES=0 \
 * npm run eval:analyze-latency-ladder
 */
import "./load-env.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze, ANALYZE_BATCH_CHARS, chunkByChars, type AnalyzeStageTelemetry } from "../src/lib/agents/analyzer.js";
import { getCostReport, getRoleCallTelemetry, MODELS, type RoleCallTelemetry } from "../src/lib/runtime/llm.js";
import { coverageThinking, llmMaxRetries, llmTimeoutMs, llmTransientRetries, validatorThinking } from "../src/lib/runtime/env.js";
import type { ContentItem, Topic } from "../src/lib/types.js";
import { parseLatencyLadderCounts, parseLatencyLadderOffset, selectLatencyLadderCase } from "./analyze-latency-ladder-lib.js";

interface QualityCase {
  topic: Topic;
  items: ContentItem[];
  time_window: { start: string; end: string };
}

interface LadderResult {
  item_count: number;
  item_ids_sha256: string;
  analyze_chunks: number;
  duration_ms: number;
  status: "running" | "completed" | "failed";
  insights?: number;
  display_coverage_audits?: number;
  error_name?: string;
  error_message?: string;
  stages: Array<AnalyzeStageTelemetry & { role_telemetry_cumulative: Record<string, RoleCallTelemetry> }>;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const safeError = (error: unknown): { error_name: string; error_message: string } => {
  const name = error instanceof Error && error.name ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  // Errors must not retain source bodies or credentials in durable telemetry.
  return { error_name: name, error_message: message.replace(/[\r\n]+/g, " ").slice(0, 240) };
};

async function main(): Promise<void> {
  const qualityPath = process.env.A1_QUALITY_FILE ?? "evals/dataset/insight-quality.jsonl";
  const qualityBytes = readFileSync(qualityPath);
  const cases = qualityBytes.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as QualityCase);
  const counts = parseLatencyLadderCounts(process.env.A1_LADDER_ITEM_COUNTS);
  const itemOffset = parseLatencyLadderOffset(process.env.A1_LADDER_ITEM_OFFSET);
  const selected = selectLatencyLadderCase<ContentItem, QualityCase>(cases, process.env.A1_LADDER_TOPIC_ID, counts, itemOffset);
  const runId = `a1-ladder-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const outPath = process.env.A1_LADDER_OUT ?? join("evals/out/ladders", `${runId}.json`);
  const results: LadderResult[] = [];
  const telemetry = {
    schema_version: "a1-analysis-latency-ladder-v2",
    run_id: runId,
    status: "running" as "running" | "completed" | "failed",
    started_at: new Date().toISOString(),
    input: {
      quality_sha256: hash(qualityBytes),
      topic_id: selected.topic.id,
      requested_item_counts: counts,
      item_offset: itemOffset,
      available_items: selected.items.length,
    },
    config: {
      analyzer_model: MODELS.analyzer,
      validator_model: MODELS.validator,
      coverage_model: MODELS.coverage,
      analyze_batch_chars: ANALYZE_BATCH_CHARS,
      llm_timeout_ms: llmTimeoutMs(),
      llm_max_retries: llmMaxRetries(),
      llm_transient_retries: llmTransientRetries(),
      validator_thinking: validatorThinking(),
      coverage_thinking: coverageThinking(),
    },
    results,
  };
  const persist = () => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(telemetry, null, 2)}\n`);
  };
  persist();
  console.log(`A1 analyze latency ladder — topic=${selected.topic.id}, batch=${ANALYZE_BATCH_CHARS}, timeout=${llmTimeoutMs()}ms`);

  for (const itemCount of counts) {
    const items = selected.items.slice(itemOffset, itemOffset + itemCount);
    const started = performance.now();
    const stages: LadderResult["stages"] = [];
    const result: LadderResult = {
      item_count: itemCount,
      item_ids_sha256: hash(items.map((item) => item.id).join("\n")),
      analyze_chunks: chunkByChars(items).length,
      duration_ms: 0,
      status: "running",
      stages,
    };
    // Persist an in-progress rung before any model call, then after every stage. A later process
    // interruption remains distinguishable from an opaque "no results yet" state.
    results.push(result);
    persist();
    process.stdout.write(`[${itemCount} items / ${chunkByChars(items).length} chunks] `);
    try {
      const batch = await analyze(selected.topic, items, selected.time_window, undefined, { onStage: (stage) => {
        stages.push({ ...stage, role_telemetry_cumulative: getRoleCallTelemetry() });
        persist();
      } });
      Object.assign(result, {
        duration_ms: Math.round(performance.now() - started),
        status: "completed",
        insights: batch.insights.length,
        display_coverage_audits: batch.display_coverage_audits?.length ?? 0,
      });
      console.log(`completed in ${result.duration_ms}ms (${result.insights} insights)`);
    } catch (error) {
      Object.assign(result, {
        duration_ms: Math.round(performance.now() - started),
        status: "failed",
        ...safeError(error),
      });
      telemetry.status = "failed";
      persist();
      console.log(`failed in ${result.duration_ms}ms (${result.error_name})`);
      process.exitCode = 1;
      break;
    }
    persist();
  }
  if (telemetry.status === "running") telemetry.status = "completed";
  persist();
  const cost = getCostReport();
  console.log(`已写 ${outPath}；status=${telemetry.status}；cost=$${cost.totalUSD.toFixed(3)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisBatch, ValidationResult } from "../src/lib/types.js";
import {
  appendA1QualityCheckpointChunk,
  completeA1QualityCheckpointCase,
  createA1QualityCheckpoint,
  loadA1QualityCheckpoint,
  verifiedFailedA1CheckpointSha256,
  writeA1QualityCheckpoint,
  type A1QualityCheckpointContext,
  type A1QualityCheckpointPlanCase,
} from "./a1-quality-checkpoint.js";
import { sha256File } from "./a1-artifacts.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const context: A1QualityCheckpointContext = { eval_config_sha256: "a".repeat(64), quality_dataset_sha256: "b".repeat(64) };
const plan: A1QualityCheckpointPlanCase[] = [
  { case_index: 0, topic_id: "topic-a", stratum: "arxiv", chunk_input_sha256: ["one", "two"] },
  { case_index: 1, topic_id: "topic-b", stratum: "arxiv", chunk_input_sha256: ["three"] },
];
const chunk = (input_sha256: string) => ({ input_sha256, insights: [], coverage_decisions: [] });
const completed = {
  batch: {
    id: "batch", topic_id: "topic-a", time_window: { start: "", end: "" }, status: "done",
    no_significant_event: true, insights: [],
  } satisfies AnalysisBatch,
  validation: {
    checks: [],
    report: {
      total: 0, pass: 0, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0,
      flagged_rate: 0, insights_total: 0, insights_includable: 0, releasable: true,
    },
  } satisfies ValidationResult,
};

describe("A1 quality checkpoint", () => {
  it("only restores a bound prefix, and a finished topic is never re-opened", () => {
    const checkpoint = createA1QualityCheckpoint(context);
    appendA1QualityCheckpointChunk(checkpoint, plan, 0, chunk("one"));
    appendA1QualityCheckpointChunk(checkpoint, plan, 0, chunk("two"));
    completeA1QualityCheckpointCase(checkpoint, plan, 0, completed);
    appendA1QualityCheckpointChunk(checkpoint, plan, 1, chunk("three"));

    const root = mkdtempSync(join(tmpdir(), "a1-quality-checkpoint-")); roots.push(root);
    const path = join(root, "quality-checkpoint.json");
    writeA1QualityCheckpoint(path, checkpoint);
    expect(loadA1QualityCheckpoint(path, context, plan)).toEqual(checkpoint);
    expect(() => appendA1QualityCheckpointChunk(checkpoint, plan, 0, chunk("one"))).toThrow("只能追加");
  });

  it("rejects model/config drift, a skipped chunk, and a partial topic followed by another topic", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-quality-checkpoint-")); roots.push(root);
    const path = join(root, "quality-checkpoint.json");
    const checkpoint = createA1QualityCheckpoint(context);
    appendA1QualityCheckpointChunk(checkpoint, plan, 0, chunk("one"));
    writeA1QualityCheckpoint(path, checkpoint);

    expect(() => loadA1QualityCheckpoint(path, { ...context, eval_config_sha256: "c".repeat(64) }, plan)).toThrow("不匹配");
    expect(() => appendA1QualityCheckpointChunk(checkpoint, plan, 0, chunk("wrong"))).toThrow("只能追加");
    checkpoint.cases.push({ case_index: 1, topic_id: "topic-b", stratum: "arxiv", chunks: [] });
    expect(() => loadA1QualityCheckpoint(path, context, plan)).not.toThrow();
    writeA1QualityCheckpoint(path, checkpoint);
    expect(() => loadA1QualityCheckpoint(path, context, plan)).toThrow("未完成 topic 后不得有后续 case");
  });

  it("accepts only a terminal failed run whose manifest hashes the exact checkpoint bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-quality-checkpoint-")); roots.push(root);
    const checkpointPath = join(root, "quality-checkpoint.json");
    writeA1QualityCheckpoint(checkpointPath, createA1QualityCheckpoint(context));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({
      status: "failed", artifacts: { "quality-checkpoint.json": sha256File(checkpointPath) },
    })}\n`);
    expect(verifiedFailedA1CheckpointSha256(manifestPath, checkpointPath)).toBe(sha256File(checkpointPath));

    writeFileSync(manifestPath, `${JSON.stringify({ status: "failed", artifacts: { "quality-checkpoint.json": "tampered" } })}\n`);
    expect(() => verifiedFailedA1CheckpointSha256(manifestPath, checkpointPath)).toThrow("哈希绑定");
  });
});

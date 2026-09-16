import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkpointPathFor,
  loadAiReviewCheckpoint,
  validAiReviewBatch,
  writeAiReviewCheckpoint,
  type AiReviewCheckpointContext,
} from "./a1-ai-review-checkpoint.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const context: AiReviewCheckpointContext = {
  reviewer_id: "ai-validator", role: "validator", model: "model-a", thinking: true,
  structured_thinking_transport_version: "forced-tool-enabled-v1", response_budget_version: "output-3072-v1", max_tokens: 3072,
  prompt_version: "p1", prompt_sha256: "a".repeat(64),
  worklist_sha256: "b".repeat(64), pair_population_sha256: "c".repeat(64),
};
const worklist = ["one", "two", "three", "four", "five"].map((id) => ({ id, statement: `statement ${id}`, source_text: `source ${id}`, pair_sha256: `pair-${id}` }));
const decisions = worklist.map((row) => ({ case_id: row.id, pair_sha256: row.pair_sha256, expected_consistency: "support" as const }));

describe("AI reviewer checkpoint", () => {
  it("persists only a bound whole-batch label prefix and reloads it", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-ai-checkpoint-")); roots.push(root);
    const path = checkpointPathFor(join(root, "validator.local.json"));
    writeAiReviewCheckpoint(path, context, { calls: 1, tokens: 123, amount_usd: 0.5 }, decisions);

    expect(loadAiReviewCheckpoint(path, context, worklist, 5)).toEqual({
      usage: { calls: 1, tokens: 123, amount_usd: 0.5 }, decisions,
    });
    expect(readFileSync(path, "utf8")).not.toContain("source one");
  });

  it("rejects a checkpoint after worklist/config drift or a partial batch", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-ai-checkpoint-")); roots.push(root);
    const path = join(root, "checkpoint.local.json");
    writeAiReviewCheckpoint(path, context, { calls: 1, tokens: 1, amount_usd: 0 }, decisions);
    expect(() => loadAiReviewCheckpoint(path, { ...context, model: "model-b" }, worklist, 5)).toThrow("不匹配");
    expect(() => loadAiReviewCheckpoint(path, { ...context, max_tokens: 1536, response_budget_version: "output-1536-v1" }, worklist, 5)).toThrow("不匹配");
    writeAiReviewCheckpoint(path, context, { calls: 1, tokens: 1, amount_usd: 0 }, decisions.slice(0, 4));
    expect(() => loadAiReviewCheckpoint(path, context, worklist, 5)).toThrow("完整批次前缀");
  });

  it("accepts retry-inclusive usage but rejects a structurally incomplete batch", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-ai-checkpoint-")); roots.push(root);
    const path = join(root, "checkpoint.local.json");
    writeAiReviewCheckpoint(path, context, { calls: 2, tokens: 2, amount_usd: 0 }, decisions);
    expect(loadAiReviewCheckpoint(path, context, worklist, 5).usage.calls).toBe(2);
    expect(validAiReviewBatch(worklist, decisions)).toBe(true);
    expect(validAiReviewBatch(worklist, decisions.slice(0, 4))).toBe(false);
    expect(validAiReviewBatch(worklist, [{ ...decisions[0]!, negative_type: "exaggeration" }])).toBe(false);
  });
});

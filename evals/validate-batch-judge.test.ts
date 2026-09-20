import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describeBatchJudgeDataset, isDirectBatchJudgeExecution, loadEnvLocal } from "./validate-batch-judge.js";

describe("validate-batch-judge dataset evidence", () => {
  it("derives the displayed case, negative, and source counts from the loaded dataset", () => {
    expect(describeBatchJudgeDataset([
      { statement: "a", source_text: "source-1", expected_consistency: "support" },
      { statement: "b", source_text: "source-1", expected_consistency: "not_support" },
      { statement: "c", source_text: "source-2", expected_consistency: "uncertain" },
    ])).toEqual({ caseCount: 3, negativeCount: 1, uniqueSourceCount: 2 });
  });

  it("recognizes tsx's relative direct-script argument without running on module import", () => {
    const entry = "evals/validate-batch-judge.ts";
    expect(isDirectBatchJudgeExecution(pathToFileURL(resolve(entry)).href, entry)).toBe(true);
    expect(isDirectBatchJudgeExecution(pathToFileURL(resolve(entry)).href, undefined)).toBe(false);
  });

  it("loads a local model setting before runtime modules are requested and preserves explicit environment", () => {
    const root = mkdtempSync(join(tmpdir(), "batch-judge-env-"));
    try {
      const path = join(root, ".env.local");
      writeFileSync(path, "VALIDATOR_MODEL=fixture-validator\nVALIDATOR_THINKING=0\n");
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test", VALIDATOR_THINKING: "1" };
      loadEnvLocal(path, env);
      expect(env).toMatchObject({ VALIDATOR_MODEL: "fixture-validator", VALIDATOR_THINKING: "1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

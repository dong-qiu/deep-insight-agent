import { afterEach, expect, it, vi } from "vitest";
const runtimeState = vi.hoisted(() => ({ failures: 2 }));

vi.mock("./load-env.js", () => ({}));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false), mkdirSync: vi.fn(), readFileSync: vi.fn(() => Buffer.from("synthetic code")), writeFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "synthetic sha") }));
vi.mock("../src/lib/agents/analyzer.js", async importOriginal => ({
  isCompleteStatement: (await importOriginal<typeof import("../src/lib/agents/analyzer.js")>()).isCompleteStatement,
  verifyDisplayedQuoteCoverage: vi.fn(),
}));
vi.mock("../src/lib/agents/reader-language.js", async importOriginal => ({
  containsChinese: (await importOriginal<typeof import("../src/lib/agents/reader-language.js")>()).containsChinese,
  rewriteReaderStatementChinese: vi.fn(), READER_LANGUAGE_EQUIVALENCE_RULE: "synthetic rule",
  READER_LANGUAGE_REPAIR_PROMPT_HASH: "synthetic hash",
}));
vi.mock("../src/lib/runtime/llm.js", () => ({ MODELS: {}, getCostReport: () => ({}), getRoleCallTelemetry: () => ({ validator: { failures: runtimeState.failures } }) }));

import { existsSync, writeFileSync } from "node:fs";
import { verifyDisplayedQuoteCoverage } from "../src/lib/agents/analyzer.js";
import { rewriteReaderStatementChinese } from "../src/lib/agents/reader-language.js";
import { readerRatioDimensionCases } from "./reader-ratio-contract.js";

const previousExitCode = process.exitCode;
const previousArgv = process.argv;
afterEach(() => { process.exitCode = previousExitCode; process.argv = previousArgv; runtimeState.failures = 2; vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules(); });

it("persists audit and repair timeouts, continues every fixed case once, and fails the run", async () => {
  process.argv = ["node", "check-reader-ratios.ts", "synthetic.json", "--observe-pending"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(verifyDisplayedQuoteCoverage)
    .mockRejectedValueOnce(new DOMException("private provider details", "TimeoutError"))
    .mockResolvedValue({ covered: true, claims: [{ reason: "judge_supported" }] } as never);
  vi.mocked(rewriteReaderStatementChinese)
    .mockRejectedValueOnce(new Error("private provider details"))
    .mockResolvedValue("合成译文。");
  await import("./check-reader-ratios.js");
  const saved = JSON.parse(String(vi.mocked(writeFileSync).mock.lastCall?.[1]));
  expect(saved.results).toHaveLength(50);
  expect(new Set(saved.results.map((r: { id: string }) => r.id)).size).toBe(50);
  expect(saved.results[0]).toMatchObject({ id: "accuracy-retention-good", error: "timeout" });
  expect(saved.results.find((r: { id: string }) => r.id === "accuracy-retention-generated"))
    .toMatchObject({ error: "execution_failed" });
  expect(JSON.stringify(saved)).not.toContain("private provider details");
  expect(verifyDisplayedQuoteCoverage).toHaveBeenCalledTimes(49);
  expect(rewriteReaderStatementChinese).toHaveBeenCalledTimes(5);
  expect(process.exitCode).toBe(1);
});

it("defaults to the explicit labeled subset without treating pending cases as passes", async () => {
  process.argv = ["node", "check-reader-ratios.ts", "synthetic-subset.json"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(verifyDisplayedQuoteCoverage).mockResolvedValue({ covered: false, primary_decisions: [], claims: [] } as never);
  vi.mocked(rewriteReaderStatementChinese).mockResolvedValue("合成译文。");
  await import("./check-reader-ratios.js");
  const saved = JSON.parse(String(vi.mocked(writeFileSync).mock.lastCall?.[1]));
  expect(saved).toMatchObject({ scope: "ratio-reviewed-label-subset", full_contract_labeled: false, publication_ready: false, promotable: false });
  expect(saved.pending_labels).toHaveLength(26);
  expect(saved.results).toHaveLength(24);
  expect(saved.results.some((row: { id: string }) => row.id === "negated-explanation")).toBe(false);
  expect(verifyDisplayedQuoteCoverage).toHaveBeenCalledTimes(24);
  expect(saved.status).toBe("failed"); // missing primary is not reverse-inferred from the final gate
});

it("refuses to overwrite prior evidence before making any model request", async () => {
  process.argv = ["node", "check-reader-ratios.ts", "existing.json"];
  vi.mocked(existsSync).mockReturnValueOnce(true);
  await expect(import("./check-reader-ratios.js")).rejects.toThrow("Refusing to overwrite");
  expect(verifyDisplayedQuoteCoverage).not.toHaveBeenCalled();
  expect(rewriteReaderStatementChinese).not.toHaveBeenCalled();
});

it.each([false, true])("only permits scoped success, never success for pending diagnostics (observe=%s)", async (observePending) => {
  process.argv = ["node", "check-reader-ratios.ts", "synthetic-success.json", ...(observePending ? ["--observe-pending"] : [])];
  process.exitCode = undefined;
  runtimeState.failures = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(verifyDisplayedQuoteCoverage).mockImplementation(async (input, citations, _index, _cost, _signal, source) => {
    const row = readerRatioDimensionCases.find(row => row.statement === input.statement && row.quote === citations[0].quote && row.source === source);
    const primary = row ? row.expected.primary !== false : true;
    const quote = row ? row.expected.quote !== false : true;
    return { covered: primary && quote,
      primary_decisions: [{ claim_id: "statement:1", supports: primary, reason: primary ? "judge_supported" : "judge_not_supported" }],
      claims: [{ claim_id: "statement:1", countercheck: { supports: quote, reason: quote ? "quote_self_contained" : "quote_not_self_contained", error: "private-error-must-not-persist" } }],
    } as never;
  });
  vi.mocked(rewriteReaderStatementChinese).mockResolvedValue("合成译文。");
  await import("./check-reader-ratios.js");
  const saved = JSON.parse(String(vi.mocked(writeFileSync).mock.lastCall?.[1]));
  expect(saved.status).toBe(observePending ? "diagnostic_pending_labels" : "passed_labeled_subset");
  expect(saved.full_contract_labeled).toBe(false);
  expect(saved.publication_ready).toBe(false);
  expect(saved.results).toHaveLength(observePending ? 50 : 24);
  expect(JSON.stringify(saved)).not.toContain("private-error-must-not-persist");
  expect(saved.results.find((row: { id: string }) => row.id === "accuracy-retention-generated"))
    .toMatchObject({ statement: "合成译文。", audit: { primary_decisions: [{ claim_id: "statement:1", supports: true, reason: "judge_supported" }],
      countercheck: { supports: true, reason: "quote_self_contained" } } });
  expect(process.exitCode).toBe(observePending ? 1 : undefined);
});

it.each(["Atlas achieves 96% accuracy.", "这条译文尚未完成"])("rejects generated language/completeness failures before semantic calls: %s", async statement => {
  process.argv = ["node", "check-reader-ratios.ts", "invalid-generation.json"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(verifyDisplayedQuoteCoverage).mockResolvedValue({ covered: false, primary_decisions: [], claims: [] } as never);
  vi.mocked(rewriteReaderStatementChinese).mockResolvedValue(statement);
  await import("./check-reader-ratios.js");
  const saved = JSON.parse(String(vi.mocked(writeFileSync).mock.lastCall?.[1]));
  expect(saved.results.filter((row: { error?: string }) => row.error === "invalid_reader_language_or_incomplete")).toHaveLength(5);
  expect(verifyDisplayedQuoteCoverage).toHaveBeenCalledTimes(19);
  expect(saved.results.at(-1).statement).toBe(statement);
  expect(saved.status).toBe("failed");
});

it("retains generated text when its semantic audit throws, without storing private error text", async () => {
  process.argv = ["node", "check-reader-ratios.ts", "generated-audit-failure.json"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(verifyDisplayedQuoteCoverage).mockRejectedValue(new DOMException("private-error-must-not-persist", "TimeoutError"));
  vi.mocked(rewriteReaderStatementChinese).mockResolvedValue("可复核的合成译文。");
  await import("./check-reader-ratios.js");
  const saved = JSON.parse(String(vi.mocked(writeFileSync).mock.lastCall?.[1]));
  expect(saved.results.filter((row: { id: string }) => row.id.endsWith("-generated"))).toHaveLength(5);
  expect(saved.results.at(-1)).toMatchObject({ statement: "可复核的合成译文。", error: "timeout" });
  expect(JSON.stringify(saved)).not.toContain("private-error-must-not-persist");
});

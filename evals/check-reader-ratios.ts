/** Split-dimension ratio checks; scoped evidence, never a baseline or publication receipt. */
import "./load-env.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isCompleteStatement, verifyDisplayedQuoteCoverage } from "../src/lib/agents/analyzer.js";
import { containsChinese, rewriteReaderStatementChinese, READER_LANGUAGE_EQUIVALENCE_RULE, READER_LANGUAGE_REPAIR_PROMPT_HASH } from "../src/lib/agents/reader-language.js";
import { MODELS, getCostReport, getRoleCallTelemetry } from "../src/lib/runtime/llm.js";
import { readerRatioCases } from "./dataset/reader-language-ratios.js";
import { READER_RATIO_EVAL_VERSION, pendingRatioLabels, readerRatioDimensionCases, scoreRatioCheck,
  type RatioCase, type RatioScore } from "./reader-ratio-contract.js";

const args = process.argv.slice(2);
const observePending = args.includes("--observe-pending");
if (args.some(arg => arg.startsWith("--") && arg !== "--observe-pending") || args.filter(arg => !arg.startsWith("--")).length > 1) {
  throw new Error("Usage: check-reader-ratios.ts [new-output-path] [--observe-pending]");
}
const output = resolve(args.find(arg => !arg.startsWith("--")) ?? "evals/out/reader-ratios-v2.json");
if (existsSync(output)) throw new Error("Refusing to overwrite an existing ratio artifact; use a new output path.");
const started = Date.now();
type Result = { id: string; expected: RatioCase["expected"]; statement?: string; audit?: Record<string, unknown>;
  evaluation?: ReturnType<typeof scoreRatioCheck>; error?: string };
const results: Result[] = [];
const pending = pendingRatioLabels(readerRatioDimensionCases);
const pendingIds = new Set(pending.map(row => row.id));
// User decision: preserve existing rules, keep disputed cases pending and out of pass evidence.
// This is a new, explicitly smaller labeled subset, NOT a re-score of the legacy 47-case run.
const cases = observePending ? readerRatioDimensionCases : readerRatioDimensionCases.filter(row => !pendingIds.has(row.id));
const planned = cases.length + readerRatioCases.length;
const metadata = {
  scope: observePending ? "ratio-pending-diagnostics" : "ratio-reviewed-label-subset",
  contract_version: READER_RATIO_EVAL_VERSION, promotable: false, publication_ready: false,
  incomparable_with: "legacy-single-label-47-case-results",
  code_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  tracked_diff_sha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"),
  source_sha256: Object.fromEntries(["evals/check-reader-ratios.ts", "evals/reader-ratio-contract.ts", "evals/dataset/reader-language-ratios.ts",
    "src/lib/agents/reader-language.ts", "src/lib/agents/analyzer.ts", "src/lib/runtime/llm.ts",
    "src/lib/runtime/volcengine-responses.ts", "src/lib/runtime/transport-diagnostics.ts",
    "src/lib/runtime/responses-incomplete-diagnostics.ts"].map(path =>
    [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  cases_sha256: createHash("sha256").update(JSON.stringify(readerRatioDimensionCases)).digest("hex"),
  cases: readerRatioDimensionCases, pending_labels: pending, planned_cases: planned,
  selected_case_ids: cases.map(row => row.id), full_contract_labeled: pending.length === 0,
  repair_prompt_hash: READER_LANGUAGE_REPAIR_PROMPT_HASH,
  equivalence_rule_hash: createHash("sha256").update(READER_LANGUAGE_EQUIVALENCE_RULE).digest("hex"),
  models: MODELS, started_at: new Date().toISOString(),
  profile: Object.fromEntries(["LLM_PROVIDER", "VALIDATOR_THINKING", "COVERAGE_THINKING", "COVERAGE_MAX_TOKENS"].map(key => [key, process.env[key]])),
};
function summary() {
  const dimensions = Object.fromEntries((["primary", "quote", "combined"] as const).map(dimension => {
    const counts: Record<RatioScore, number> = { match: 0, mismatch: 0, pending: 0, execution_failed: 0, not_observed: 0 };
    for (const row of results) counts[row.evaluation?.scores[dimension] ?? "execution_failed"]++;
    return [dimension, counts];
  }));
  const failures = Object.values(getRoleCallTelemetry()).reduce((sum, role) => sum + role.failures, 0);
  const hasMismatch = Object.values(dimensions).some(count => count.mismatch || count.execution_failed || count.not_observed);
  const status = results.length !== planned || failures || hasMismatch ? "failed"
    : observePending && pending.length ? "diagnostic_pending_labels" : "passed_labeled_subset";
  return { status, selected_plan_complete: results.length === planned, execution_failures: failures, dimensions };
}
function save(): void {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ ...metadata, ...summary(), elapsed_ms: Date.now() - started,
    cost: getCostReport(), telemetry: getRoleCallTelemetry(), results }, null, 2), { mode: 0o600 });
}
async function audit(row: RatioCase): Promise<void> {
  try {
    const check = await verifyDisplayedQuoteCoverage({ statement: row.statement, headline: "", importance_basis: "" },
      [{ content_item_id: "synthetic-ratio", claim: row.statement, quote: row.quote,
        locator: { paragraph_index: 0, char_start: 0, char_end: row.quote.length } }], 1,
      undefined, AbortSignal.timeout(120_000), row.source);
    const evaluation = scoreRatioCheck(row.expected, check);
    const countercheck = check.claims[0]?.countercheck;
    results.push({ id: row.id, expected: row.expected, statement: row.statement, evaluation,
      audit: { input_hash: check.input_hash, prompt_hash: check.prompt_hash, checked_at: check.checked_at,
        primary_decisions: check.primary_decisions,
        countercheck: countercheck ? { supports: countercheck.supports, reason: countercheck.reason,
          input_hash: countercheck.input_hash, prompt_hash: countercheck.prompt_hash, checked_at: countercheck.checked_at,
          model: countercheck.model, prompt_version: countercheck.prompt_version } : null,
      },
    });
    console.log(JSON.stringify({ id: row.id, ...evaluation }));
  } catch (error) {
    const failure = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "execution_failed";
    results.push({ id: row.id, expected: row.expected, statement: row.statement, error: failure });
    console.log(JSON.stringify({ id: row.id, error: failure }));
  } finally { save(); }
}
for (const row of cases) await audit(row);
for (const fixture of readerRatioCases) {
  const expected = readerRatioDimensionCases.find(row => row.id === `${fixture.id}-good`)!.expected;
  try {
    const statement = await rewriteReaderStatementChinese(fixture.source, fixture.source, undefined, AbortSignal.timeout(120_000));
    if (!containsChinese(statement) || !isCompleteStatement(statement)) {
      results.push({ id: `${fixture.id}-generated`, expected, statement, error: "invalid_reader_language_or_incomplete" });
      save();
      continue;
    }
    await audit({ id: `${fixture.id}-generated`, source: fixture.source, quote: fixture.source, statement, expected });
  } catch (error) {
    const failure = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "execution_failed";
    results.push({ id: `${fixture.id}-generated`, expected, error: failure });
    console.log(JSON.stringify({ id: `${fixture.id}-generated`, error: failure }));
    save();
  }
}
save();
const final = summary();
console.log(JSON.stringify({ output, ...final, total: results.length, deferred_cases: pending.length, elapsed_ms: Date.now() - started, cost: getCostReport() }));
if (final.status !== "passed_labeled_subset") process.exitCode = 1;

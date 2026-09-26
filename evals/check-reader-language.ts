/** Bounded real-model check of the production repair gate on synthetic facts, not a quality baseline. */
import "./load-env.js";
import assert from "node:assert/strict";
import { filterByQuoteCoverage, verifyDisplayedQuoteCoverage, type CoverageDecision } from "../src/lib/agents/analyzer.js";
import { containsChinese } from "../src/lib/agents/reader-language.js";
import { auditSupportsReaderStatement } from "../src/lib/utils/display-coverage-audit.js";
import { MODELS } from "../src/lib/runtime/llm.js";
import type { Insight } from "../src/lib/types.js";

const cases = [
  { id: "latency", quote: "Atlas reduces latency by 20%.", statement: "Atlas reduces latency by 20%.", keep: true },
  { id: "subscription", quote: "Nimbus supports three subscription types.", statement: "Nimbus supports three subscription types.", keep: true },
  { id: "unsafe-number", quote: "Atlas reduces latency by 20%.", statement: "Atlas reduces latency by 99%.", keep: false },
];
const started = Date.now();
let tokens = 0;
let amount = 0;
const results: Record<string, unknown>[] = [];
for (const row of cases) {
  const insight: Insight = {
    id: row.id, topic_id: "synthetic-zh", type: "aggregation", event_id: null, statement: row.statement,
    statement_citation_index: 1, importance: 3, importance_reason: "engineering_decision",
    importance_reason_claim_indexes: [1], importance_facts: [], importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", headline: "",
    citations: [{ content_item_id: "synthetic-content", claim: row.statement, quote: row.quote,
      locator: { paragraph_index: 0, char_start: 0, char_end: row.quote.length } }],
    source_count: 1, multi_source: false, time_window: { start: "", end: "" }, confidence: null,
    language: "zh", is_followup: false, entities: [], tags: [],
  };
  const decisions: CoverageDecision[] = [];
  const result = await filterByQuoteCoverage([insight], (cost) => { tokens += cost.tokens; amount += cost.amount; },
    undefined, (decision) => decisions.push(decision), AbortSignal.timeout(300_000));
  assert.equal(decisions.length, 1, `${row.id}: one terminal decision`);
  assert.equal(result.length, row.keep ? 1 : 0, `${row.id}: expected keep/drop`);
  if (row.keep) {
    assert(containsChinese(result[0].reader_statement ?? ""));
    assert(auditSupportsReaderStatement({ gate_version: decisions[0].gate_version, decision: decisions[0] }, result[0].reader_statement));
    assert.equal(result[0].statement, row.quote);
    assert.equal(result[0].citations[0].quote, row.quote);
    assert.deepEqual(result[0].citations[0].locator, { paragraph_index: 0, char_start: 0, char_end: row.quote.length });
    assert.equal(decisions[0].reader_language_repair?.status, "repaired");
  } else {
    assert.equal(decisions[0].reader_language_repair, undefined, "Unsafe original must never reach repair");
  }
  results.push({ id: row.id, kept: result.length, repair: decisions[0].reader_language_repair?.status ?? "not_called",
    input_hash: decisions[0].input_hash ?? null });
}
// Real primary judge must reject a different fact even when it is supported by the same quote.
for (const row of [
  { id: "changed-fact", source: "Atlas reduces latency by 20%.", translated: "Atlas 将内存使用降低 30%。",
    quote: "Atlas reduces latency by 20% and memory usage by 30%." },
  { id: "lost-condition", source: "Atlas reduces latency by 20% in controlled tests.", translated: "Atlas 将延迟降低 20%。",
    quote: "Atlas reduces latency by 20% in controlled tests and production deployments." },
]) {
  const audit = await verifyDisplayedQuoteCoverage({ statement: row.translated, headline: "", importance_basis: "" },
    [{ content_item_id: "synthetic-content", claim: row.translated, quote: row.quote,
      locator: { paragraph_index: 0, char_start: 0, char_end: row.quote.length } }], 1,
    (cost) => { tokens += cost.tokens; amount += cost.amount; }, AbortSignal.timeout(300_000), row.source);
  assert.equal(audit.claims[0]?.reason, "judge_not_supported", `${row.id}: primary equivalence rejection, not infrastructure failure`);
  assert.equal(audit.covered, false);
  results.push({ id: row.id, kept: 0, repair: "equivalence_rejected", input_hash: audit.input_hash });
}
console.log(JSON.stringify({ scope: "synthetic-reader-language-production-gate", promotable: false,
  models: { analyzer: MODELS.analyzer, validator: MODELS.validator, coverage: MODELS.coverage },
  results, elapsed_ms: Date.now() - started, cost: { tokens, amount, estimated: true } }, null, 2));

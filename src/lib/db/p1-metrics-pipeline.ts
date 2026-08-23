/** P1b-2 adapters: attach metric facts to committed writers without affecting publication decisions. */
import { createHash } from "node:crypto";
import type { Cost, AnalysisBatch, ContentItem, ValidationResult } from "../types.js";
import { MODELS } from "../runtime/llm.js";
import { runLogger } from "../runtime/logger.js";
import { notifyMetricLateFact } from "../runtime/metric-alert.js";
import type { DB } from "./index.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, hasMetricFactsSchema, isMetricLateEvent } from "./p1-metrics-facts.js";

const PIPELINE_VERSION = "p1b-2-v1";
type FactKind = "funnel" | "cost" | "validator";

function metricFactId(kind: FactKind, parts: unknown[]): string {
  return `p1:${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)}`;
}
function metricItemTrace(item: ContentItem, topicId: string): string { return metricFactId("funnel", ["trace", item.id, item.content_hash, topicId]); }
function metricFactExists(db: DB, kind: FactKind, id: string): boolean {
  const table = kind === "funnel" ? "funnel_event" : kind === "cost" ? "cost_ledger" : "validator_result_fact";
  const column = kind === "funnel" ? "event_id" : kind === "cost" ? "entry_id" : "result_id";
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND ${column}=?`).get("default", id));
}
/** Replays retain the original event-time; other semantic changes still reach the append conflict audit. */
function metricFactOccurredAt(db: DB, kind: Exclude<FactKind, "funnel">, id: string, fallback: string): string {
  const table = kind === "cost" ? "cost_ledger" : "validator_result_fact"; const column = kind === "cost" ? "entry_id" : "result_id";
  return (db.prepare(`SELECT occurred_at FROM ${table} WHERE tenant_id=? AND ${column}=?`).get("default", id) as { occurred_at: string } | undefined)?.occurred_at ?? fallback;
}
function safelyRecord(label: string, write: () => void): void {
  try { write(); } catch (error) {
    runLogger({ stage: "p1-metrics" }).warn({ err: error instanceof Error ? error.message : String(error) }, `${label} 指标事实写入失败（不影响主流水线）`);
  }
}
function alertIfQuarantined(db: DB, kind: FactKind, id: string, occurredAt: string): void {
  if (isMetricLateEvent(db, kind, id)) notifyMetricLateFact({ factKind: kind, eventId: id, occurredAt });
}
function cents(cost: Cost): number { return Math.max(0, Math.round(cost.amount * 100)); }
function checkReason(check: ValidationResult["checks"][number]): "source_not_found" | "source_unreachable" | "quote_not_in_source" | "out_of_context" | "exaggeration" | "misattribution" | "uncertain" | "not_evaluated" | "internal_error" {
  if (check.reachability_reason !== "ok") return check.reachability_reason;
  if (check.consistency_reason !== "ok") return check.consistency_reason === "not_evaluated" ? "internal_error" : check.consistency_reason;
  return "not_evaluated";
}

function appendItemStage(db: DB, input: { item: ContentItem; topicId: string; runId: string; stage: "received" | "accepted" | "processed" | "validated" | "failed"; occurredAt: string; reasonCode?: ReturnType<typeof checkReason> }): void {
  const id = metricFactId("funnel", [input.item.id, input.item.content_hash, input.topicId, input.stage]);
  if (metricFactExists(db, "funnel", id)) return;
  const traceId = metricItemTrace(input.item, input.topicId);
  const latest = db.prepare("SELECT occurred_at FROM funnel_event WHERE tenant_id=? AND trace_id=? ORDER BY occurred_at DESC LIMIT 1")
    .get("default", traceId) as { occurred_at: string } | undefined;
  const occurredAt = input.stage === "received" || !latest || Date.parse(input.occurredAt) > Date.parse(latest.occurred_at)
    ? input.occurredAt : new Date(Date.parse(latest.occurred_at) + 1).toISOString();
  const ingestedAt = new Date(Math.max(Date.now(), Date.parse(occurredAt))).toISOString();
  appendFunnelEvent(db, {
    event_id: id, trace_id: traceId, run_id: input.runId, topic_id: input.topicId, source_id: input.item.source_id,
    stage: input.stage, pipeline_version: PIPELINE_VERSION, reason_code: input.reasonCode,
    occurred_at: occurredAt, ingested_at: ingestedAt,
  });
  alertIfQuarantined(db, "funnel", id, occurredAt);
}
function appendAnalysisStages(db: DB, input: { items: ContentItem[]; topicId: string; runId: string; occurredAt: string }): void {
  for (const item of input.items) {
    appendItemStage(db, { item, topicId: input.topicId, runId: input.runId, stage: "received", occurredAt: item.fetched_at });
    appendItemStage(db, { item, topicId: input.topicId, runId: input.runId, stage: "accepted", occurredAt: input.occurredAt });
    appendItemStage(db, { item, topicId: input.topicId, runId: input.runId, stage: "processed", occurredAt: input.occurredAt });
  }
}

/** Collection emits the first, deterministic fact for each content revision. */
export function appendCollectorMetricFact(db: DB, input: { run_id: string; item: ContentItem }): void {
  if (!hasMetricFactsSchema(db)) return;
  safelyRecord("collector", () => {
    for (const topicId of input.item.topic_ids) appendItemStage(db, { item: input.item, topicId, runId: input.run_id, stage: "received", occurredAt: input.item.fetched_at });
  });
}

export function appendAnalysisMetricFacts(db: DB, input: { batch: AnalysisBatch; items: ContentItem[]; run_id: string; costs: Cost[] }): void {
  if (!hasMetricFactsSchema(db)) return;
  safelyRecord("analysis", () => {
    const occurredAt = new Date().toISOString();
    appendAnalysisStages(db, { items: input.items, topicId: input.batch.topic_id, runId: input.run_id, occurredAt });
    input.costs.forEach((cost, index) => {
      const id = metricFactId("cost", [input.batch.id, "analyze", index]);
      const factOccurredAt = metricFactOccurredAt(db, "cost", id, occurredAt);
      appendCostLedger(db, { entry_id: id, trace_id: `metric:batch:${input.batch.id}`, stage: "processed", pipeline_version: PIPELINE_VERSION, topic_id: input.batch.topic_id,
        provider: "anthropic", model: MODELS.analyzer, currency: "USD", amount_minor: cents(cost), cost_status: "known", input_tokens: cost.tokens, output_tokens: 0, occurred_at: factOccurredAt, ingested_at: occurredAt });
      alertIfQuarantined(db, "cost", id, factOccurredAt);
    });
  });
}

export function appendValidationMetricFacts(db: DB, input: { batch: AnalysisBatch; validation: ValidationResult; items: ContentItem[]; run_id: string; costs: Cost[] }): void {
  if (!hasMetricFactsSchema(db)) return;
  safelyRecord("validation", () => {
    const occurredAt = new Date().toISOString(); const itemById = new Map(input.items.map((item) => [item.id, item]));
    const outcomes = new Map<string, ReturnType<typeof checkReason>>();
    for (const check of input.validation.checks) {
      const citation = input.batch.insights.find((insight) => insight.id === check.insight_id)?.citations[check.citation_index];
      const item = citation ? itemById.get(citation.content_item_id) : undefined;
      if (!item) continue;
      appendAnalysisStages(db, { items: [item], topicId: input.batch.topic_id, runId: input.run_id, occurredAt });
      const reason = checkReason(check);
      if (!outcomes.has(item.id) || outcomes.get(item.id) === "not_evaluated") outcomes.set(item.id, reason);
      const id = metricFactId("validator", [input.batch.id, check.insight_id, check.citation_index]);
      const factOccurredAt = metricFactOccurredAt(db, "validator", id, occurredAt);
      appendValidatorResult(db, { result_id: id, trace_id: metricItemTrace(item, input.batch.topic_id), stage: "validated", pipeline_version: PIPELINE_VERSION, topic_id: input.batch.topic_id, source_id: item.source_id,
        validator: "citation", rule_version: "citation-validation-v1", reason_code: checkReason(check), severity: check.verdict === "pass" ? "info" : check.verdict === "flagged" ? "warning" : "error", terminal: true, occurred_at: factOccurredAt, ingested_at: occurredAt });
      alertIfQuarantined(db, "validator", id, factOccurredAt);
    }
    for (const [itemId, reasonCode] of outcomes) {
      const item = itemById.get(itemId)!;
      appendItemStage(db, { item, topicId: input.batch.topic_id, runId: input.run_id, stage: "validated", occurredAt });
      if (reasonCode !== "not_evaluated") appendItemStage(db, { item, topicId: input.batch.topic_id, runId: input.run_id, stage: "failed", occurredAt: new Date(Date.parse(occurredAt) + 1).toISOString(), reasonCode });
    }
    input.costs.forEach((cost, index) => {
      const id = metricFactId("cost", [input.batch.id, "validate", index]);
      const factOccurredAt = metricFactOccurredAt(db, "cost", id, occurredAt);
      appendCostLedger(db, { entry_id: id, trace_id: `metric:batch:${input.batch.id}`, stage: "validated", pipeline_version: PIPELINE_VERSION, topic_id: input.batch.topic_id,
        provider: "anthropic", model: MODELS.validator, currency: "USD", amount_minor: cents(cost), cost_status: "known", input_tokens: cost.tokens, output_tokens: 0, occurred_at: factOccurredAt, ingested_at: occurredAt });
      alertIfQuarantined(db, "cost", id, factOccurredAt);
    });
  });
}

import { describe, expect, it, vi } from "vitest";
import type { AnalysisBatch, ContentItem, ValidationResult } from "../types.js";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { P1_METRICS_CAPACITY_FIXTURE } from "./p1-metrics-capacity-fixture.js";
import { appendAnalysisMetricFacts, appendCollectorMetricFact, appendValidationMetricFacts } from "./p1-metrics-pipeline.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, freezeDueMetricDay, freezeMetricDay, listCostLedgerDetails, listFunnelDetails, listMetricFactConflicts, listValidatorResultDetails, purgeExpiredMetricFacts, queryMetricRollups, reconcileLateMetricEvent } from "./p1-metrics-facts.js";

const metricAlerts = vi.hoisted(() => ({ late: vi.fn() }));
const metricLogs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../runtime/metric-alert.js", () => ({ notifyMetricLateFact: metricAlerts.late }));
vi.mock("../runtime/logger.js", () => ({ runLogger: () => ({ warn: metricLogs.warn }) }));

function dbWithMetrics() {
  const db = openDb(":memory:");
  applyProvenanceMigrations(db);
  return db;
}

describe("P1 dashboard metric facts", () => {
  it("keeps funnel-v1 idempotent, accepts event-time ordering, and records observable conflicts", () => {
    const db = dbWithMetrics();
    const common = { trace_id: "trace_1", pipeline_version: "pipeline-v1", ingested_at: "2026-08-01T01:00:00.000Z" };
    expect(appendFunnelEvent(db, { ...common, event_id: "accepted", stage: "accepted", occurred_at: "2026-08-01T00:01:00.000Z" })).toEqual({ event_id: "accepted", replayed: false });
    expect(appendFunnelEvent(db, { ...common, event_id: "received", stage: "received", occurred_at: "2026-08-01T00:00:00.000Z" })).toEqual({ event_id: "received", replayed: false });
    expect(appendFunnelEvent(db, { ...common, event_id: "accepted", stage: "accepted", occurred_at: "2026-08-01T00:01:00.000Z" })).toEqual({ event_id: "accepted", replayed: true });
    expect(() => appendFunnelEvent(db, { ...common, event_id: "accepted", stage: "accepted", occurred_at: "2026-08-01T00:02:00.000Z" })).toThrow("funnel_event_conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM funnel_event_conflict WHERE tenant_id='default'").get()).toEqual({ count: 1 });
    expect(() => appendFunnelEvent(db, { ...common, event_id: "bad-skip", stage: "validated", occurred_at: "2026-08-01T00:03:00.000Z" })).toThrow("funnel_skip_reason_required");
    expect(() => appendFunnelEvent(db, { ...common, event_id: "reverse", stage: "received", attempt: 1, occurred_at: "2026-08-01T00:04:00.000Z" })).toThrow("funnel_event_conflict");
  });

  it("appends immutable, queryable audit facts for divergent cost and validator replays", () => {
    const db = dbWithMetrics(); const time = "2026-08-01T01:00:00.000Z";
    const cost = { entry_id: "cost_replay", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 7, cost_status: "known" as const, occurred_at: time, ingested_at: time };
    const validator = { result_id: "validator_replay", trace_id: "trace_1", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "source_not_found", severity: "error" as const, terminal: true, occurred_at: time, ingested_at: time };
    expect(appendCostLedger(db, cost)).toEqual({ entry_id: "cost_replay", replayed: false });
    expect(appendCostLedger(db, cost)).toEqual({ entry_id: "cost_replay", replayed: true });
    expect(() => appendCostLedger(db, { ...cost, amount_minor: 8 })).toThrow("cost_idempotency_conflict");
    expect(appendValidatorResult(db, validator)).toEqual({ result_id: "validator_replay", replayed: false });
    expect(appendValidatorResult(db, validator)).toEqual({ result_id: "validator_replay", replayed: true });
    expect(() => appendValidatorResult(db, { ...validator, severity: "critical" })).toThrow("validator_idempotency_conflict");

    const costAudit = listMetricFactConflicts(db, { fact_kind: "cost", business_id: cost.entry_id }) as Array<Record<string, string>>;
    const validatorAudit = listMetricFactConflicts(db, { fact_kind: "validator", business_id: validator.result_id }) as Array<Record<string, string>>;
    for (const [fact, kind, id] of [[costAudit[0], "cost", cost.entry_id], [validatorAudit[0], "validator", validator.result_id]] as const) {
      expect(fact).toEqual(expect.objectContaining({ tenant_id: "default", fact_kind: kind, business_id: id, reason_code: "semantic_payload_mismatch", observed_at: time }));
      expect(fact.existing_semantic_payload_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(fact.received_semantic_payload_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(fact.received_semantic_payload_hash).not.toBe(fact.existing_semantic_payload_hash);
    }
    expect(db.prepare("SELECT amount_minor FROM cost_ledger WHERE entry_id='cost_replay'").get()).toEqual({ amount_minor: 7 });
    expect(db.prepare("SELECT severity FROM validator_result_fact WHERE result_id='validator_replay'").get()).toEqual({ severity: "error" });
    expect(() => db.prepare("UPDATE metric_fact_conflict SET reason_code='other' WHERE business_id='cost_replay'").run()).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM metric_fact_conflict WHERE business_id='validator_replay'").run()).toThrow("append-only");
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM metric_fact_conflict WHERE tenant_id='default' AND fact_kind='cost' AND business_id='cost_replay' ORDER BY observed_at DESC").all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_metric_fact_conflict_tenant_kind_business");
  });

  it("logs a controlled warning when a telemetry adapter cannot append its conflict audit", () => {
    const db = dbWithMetrics(); const batch = { id: "batch_audit_failure", topic_id: "topic_1" } as AnalysisBatch;
    metricLogs.warn.mockClear();
    appendAnalysisMetricFacts(db, { batch, items: [], run_id: "run_1", costs: [{ tokens: 1, amount: 0.01 }] });
    db.exec("CREATE TRIGGER metric_fact_conflict_reject BEFORE INSERT ON metric_fact_conflict BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    expect(() => appendAnalysisMetricFacts(db, { batch, items: [], run_id: "run_2", costs: [{ tokens: 1, amount: 0.02 }] })).not.toThrow();
    expect(metricLogs.warn).toHaveBeenCalledWith(expect.objectContaining({ err: "metric_conflict_audit_write_failed" }), expect.stringContaining("指标事实写入失败"));
  });

  it("materializes exact known, unknown, and validator aggregates then revises only inside the seven-day window", () => {
    const db = dbWithMetrics();
    const time = "2026-08-01T01:00:00.000Z";
    appendFunnelEvent(db, { event_id: "received", trace_id: "trace_1", stage: "received", pipeline_version: "pipeline-v1", occurred_at: time, ingested_at: time });
    appendCostLedger(db, { entry_id: "known", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 17, cost_status: "known", occurred_at: time, ingested_at: time });
    appendCostLedger(db, { entry_id: "unknown", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: null, cost_status: "unknown", occurred_at: time, ingested_at: "2026-08-02T03:00:00.000Z" });
    appendValidatorResult(db, { result_id: "validator", trace_id: "trace_1", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "source_not_found", severity: "error", terminal: true, occurred_at: time, ingested_at: "2026-08-02T03:00:00.000Z" });
    expect(db.prepare("SELECT known_cost_minor,known_cost_entries,unknown_cost_entries,frozen_at,revised_at FROM metric_rollup WHERE grain='day' AND metric_kind='cost'").get())
      .toEqual({ known_cost_minor: 17, known_cost_entries: 1, unknown_cost_entries: 1, frozen_at: "2026-08-02T02:00:00.000Z", revised_at: "2026-08-02T03:00:00.000Z" });
    expect(db.prepare("SELECT validator_results,validator_traces FROM metric_rollup WHERE grain='day' AND metric_kind='validator'").get()).toEqual({ validator_results: 1, validator_traces: 1 });
    appendCostLedger(db, { entry_id: "too-late", trace_id: "trace_2", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 99, cost_status: "known", occurred_at: time, ingested_at: "2026-08-10T03:00:00.000Z" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM metric_late_event WHERE fact_kind='cost'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT known_cost_minor FROM metric_rollup WHERE grain='day' AND metric_kind='cost'").get()).toEqual({ known_cost_minor: 17 });
  });

  it("uses the required indexes, bounds aggregate queries, and expires only metric data", () => {
    const db = dbWithMetrics();
    appendFunnelEvent(db, { event_id: "received", trace_id: "trace_1", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T01:00:00.000Z", ingested_at: "2026-08-01T01:00:00.000Z" });
    const funnelPlan = db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM funnel_event WHERE tenant_id='default' AND occurred_at>=? AND occurred_at<?").all("2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z") as { detail: string }[];
    const rollupPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM metric_rollup WHERE tenant_id='default' AND grain='day' AND bucket_start>=? AND bucket_start<?").all("2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z") as { detail: string }[];
    expect(funnelPlan.map((row) => row.detail).join("\n")).toContain("idx_funnel_event_tenant_occurred");
    expect(rollupPlan.map((row) => row.detail).join("\n")).toContain("idx_metric_rollup_tenant_grain_bucket");
    expect(listFunnelDetails(db, { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" })).toHaveLength(1);
    expect(() => listFunnelDetails(db, { from: "2026-08-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" })).toThrow("metric_detail_window_invalid");
    expect(queryMetricRollups(db, { grain: "day", from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" })).toHaveLength(1);
    expect(() => queryMetricRollups(db, { grain: "day", from: "2026-01-01T00:00:00.000Z", to: "2027-03-01T00:00:00.000Z" })).toThrow("metric_rollup_window_invalid");
    expect(purgeExpiredMetricFacts(db, "2027-01-01T00:00:00.000Z").details).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM funnel_event").get()).toEqual({ count: 0 });
  });

  it("freezes UTC days at 02:00, quarantines after seven days, and permits only explicit backfill reconciliation", () => {
    const db = dbWithMetrics();
    const time = "2026-08-01T01:00:00.000Z";
    appendCostLedger(db, { entry_id: "on-time", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", topic_id: "topic_1", source_id: "source_1", provider: "anthropic", model: "claude", currency: "USD", amount_minor: 5, cost_status: "known", occurred_at: time, ingested_at: time });
    expect(() => freezeMetricDay(db, "2026-08-01", "2026-08-02T01:59:59.999Z")).toThrow("metric_day_freeze_too_early");
    expect(freezeDueMetricDay(db, "2026-08-02T01:59:59.999Z")).toBe(false);
    expect(freezeDueMetricDay(db, "2026-08-02T02:00:00.000Z")).toBe(true);
    expect(freezeDueMetricDay(db, "2026-08-02T03:00:00.000Z")).toBe(false);
    expect(db.prepare("SELECT frozen_at FROM metric_rollup WHERE grain='day' AND metric_kind='cost'").get()).toEqual({ frozen_at: "2026-08-02T02:00:00.000Z" });
    appendCostLedger(db, { entry_id: "quarantined", trace_id: "trace_2", stage: "processed", pipeline_version: "pipeline-v1", topic_id: "topic_1", source_id: "source_1", provider: "anthropic", model: "claude", currency: "USD", amount_minor: 7, cost_status: "known", occurred_at: time, ingested_at: "2026-08-10T02:00:00.001Z" });
    expect(db.prepare("SELECT count(*) AS count FROM metric_late_event WHERE fact_kind='cost'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT known_cost_minor FROM metric_rollup WHERE grain='day' AND metric_kind='cost'").get()).toEqual({ known_cost_minor: 5 });
    expect(reconcileLateMetricEvent(db, { fact_kind: "cost", event_id: "quarantined", action: "backfilled", actor_id: "admin_1", recorded_at: "2026-08-10T03:00:00.000Z" }).id).toMatch(/^mlr_/);
    expect(db.prepare("SELECT known_cost_minor,revised_at FROM metric_rollup WHERE grain='day' AND metric_kind='cost'").get()).toEqual({ known_cost_minor: 12, revised_at: "2026-08-10T03:00:00.000Z" });
    expect(() => db.prepare("UPDATE cost_ledger SET amount_minor=99 WHERE entry_id='on-time'").run()).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM cost_ledger WHERE entry_id='on-time'").run()).toThrow("append-only");
  });

  it("rolls up topic/source and first terminal reason, with all dashboard reads using indexed plans", () => {
    const db = dbWithMetrics(); const time = "2026-08-01T01:00:00.000Z";
    expect(P1_METRICS_CAPACITY_FIXTURE.version).toBe("p1-metrics-capacity-v2");
    appendFunnelEvent(db, { event_id: "received", trace_id: "trace_1", stage: "received", topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1", occurred_at: time, ingested_at: time });
    appendFunnelEvent(db, { event_id: "failed", trace_id: "trace_1", stage: "failed", topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1", reason_code: "quote_not_in_source", occurred_at: "2026-08-01T01:01:00.000Z", ingested_at: "2026-08-01T01:01:00.000Z" });
    appendCostLedger(db, { entry_id: "cost", trace_id: "trace_1", stage: "processed", topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1", provider: "anthropic", model: "claude", currency: "USD", amount_minor: 4, cost_status: "known", occurred_at: time, ingested_at: time });
    appendValidatorResult(db, { result_id: "validator", trace_id: "trace_1", stage: "validated", topic_id: "topic_1", source_id: "source_1", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: time, ingested_at: time });
    expect(db.prepare("SELECT topic_id,source_id,reason_code,terminal_events FROM metric_rollup WHERE grain='hour' AND metric_kind='funnel' AND stage='failed'").get()).toEqual({ topic_id: "topic_1", source_id: "source_1", reason_code: "quote_not_in_source", terminal_events: 1 });
    expect(listCostLedgerDetails(db, P1_METRICS_CAPACITY_FIXTURE.window)).toHaveLength(1);
    expect(listValidatorResultDetails(db, P1_METRICS_CAPACITY_FIXTURE.window)).toHaveLength(1);
    const plans = [
      "EXPLAIN QUERY PLAN SELECT * FROM funnel_event WHERE tenant_id='default' AND occurred_at>=? AND occurred_at<?",
      "EXPLAIN QUERY PLAN SELECT * FROM cost_ledger WHERE tenant_id='default' AND occurred_at>=? AND occurred_at<?",
      "EXPLAIN QUERY PLAN SELECT * FROM validator_result_fact WHERE tenant_id='default' AND occurred_at>=? AND occurred_at<?",
      "EXPLAIN QUERY PLAN SELECT * FROM metric_rollup WHERE tenant_id='default' AND grain='day' AND bucket_start>=? AND bucket_start<?",
    ].map((sql) => (db.prepare(sql).all(P1_METRICS_CAPACITY_FIXTURE.window.from, P1_METRICS_CAPACITY_FIXTURE.window.to) as { detail: string }[]).map((row) => row.detail).join("\n"));
    expect(plans[0]).toContain("idx_funnel_event_tenant_occurred");
    expect(plans[1]).toContain("idx_cost_ledger_tenant_occurred_provider_model");
    expect(plans[2]).toContain("idx_validator_result_tenant_occurred");
    expect(plans[3]).toContain("idx_metric_rollup_tenant_grain_bucket");
  });

  it("writes collector, analysis, validation, cost, and terminal facts idempotently across a replay", () => {
    const db = dbWithMetrics();
    const item = { id: "ci_1", source_id: "source_1", content_hash: "hash_1", fetched_at: "2026-08-01T00:00:00.000Z", topic_ids: ["topic_1"] } as ContentItem;
    const batch = { id: "batch_1", topic_id: "topic_1", insights: [{ id: "insight_1", citations: [{ content_item_id: "ci_1" }] }] } as unknown as AnalysisBatch;
    const validation = { checks: [{ insight_id: "insight_1", citation_index: 0, reachability_reason: "quote_not_in_source", consistency_reason: "not_evaluated", verdict: "blocked" }] } as unknown as ValidationResult;
    appendCollectorMetricFact(db, { run_id: "run_1", item });
    appendAnalysisMetricFacts(db, { batch, items: [item], run_id: "run_2", costs: [{ tokens: 5, amount: 0.01 }] });
    appendValidationMetricFacts(db, { batch, validation, items: [item], run_id: "run_3", costs: [{ tokens: 7, amount: 0.02 }] });
    const first = db.prepare("SELECT (SELECT COUNT(*) FROM funnel_event) AS funnel,(SELECT COUNT(*) FROM cost_ledger) AS cost,(SELECT COUNT(*) FROM validator_result_fact) AS validator").get();
    appendCollectorMetricFact(db, { run_id: "run_retry", item });
    appendAnalysisMetricFacts(db, { batch, items: [item], run_id: "run_retry", costs: [{ tokens: 5, amount: 0.01 }] });
    appendValidationMetricFacts(db, { batch, validation, items: [item], run_id: "run_retry", costs: [{ tokens: 7, amount: 0.02 }] });
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM funnel_event) AS funnel,(SELECT COUNT(*) FROM cost_ledger) AS cost,(SELECT COUNT(*) FROM validator_result_fact) AS validator").get()).toEqual(first);
    expect(db.prepare("SELECT stage,reason_code FROM funnel_event WHERE stage='failed'").get()).toEqual({ stage: "failed", reason_code: "quote_not_in_source" });
  });

  it("alerts once when an adapter quarantines a fact outside the seven-day backfill window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T03:00:00.000Z"));
    metricAlerts.late.mockClear();
    try {
      const db = dbWithMetrics();
      const item = { id: "ci_late", source_id: "source_1", content_hash: "hash_late", fetched_at: "2026-08-01T00:00:00.000Z", topic_ids: ["topic_1"] } as ContentItem;
      appendCollectorMetricFact(db, { run_id: "run_late", item });
      appendCollectorMetricFact(db, { run_id: "run_late_retry", item });
      expect(db.prepare("SELECT count(*) AS count FROM metric_late_event WHERE fact_kind='funnel'").get()).toEqual({ count: 1 });
      expect(metricAlerts.late).toHaveBeenCalledOnce();
      expect(metricAlerts.late).toHaveBeenCalledWith(expect.objectContaining({ factKind: "funnel", occurredAt: item.fetched_at }));
    } finally {
      vi.useRealTimers();
    }
  });
});

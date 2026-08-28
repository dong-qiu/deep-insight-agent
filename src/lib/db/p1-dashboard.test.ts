import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, purgeExpiredMetricFacts, reconcileLateMetricEvent } from "./p1-metrics-facts.js";
import { P1_METRICS_CAPACITY_FIXTURE } from "./p1-metrics-capacity-fixture.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { explainP1DashboardQueries, readIntegrityDashboardStatus, readP1DashboardMetrics } from "./p1-dashboard.js";

function dbWithP1() {
  const db = openDb(":memory:");
  applyProvenanceMigrations(db);
  return db;
}

describe("P1 dashboard read model", () => {
  it("uses only bounded tenant-prefixed projections for funnel, cost, latency, and validator reasons", () => {
    const db = dbWithP1();
    const at = "2026-08-01T01:00:00.000Z";
    appendFunnelEvent(db, { event_id: "received", trace_id: "trace_1", stage: "received", pipeline_version: "pipeline-v1", occurred_at: at, ingested_at: at });
    appendFunnelEvent(db, { event_id: "accepted", trace_id: "trace_1", stage: "accepted", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T01:00:01.000Z", ingested_at: "2026-08-01T01:00:01.000Z" });
    appendFunnelEvent(db, { event_id: "failed", trace_id: "trace_1", stage: "failed", pipeline_version: "pipeline-v1", reason_code: "quote_not_in_source", occurred_at: "2026-08-01T01:00:03.000Z", ingested_at: "2026-08-01T01:00:03.000Z" });
    appendFunnelEvent(db, { event_id: "in-progress", trace_id: "trace_2", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T01:00:04.000Z", ingested_at: "2026-08-01T01:00:04.000Z" });
    appendCostLedger(db, { entry_id: "known", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", provider: "anthropic", model: "claude", currency: "USD", amount_minor: 9, cost_status: "known", occurred_at: at, ingested_at: at });
    appendCostLedger(db, { entry_id: "unknown", trace_id: "trace_1", stage: "processed", pipeline_version: "pipeline-v1", provider: "anthropic", model: "claude", currency: "USD", amount_minor: null, cost_status: "unknown", occurred_at: at, ingested_at: at });
    appendValidatorResult(db, { result_id: "validator", trace_id: "trace_1", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: at, ingested_at: at });

    const dashboard = readP1DashboardMetrics(db, { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
    expect(dashboard.funnel).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "received", received_traces: 2, conversion_pct: 100 })]));
    expect(dashboard.costs).toEqual([{ bucket_date: "2026-08-01", topic_id: "", source_id: "", pipeline_version: "pipeline-v1", stage: "processed", provider: "anthropic", model: "claude", currency: "USD", known_cost_minor: 9, known_cost_entries: 1, unknown_cost_entries: 1 }]);
    expect(dashboard.funnel_loss_reasons).toEqual([{ reason_code: "quote_not_in_source", traces: 1 }]);
    expect(dashboard.validator_reasons).toEqual([{ topic_id: "", source_id: "", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", results: 1, traces: 1 }]);
    expect(dashboard.latency).toEqual(expect.arrayContaining([expect.objectContaining({ transition: "received → accepted", samples: 1, p50_ms: 1000 })]));
    expect(dashboard.latency_diagnostics).toEqual(expect.objectContaining({ completed_traces: 1, in_progress_traces: 1, negative_clock_samples: 0 }));
    expect(readIntegrityDashboardStatus(db, dashboard.window)).toEqual({ latest_daily_root: null, recent_events: [] });
  });

  it("rejects windows beyond the 400-day aggregate cap and proves indexed access", () => {
    const db = dbWithP1();
    expect(() => readP1DashboardMetrics(db, { from: "2026-01-01T00:00:00.000Z", to: "2027-03-01T00:00:00.000Z" })).toThrow("dashboard_window_invalid");
    expect(P1_METRICS_CAPACITY_FIXTURE.version).toBe("p1-metrics-capacity-v4");
    const plans = explainP1DashboardQueries(db, P1_METRICS_CAPACITY_FIXTURE.detail_window);
    expect(plans[0]).toContain("idx_dashboard_trace_fact_v1_window");
    expect(plans[1]).toContain("idx_dashboard_trace_fact_v1_window");
    expect(plans[2]).toContain("idx_dashboard_trace_fact_v1_window");
    expect(plans[3]).toContain("idx_metric_rollup_tenant_grain_bucket");
    expect(plans[4]).toContain("idx_dashboard_trace_fact_v1_kind_window");
    expect(plans[5]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
    expect(plans[6]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
    expect(plans[7]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
    expect(plans[8]).toContain("sqlite_autoindex_integrity_daily_root");
    expect(plans[9]).toContain("idx_integrity_audit_pending");
  });

  it("keeps late funnel, cost, and validator facts out of every aggregate projection until an admin backfills them", () => {
    const db = dbWithP1(); const occurred = "2026-08-01T01:00:00.000Z"; const late = "2026-08-10T02:00:00.001Z";
    appendFunnelEvent(db, { event_id: "late-funnel", trace_id: "late-trace", stage: "received", pipeline_version: "pipeline-v1", occurred_at: occurred, ingested_at: late });
    appendCostLedger(db, { entry_id: "late-cost", trace_id: "late-trace", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 9, cost_status: "known", occurred_at: occurred, ingested_at: late });
    appendValidatorResult(db, { result_id: "late-validator", trace_id: "late-trace", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "internal_error", severity: "error", terminal: true, occurred_at: occurred, ingested_at: late });
    const window = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" };
    expect(readP1DashboardMetrics(db, window).costs).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM dashboard_trace_fact_v1").get()).toEqual({ count: 0 });
    reconcileLateMetricEvent(db, { fact_kind: "cost", event_id: "late-cost", action: "backfilled", actor_id: "admin_1", recorded_at: "2026-08-10T03:00:00.000Z" });
    expect(readP1DashboardMetrics(db, window).costs).toEqual([expect.objectContaining({ known_cost_minor: 9 })]);
    reconcileLateMetricEvent(db, { fact_kind: "funnel", event_id: "late-funnel", action: "declined", actor_id: "admin_1" });
    reconcileLateMetricEvent(db, { fact_kind: "validator", event_id: "late-validator", action: "declined", actor_id: "admin_1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dashboard_trace_fact_v1").get()).toEqual({ count: 0 });
  });

  it("serves an exact 400-day aggregate from the indexed trace projection", () => {
    const db = dbWithP1();
    appendFunnelEvent(db, { event_id: "long-received", trace_id: "long-trace", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T01:00:00.000Z", ingested_at: "2026-08-01T01:00:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-accepted", trace_id: "long-trace", stage: "accepted", pipeline_version: "pipeline-v1", occurred_at: "2026-08-15T01:00:00.000Z", ingested_at: "2026-08-15T01:00:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-failed", trace_id: "long-trace", stage: "failed", pipeline_version: "pipeline-v1", reason_code: "quote_not_in_source", occurred_at: "2026-09-01T01:00:00.000Z", ingested_at: "2026-09-01T01:00:00.000Z" });
    appendValidatorResult(db, { result_id: "long-validator-1", trace_id: "long-trace", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: "2026-08-03T01:00:00.000Z", ingested_at: "2026-08-03T01:00:00.000Z" });
    appendValidatorResult(db, { result_id: "long-validator-2", trace_id: "long-trace", stage: "validated", pipeline_version: "pipeline-v1", validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: "2026-08-04T01:00:00.000Z", ingested_at: "2026-08-04T01:00:00.000Z" });
    const window = P1_METRICS_CAPACITY_FIXTURE.aggregate_window;

    const dashboard = readP1DashboardMetrics(db, window);
    expect(dashboard.funnel).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "received", received_traces: 1 }), expect.objectContaining({ stage: "accepted", reached_traces: 1 })]));
    expect(dashboard.funnel_loss_reasons).toEqual([{ reason_code: "quote_not_in_source", traces: 1 }]);
    expect(dashboard.validator_reasons).toEqual([expect.objectContaining({ results: 2, traces: 1 })]);
    expect(dashboard.latency).toEqual(expect.arrayContaining([expect.objectContaining({ transition: "received → accepted", samples: 1, p50_ms: 1209600000 })]));
    expect(readIntegrityDashboardStatus(db, window).recent_events).toEqual([]);

    const plans = explainP1DashboardQueries(db, P1_METRICS_CAPACITY_FIXTURE.aggregate_partial_window);
    expect(plans).toHaveLength(9);
    expect(plans[0]).toContain("idx_dashboard_trace_fact_v1_window");
    expect(plans[3]).toContain("idx_dashboard_cost_fact_v1_window");
    expect(plans[3]).toContain("idx_metric_rollup_tenant_grain_bucket");
    expect(plans[4]).toContain("idx_dashboard_trace_fact_v1_kind_window");
    expect(plans[5]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
    expect(plans[6]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
    expect(plans[7]).toContain("idx_dashboard_trace_fact_v1_terminal_window");
  });

  it("keeps long-window latency diagnostics and partial UTC-day costs exact", () => {
    const db = dbWithP1();
    const window = { from: "2026-08-01T12:00:00.000Z", to: "2026-09-02T12:00:00.000Z" };
    appendFunnelEvent(db, { event_id: "long-completed-received", trace_id: "long-completed", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T12:00:00.000Z", ingested_at: "2026-08-01T12:00:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-completed-accepted", trace_id: "long-completed", stage: "accepted", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T12:01:00.000Z", ingested_at: "2026-08-01T12:01:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-completed-terminal", trace_id: "long-completed", stage: "failed", pipeline_version: "pipeline-v1", reason_code: "internal_error", occurred_at: "2026-08-01T12:02:00.000Z", ingested_at: "2026-08-01T12:02:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-missing-received", trace_id: "long-missing", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-03T01:00:00.000Z", ingested_at: "2026-08-03T01:00:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-missing-terminal", trace_id: "long-missing", stage: "failed", pipeline_version: "pipeline-v1", reason_code: "internal_error", occurred_at: "2026-08-03T01:01:00.000Z", ingested_at: "2026-08-03T01:01:00.000Z" });
    appendFunnelEvent(db, { event_id: "long-in-progress", trace_id: "long-in-progress", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-04T01:00:00.000Z", ingested_at: "2026-08-04T01:00:00.000Z" });
    db.prepare(`INSERT INTO dashboard_trace_fact_v1(tenant_id,fact_kind,fact_id,trace_id,attempt,stage,event_type,pipeline_version,occurred_at,projection_version)
      VALUES ('default','funnel','long-negative-received','long-negative',1,'received','entered','pipeline-v1','2026-08-05T02:00:00.000Z','dashboard-trace-v1'),
        ('default','funnel','long-negative-accepted','long-negative',1,'accepted','entered','pipeline-v1','2026-08-05T01:00:00.000Z','dashboard-trace-v1'),
        ('default','funnel','long-negative-terminal','long-negative',1,'failed','terminal','pipeline-v1','2026-08-05T03:00:00.000Z','dashboard-trace-v1')`).run();
    appendCostLedger(db, { entry_id: "before-window", trace_id: "long-completed", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 100, cost_status: "known", occurred_at: "2026-08-01T11:00:00.000Z", ingested_at: "2026-08-01T11:00:00.000Z" });
    appendCostLedger(db, { entry_id: "first-boundary", trace_id: "long-completed", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 7, cost_status: "known", occurred_at: "2026-08-01T13:00:00.000Z", ingested_at: "2026-08-01T13:00:00.000Z" });
    appendCostLedger(db, { entry_id: "middle-day", trace_id: "long-completed", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", amount_minor: 9, cost_status: "known", occurred_at: "2026-08-02T01:00:00.000Z", ingested_at: "2026-08-02T01:00:00.000Z" });

    const dashboard = readP1DashboardMetrics(db, window);
    expect(dashboard.latency).toEqual(expect.arrayContaining([expect.objectContaining({ transition: "received → accepted", samples: 1, p50_ms: 60_000 })]));
    expect(dashboard.latency_diagnostics).toEqual({ completed_traces: 3, in_progress_traces: 1, negative_clock_samples: 1, missing_clock_samples: 1 });
    expect(dashboard.costs).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket_date: "2026-08-01", known_cost_minor: 7, known_cost_entries: 1 }),
      expect.objectContaining({ bucket_date: "2026-08-02", known_cost_minor: 9, known_cost_entries: 1 }),
    ]));
  });

  it("does not include known or unknown costs after to in a same-UTC-day partial window", () => {
    const db = dbWithP1();
    const common = { trace_id: "same-day-cost", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD" };
    appendCostLedger(db, { ...common, entry_id: "same-day-before", amount_minor: 100, cost_status: "known", occurred_at: "2026-08-01T11:00:00.000Z", ingested_at: "2026-08-01T11:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "same-day-known", amount_minor: 7, cost_status: "known", occurred_at: "2026-08-01T13:00:00.000Z", ingested_at: "2026-08-01T13:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "same-day-unknown", amount_minor: null, cost_status: "unknown", occurred_at: "2026-08-01T14:00:00.000Z", ingested_at: "2026-08-01T14:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "same-day-known-after", amount_minor: 11, cost_status: "known", occurred_at: "2026-08-01T19:00:00.000Z", ingested_at: "2026-08-01T19:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "same-day-unknown-after", amount_minor: null, cost_status: "unknown", occurred_at: "2026-08-01T20:00:00.000Z", ingested_at: "2026-08-01T20:00:00.000Z" });

    expect(readP1DashboardMetrics(db, { from: "2026-08-01T12:00:00.000Z", to: "2026-08-01T18:00:00.000Z" }).costs)
      .toEqual([expect.objectContaining({ bucket_date: "2026-08-01", known_cost_minor: 7, known_cost_entries: 1, unknown_cost_entries: 1 })]);
  });

  it("keeps 91–400-day partial cost boundaries exact after raw detail retention expires", () => {
    const db = dbWithP1();
    const window = { from: "2025-08-01T12:00:00.000Z", to: "2025-09-02T12:00:00.000Z" };
    const common = { trace_id: "retained-cost", stage: "processed", pipeline_version: "pipeline-v1", provider: "openai", model: "gpt", currency: "USD", cost_status: "known" as const };
    appendCostLedger(db, { ...common, entry_id: "retained-before", amount_minor: 100, occurred_at: "2025-08-01T11:00:00.000Z", ingested_at: "2025-08-01T11:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "retained-first", amount_minor: 7, occurred_at: "2025-08-01T13:00:00.000Z", ingested_at: "2025-08-01T13:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "retained-middle", amount_minor: 9, occurred_at: "2025-08-02T01:00:00.000Z", ingested_at: "2025-08-02T01:00:00.000Z" });
    appendCostLedger(db, { ...common, entry_id: "retained-last", amount_minor: 11, occurred_at: "2025-09-02T11:00:00.000Z", ingested_at: "2025-09-02T11:00:00.000Z" });

    purgeExpiredMetricFacts(db, "2026-01-01T00:00:00.000Z");
    expect(db.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dashboard_cost_fact_v1").get()).toEqual({ count: 4 });

    expect(readP1DashboardMetrics(db, window).costs).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket_date: "2025-08-01", known_cost_minor: 7, known_cost_entries: 1 }),
      expect.objectContaining({ bucket_date: "2025-08-02", known_cost_minor: 9, known_cost_entries: 1 }),
      expect.objectContaining({ bucket_date: "2025-09-02", known_cost_minor: 11, known_cost_entries: 1 }),
    ]));
  });
});

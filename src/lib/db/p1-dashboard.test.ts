import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult } from "./p1-metrics-facts.js";
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
    expect(dashboard.costs).toEqual([{ bucket_date: "2026-08-01", pipeline_version: "pipeline-v1", stage: "processed", provider: "anthropic", model: "claude", currency: "USD", known_cost_minor: 9, known_cost_entries: 1, unknown_cost_entries: 1 }]);
    expect(dashboard.funnel_loss_reasons).toEqual([{ reason_code: "quote_not_in_source", traces: 1 }]);
    expect(dashboard.validator_reasons).toEqual([{ validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", results: 1, traces: 1 }]);
    expect(dashboard.latency).toEqual(expect.arrayContaining([expect.objectContaining({ transition: "received → accepted", samples: 1, p50_ms: 1000 })]));
    expect(dashboard.latency_diagnostics).toEqual(expect.objectContaining({ completed_traces: 1, in_progress_traces: 1, negative_clock_samples: 0 }));
    expect(readIntegrityDashboardStatus(db, dashboard.window)).toEqual({ latest_daily_root: null, recent_events: [] });
  });

  it("rejects windows beyond the 400-day aggregate cap and proves indexed access", () => {
    const db = dbWithP1();
    expect(() => readP1DashboardMetrics(db, { from: "2026-01-01T00:00:00.000Z", to: "2027-03-01T00:00:00.000Z" })).toThrow("dashboard_window_invalid");
    expect(P1_METRICS_CAPACITY_FIXTURE.version).toBe("p1-metrics-capacity-v1");
    const plans = explainP1DashboardQueries(db, P1_METRICS_CAPACITY_FIXTURE.window);
    expect(plans[0]).toContain("idx_funnel_event_tenant_occurred");
    expect(plans[1]).toContain("idx_cost_ledger_tenant_occurred_provider_model");
    expect(plans[2]).toContain("idx_validator_result_tenant_occurred");
    expect(plans[3]).toContain("idx_funnel_event_tenant_occurred");
    expect(plans[4]).toContain("sqlite_autoindex_integrity_daily_root");
    expect(plans[5]).toContain("idx_integrity_audit_pending");
  });

  it("serves a 400-day aggregate exclusively from the indexed daily rollup", () => {
    const db = dbWithP1();
    appendFunnelEvent(db, { event_id: "long-received", trace_id: "long-trace", stage: "received", pipeline_version: "pipeline-v1", occurred_at: "2026-08-01T01:00:00.000Z", ingested_at: "2026-08-01T01:00:00.000Z" });
    const window = { from: "2026-01-01T00:00:00.000Z", to: "2027-02-05T00:00:00.000Z" };

    expect(readP1DashboardMetrics(db, window).funnel).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "received", received_traces: 1 })]));
    expect(readP1DashboardMetrics(db, window).latency).toEqual([]);
    expect(readIntegrityDashboardStatus(db, window).recent_events).toEqual([]);

    const plans = explainP1DashboardQueries(db, window);
    expect(plans).toHaveLength(4);
    expect(plans.slice(0, 3).every((plan) => plan.includes("idx_metric_rollup_tenant_grain_bucket"))).toBe(true);
  });
});

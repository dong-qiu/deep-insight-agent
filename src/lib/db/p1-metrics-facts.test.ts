import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, listFunnelDetails, purgeExpiredMetricFacts, queryMetricRollups } from "./p1-metrics-facts.js";

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
});

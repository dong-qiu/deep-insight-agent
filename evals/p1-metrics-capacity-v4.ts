/** Reproducible capacity evidence for the actual P1 dashboard SQL. */
import { createHash } from "node:crypto";
import { openDb } from "../src/lib/db/index.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, explainMetricDetailsPageQuery, listMetricDetailsPage } from "../src/lib/db/p1-metrics-facts.js";
import { P1_METRICS_CAPACITY_FIXTURE as fixture } from "../src/lib/db/p1-metrics-capacity-fixture.js";
import { explainP1DashboardQueries, readP1DashboardMetrics } from "../src/lib/db/p1-dashboard.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { deterministicUuidV5 } from "../src/lib/db/uuid.js";

const DAY = 86_400_000;
const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1] ?? 0;
const now = () => Number(process.hrtime.bigint()) / 1_000_000;
const at = (day: number, seconds: number) => new Date(Date.parse(fixture.aggregate_window.from) + day * DAY + seconds * 1000).toISOString();

function seed() {
  const db = openDb(":memory:"); applyProvenanceMigrations(db);
  for (let day = 0; day < fixture.days; day += 1) {
    const topic = fixture.dimensions.topics[day % fixture.dimensions.topics.length];
    const source = fixture.dimensions.sources[day % fixture.dimensions.sources.length];
    const pipeline = fixture.dimensions.pipelines[day % fixture.dimensions.pipelines.length];
    const [provider, model] = fixture.dimensions.providers[day % fixture.dimensions.providers.length].split("/") as [string, string];
    const trace = `capacity-trace-${day}`; const base = at(day, 3600);
    appendFunnelEvent(db, { event_id: deterministicUuidV5(`p1-capacity:received:${day}`), trace_id: trace, stage: "received", topic_id: topic, source_id: source, pipeline_version: pipeline, occurred_at: base, ingested_at: base });
    appendFunnelEvent(db, { event_id: deterministicUuidV5(`p1-capacity:accepted:${day}`), trace_id: trace, stage: "accepted", topic_id: topic, source_id: source, pipeline_version: pipeline, occurred_at: at(day, 3601), ingested_at: at(day, 3601) });
    appendFunnelEvent(db, { event_id: deterministicUuidV5(`p1-capacity:failed:${day}`), trace_id: trace, stage: "failed", topic_id: topic, source_id: source, pipeline_version: pipeline, reason_code: "quote_not_in_source", occurred_at: at(day, 3602), ingested_at: at(day, 3602) });
    appendCostLedger(db, { entry_id: `capacity-cost-${day}`, trace_id: trace, stage: "processed", attempt: 1, topic_id: topic, source_id: source, pipeline_version: pipeline, provider, model, currency: "USD", amount_minor: day % 3 ? day + 1 : null, cost_status: day % 3 ? "known" : "unknown", occurred_at: at(day, 3603), ingested_at: at(day, 3603) });
    appendValidatorResult(db, { result_id: `capacity-validator-${day}`, trace_id: trace, stage: "validated", attempt: 1, topic_id: topic, source_id: source, pipeline_version: pipeline, validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: at(day, 3604), ingested_at: at(day, 3604) });
  }
  return db;
}

const db = seed();
const detailInput = { ...fixture.detail_window, as_of: "2026-08-02T23:59:59.999Z", limit: 100 } as const;
const queries = {
  detail_funnel_31d: () => listMetricDetailsPage(db, { kind: "funnel", ...detailInput }),
  detail_cost_31d: () => listMetricDetailsPage(db, { kind: "cost", ...detailInput }),
  detail_validator_31d: () => listMetricDetailsPage(db, { kind: "validator", ...detailInput }),
  aggregate_31d: () => readP1DashboardMetrics(db, { from: "2026-07-02T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }),
  aggregate_400d: () => readP1DashboardMetrics(db, fixture.aggregate_window),
  aggregate_400d_partial: () => readP1DashboardMetrics(db, fixture.aggregate_partial_window),
};
for (const query of Object.values(queries)) query();
const timings = Object.fromEntries(Object.entries(queries).map(([id, query]) => {
  const samples = Array.from({ length: 30 }, () => { const start = now(); query(); return now() - start; });
  return [id, { samples_ms: samples.map((sample) => Number(sample.toFixed(3))), p95_ms: Number(p95(samples).toFixed(3)), max_ms: Number(Math.max(...samples).toFixed(3)) }];
}));
const plans = {
  detail_funnel_31d: explainMetricDetailsPageQuery(db, { kind: "funnel", ...detailInput }),
  detail_cost_31d: explainMetricDetailsPageQuery(db, { kind: "cost", ...detailInput }),
  detail_validator_31d: explainMetricDetailsPageQuery(db, { kind: "validator", ...detailInput }),
  aggregate_31d: explainP1DashboardQueries(db, { from: "2026-07-02T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }),
  aggregate_400d: explainP1DashboardQueries(db, fixture.aggregate_window),
  aggregate_400d_partial: explainP1DashboardQueries(db, fixture.aggregate_partial_window),
};
const dashboardPlanNames = ["funnel", "first_terminal_stage", "first_terminal_reason", "cost", "validator", "latency_percentiles", "latency_diagnostics", "latency_in_progress", "integrity_daily_root", "integrity_recent_events"];
const requiredDashboardIndexes = [
  ["idx_dashboard_trace_fact_v1_window"], ["idx_dashboard_trace_fact_v1_window"], ["idx_dashboard_trace_fact_v1_window"],
  ["idx_metric_rollup_tenant_grain_bucket", "idx_dashboard_cost_fact_v1_window"], ["idx_dashboard_trace_fact_v1_kind_window"],
  ["idx_dashboard_trace_fact_v1_terminal_window"], ["idx_dashboard_trace_fact_v1_terminal_window"], ["idx_dashboard_trace_fact_v1_terminal_window"],
  ["sqlite_autoindex_integrity_daily_root"], ["idx_integrity_audit_pending"],
];
function assertDashboardPlans(plan: string[]): boolean {
  return plan.every((entry, index) => requiredDashboardIndexes[index]!.some((name) => entry.includes(name)) && !/SCAN (?:dashboard_trace_fact_v1|dashboard_cost_fact_v1|metric_rollup|integrity_daily_root|integrity_audit_event)(?:\s|$)/.test(entry));
}
type DetailPlanName = "detail_funnel_31d" | "detail_cost_31d" | "detail_validator_31d";
const detailPlanIndexes: Record<DetailPlanName, string> = {
  detail_funnel_31d: "idx_funnel_event_tenant_occurred",
  detail_cost_31d: "idx_cost_ledger_tenant_occurred_provider_model",
  detail_validator_31d: "idx_validator_result_tenant_occurred",
};
const detailPlanNames = Object.keys(detailPlanIndexes) as DetailPlanName[];
const detailPlanEvidence = Object.fromEntries(detailPlanNames.map((name) => [name, { query: plans[name].join("\n") }]));
const aggregatePlanEvidence = Object.fromEntries(Object.entries(plans)
  .filter(([name]) => !(name in detailPlanIndexes))
  .map(([name, plan]) => [name, Object.fromEntries(plan.map((detail, index) => [dashboardPlanNames[index]!, detail]))]));
const plan_evidence = { ...detailPlanEvidence, ...aggregatePlanEvidence };
const manifest = { version: fixture.version, generator_version: fixture.generator_version, row_counts: { funnel_event: 1200, cost_ledger: 400, validator_result_fact: 400 }, sqlite_version: String((db.prepare("select sqlite_version() as version").get() as { version: string }).version), node: process.version, dataset_sha256: createHash("sha256").update(JSON.stringify({ fixture, rows: 2000 })).digest("hex") };
const result = { manifest, plans: plan_evidence, timings };
console.log(JSON.stringify(result, null, 2));
const capacityPlansPass = detailPlanNames.every((name) => plans[name].join("\n").includes(detailPlanIndexes[name]))
  && Object.entries(plans).filter(([name]) => !(name in detailPlanIndexes)).every(([, plan]) => assertDashboardPlans(plan));
if (process.argv.includes("--enforce") && (Object.values(timings).some((value) => value.p95_ms > 2000) || !capacityPlansPass)) process.exitCode = 1;

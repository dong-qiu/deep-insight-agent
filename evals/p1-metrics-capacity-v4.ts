/** Reproducible capacity evidence for the actual P1 dashboard SQL. */
import { createHash } from "node:crypto";
import { openDb } from "../src/lib/db/index.js";
import { appendCostLedger, appendFunnelEvent, appendValidatorResult, listMetricDetailsPage } from "../src/lib/db/p1-metrics-facts.js";
import { P1_METRICS_CAPACITY_FIXTURE as fixture } from "../src/lib/db/p1-metrics-capacity-fixture.js";
import { explainP1DashboardQueries, readP1DashboardMetrics } from "../src/lib/db/p1-dashboard.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";

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
    appendFunnelEvent(db, { event_id: `capacity-received-${day}`, trace_id: trace, stage: "received", topic_id: topic, source_id: source, pipeline_version: pipeline, occurred_at: base, ingested_at: base });
    appendFunnelEvent(db, { event_id: `capacity-accepted-${day}`, trace_id: trace, stage: "accepted", topic_id: topic, source_id: source, pipeline_version: pipeline, occurred_at: at(day, 3601), ingested_at: at(day, 3601) });
    appendFunnelEvent(db, { event_id: `capacity-failed-${day}`, trace_id: trace, stage: "failed", topic_id: topic, source_id: source, pipeline_version: pipeline, reason_code: "quote_not_in_source", occurred_at: at(day, 3602), ingested_at: at(day, 3602) });
    appendCostLedger(db, { entry_id: `capacity-cost-${day}`, trace_id: trace, stage: "processed", attempt: 1, topic_id: topic, source_id: source, pipeline_version: pipeline, provider, model, currency: "USD", amount_minor: day % 3 ? day + 1 : null, cost_status: day % 3 ? "known" : "unknown", occurred_at: at(day, 3603), ingested_at: at(day, 3603) });
    appendValidatorResult(db, { result_id: `capacity-validator-${day}`, trace_id: trace, stage: "validated", attempt: 1, topic_id: topic, source_id: source, pipeline_version: pipeline, validator: "citation", rule_version: "v1", reason_code: "quote_not_in_source", severity: "error", terminal: true, occurred_at: at(day, 3604), ingested_at: at(day, 3604) });
  }
  return db;
}

const db = seed();
const queries = {
  detail_31d: () => listMetricDetailsPage(db, { kind: "funnel", ...fixture.detail_window, as_of: "2026-08-02T23:59:59.999Z", limit: 100 }),
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
  detail_31d: (db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM funnel_event WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at DESC,event_id DESC LIMIT 100").all("default", fixture.detail_window.from, fixture.detail_window.to) as Array<{ detail: string }>).map(({ detail }) => detail),
  aggregate_31d: explainP1DashboardQueries(db, { from: "2026-07-02T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" }),
  aggregate_400d: explainP1DashboardQueries(db, fixture.aggregate_window),
  aggregate_400d_partial: explainP1DashboardQueries(db, fixture.aggregate_partial_window),
};
const manifest = { version: fixture.version, generator_version: fixture.generator_version, row_counts: { funnel_event: 1200, cost_ledger: 400, validator_result_fact: 400 }, sqlite_version: String((db.prepare("select sqlite_version() as version").get() as { version: string }).version), node: process.version, dataset_sha256: createHash("sha256").update(JSON.stringify({ fixture, rows: 2000 })).digest("hex") };
const result = { manifest, plans, timings };
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--enforce") && (Object.values(timings).some((value) => value.p95_ms > 2000) || Object.values(plans).some((plan) => !plan.join("\n").includes("INDEX")))) process.exitCode = 1;

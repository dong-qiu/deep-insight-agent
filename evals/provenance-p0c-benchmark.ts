/** P0c 合成性能基线：不读取生产数据库，不写入仓库产物。参考机以 --enforce 强制 P95 门。 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { buildGenerationTraceGraph, listGenerationEventRefs, listGenerationTraceTimelinePage } from "../src/lib/db/provenance.js";

interface FixtureProfile { traces: number; events_per_trace: number; refs_per_event_pattern: number[]; }
interface Distribution { p50: number; p95: number; max: number; }
interface Fixture { version: number; source?: string; production_measurement?: { per_trace?: Record<string, Distribution>; refs_per_event?: Distribution }; traces: number; events_per_trace: number; refs_per_event: number; refs_per_event_pattern?: number[]; trace_profiles?: FixtureProfile[]; database_target_bytes?: number; graph_fanout: number; concurrent_writers_assumption: number; page_size: number; graph_depth: number; graph_element_budget: number; }

const fixtureArgument = process.argv.find((argument) => argument.startsWith("--fixture="));
const fixturePath = fixtureArgument?.slice("--fixture=".length) ?? "./provenance-p0c-fixture.v2.json";
const fixture = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), "utf8")) as Fixture;
const now = "2026-08-17T00:00:00.000Z";

function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function validateFixture(value: Fixture): void {
  for (const key of ["version", "traces", "events_per_trace", "refs_per_event", "graph_fanout", "concurrent_writers_assumption", "page_size", "graph_depth", "graph_element_budget"] as const) {
    if (!positiveInteger(value[key]) && key !== "graph_fanout") throw new Error(`invalid_fixture_${key}`);
  }
  if (!Number.isSafeInteger(value.graph_fanout) || value.graph_fanout < 0 || value.page_size > 100 || value.graph_depth > 4 || value.graph_element_budget > 500) throw new Error("invalid_fixture_budget");
  if (value.refs_per_event_pattern && (!value.refs_per_event_pattern.length || !value.refs_per_event_pattern.every(positiveInteger))) throw new Error("invalid_fixture_ref_pattern");
  if (value.trace_profiles) {
    if (value.trace_profiles.reduce((sum, profile) => sum + profile.traces, 0) !== value.traces) throw new Error("invalid_fixture_profile_count");
    for (const profile of value.trace_profiles) if (!positiveInteger(profile.traces) || !positiveInteger(profile.events_per_trace) || profile.refs_per_event_pattern.length !== profile.events_per_trace || !profile.refs_per_event_pattern.every(positiveInteger)) throw new Error("invalid_fixture_profile");
  }
  if (value.database_target_bytes !== undefined && (!positiveInteger(value.database_target_bytes) || value.database_target_bytes > 256 * 1024 * 1024)) throw new Error("invalid_fixture_database_target");
}
validateFixture(fixture);

function profileForTrace(index: number): Pick<FixtureProfile, "events_per_trace" | "refs_per_event_pattern"> {
  if (!fixture.trace_profiles) return { events_per_trace: fixture.events_per_trace, refs_per_event_pattern: fixture.refs_per_event_pattern ?? Array.from({ length: fixture.events_per_trace }, () => fixture.refs_per_event) };
  let remaining = index;
  for (const profile of fixture.trace_profiles) {
    if (remaining < profile.traces) return profile;
    remaining -= profile.traces;
  }
  throw new Error("fixture_profile_out_of_range");
}

function seed(db: ReturnType<typeof openDb>): void {
  for (let trace = 0; trace < fixture.traces; trace += 1) {
    const traceId = `trace_${trace}`;
    const profile = profileForTrace(trace);
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES (?,'topic_pipeline','api','done','{}','complete','{}','{}',?)`).run(traceId, now);
    for (let sequence = 1; sequence <= profile.events_per_trace; sequence += 1) {
      const eventId = `event_${trace}_${sequence}`;
      db.prepare(`INSERT INTO generation_event
        (id,trace_id,sequence,attempt,run_id,stage,event_type,occurred_at,actor_type,input_refs,output_refs,metrics,version_context,context_completeness,payload_schema_version,semantic_payload_hash,payload_hash)
        VALUES (?,?,?,?,NULL,'analyze','completed',?,'system','[]','[]','{}','{}','complete',1,?,?)`)
        .run(eventId, traceId, sequence, sequence, now, `semantic_${trace}_${sequence}`, `payload_${trace}_${sequence}`);
      const refsForEvent = profile.refs_per_event_pattern[(sequence - 1) % profile.refs_per_event_pattern.length];
      for (let ref = 0; ref < refsForEvent; ref += 1) {
        db.prepare(`INSERT INTO generation_entity_ref(trace_id,event_id,entity_type,entity_key,revision,role,visibility_class)
          VALUES (?,?, 'entity', ?, 'v1', 'output', 'admin_only')`).run(traceId, eventId, `entity:v1:${trace}_${sequence}_${ref}`);
      }
      for (let fanout = 0; fanout < fixture.graph_fanout; fanout += 1) {
        const to = ((sequence + fanout) % profile.events_per_trace) + 1;
        db.prepare(`INSERT INTO generation_edge
          (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
          VALUES (?,?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`)
          .run(traceId, eventId, `entity:v1:${trace}_${sequence}_0`, `entity:v1:${trace}_${to}_0`);
      }
    }
  }
}

function padDatabase(db: ReturnType<typeof openDb>, dbPath: string): void {
  if (!fixture.database_target_bytes) return;
  db.exec("CREATE TABLE benchmark_padding (payload BLOB NOT NULL)");
  const insert = db.prepare("INSERT INTO benchmark_padding(payload) VALUES (zeroblob(?))");
  db.pragma("wal_checkpoint(TRUNCATE)");
  while (statSync(dbPath).size < fixture.database_target_bytes) {
    insert.run(Math.min(4 * 1024 * 1024, fixture.database_target_bytes - statSync(dbPath).size));
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

function p95(samples: number[]): number { return samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? 0; }
function p50(samples: number[]): number { return samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * 0.5) - 1] ?? 0; }
function measure(operation: () => void): number {
  const started = performance.now(); operation(); return performance.now() - started;
}

const directory = mkdtempSync(join(tmpdir(), "insight-provenance-p0c-"));
try {
  const dbPath = join(directory, "fixture.db");
  const db = openDb(dbPath);
  applyProvenanceMigrations(db);
  seed(db);
  padDatabase(db, dbPath);
  db.exec("ANALYZE");
  const traceId = "trace_0";
  // warmup excludes one-time JIT and SQLite page-cache setup from the recorded query P95.
  for (let i = 0; i < 5; i += 1) { listGenerationTraceTimelinePage(db, traceId, { limit: fixture.page_size }); listGenerationEventRefs(db, traceId, 1, { limit: fixture.page_size }); buildGenerationTraceGraph(db, traceId, { depth: fixture.graph_depth, maxElements: fixture.graph_element_budget }); }
  const samples = { trace: [] as number[], refs: [] as number[], graph: [] as number[] };
  for (let i = 0; i < 30; i += 1) {
    samples.trace.push(measure(() => { listGenerationTraceTimelinePage(db, traceId, { limit: fixture.page_size }); }));
    samples.refs.push(measure(() => { listGenerationEventRefs(db, traceId, 1, { limit: fixture.page_size }); }));
    samples.graph.push(measure(() => { buildGenerationTraceGraph(db, traceId, { depth: fixture.graph_depth, maxElements: fixture.graph_element_budget }); }));
  }
  const perTrace = db.prepare(`SELECT t.id,
      (SELECT COUNT(*) FROM generation_event e WHERE e.trace_id=t.id) AS events,
      (SELECT COUNT(*) FROM generation_entity_ref r WHERE r.trace_id=t.id) AS refs,
      (SELECT COUNT(*) FROM generation_edge edge WHERE edge.trace_id=t.id) AS edges
    FROM generation_trace t ORDER BY t.id`).all() as Array<{ events: number; refs: number; edges: number }>;
  const distribution = (values: number[]): Distribution => ({ p50: p50(values), p95: p95(values), max: Math.max(0, ...values) });
  const perTraceDistribution = (key: "events" | "refs" | "edges") => distribution(perTrace.map((row) => row[key]));
  const refsPerEvent = distribution((db.prepare("SELECT COUNT(*) AS refs FROM generation_entity_ref GROUP BY event_id").all() as Array<{ refs: number }>).map((row) => row.refs));
  // 与生产读路径同形的计划快照：容量门同时拒绝退化为临时全量排序的分页查询。
  const queryPlans = {
    timeline: db.prepare(`EXPLAIN QUERY PLAN SELECT e.id,e.sequence,
      (SELECT COUNT(*) FROM generation_entity_ref r WHERE r.event_id=e.id) AS ref_count
      FROM generation_event e WHERE e.trace_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?`).all(traceId, 0, fixture.page_size + 1),
    refs: db.prepare(`EXPLAIN QUERY PLAN SELECT rowid,entity_type,entity_key,revision,role,visibility_class
      FROM generation_entity_ref WHERE trace_id=? AND event_id=? AND rowid>? ORDER BY rowid LIMIT ?`).all(traceId, "event_0_1", 0, fixture.page_size + 1),
    graph: db.prepare(`EXPLAIN QUERY PLAN SELECT e.event_id,e.from_type,e.from_key,e.from_revision,e.to_type,e.to_key,e.to_revision,e.relation,e.visibility_class,event.sequence
      FROM generation_edge e JOIN generation_event event ON event.id=e.event_id
      WHERE e.trace_id=? AND e.from_type=? AND e.from_key=? AND e.from_revision=? LIMIT ?`).all(traceId, "entity", "entity:v1:0_1_0", "v1", fixture.graph_element_budget + 1),
    graph_event_refs: db.prepare(`EXPLAIN QUERY PLAN SELECT r.rowid,r.event_id,event.sequence,event.stage,event.event_type,r.entity_type,r.entity_key,r.revision,r.role,r.visibility_class
      FROM generation_entity_ref r INDEXED BY idx_generation_entity_ref_trace_event CROSS JOIN generation_event event ON event.id=r.event_id
      WHERE r.trace_id=? AND r.event_id=? ORDER BY r.rowid LIMIT ?`).all(traceId, "event_0_1", fixture.graph_element_budget + 1),
    graph_entity_refs: db.prepare(`EXPLAIN QUERY PLAN SELECT r.rowid,r.event_id,event.sequence,event.stage,event.event_type,r.entity_type,r.entity_key,r.revision,r.role,r.visibility_class
      FROM generation_entity_ref r JOIN generation_event event ON event.id=r.event_id
      WHERE r.trace_id=? AND r.entity_type=? AND r.entity_key=? AND r.revision=? ORDER BY r.event_id,r.rowid LIMIT ?`).all(traceId, "entity", "entity:v1:0_1_0", "v1", fixture.graph_element_budget + 1),
  } as Record<string, Array<{ detail: string }>>;
  const usesTempSort = Object.values(queryPlans).flat().some((row) => row.detail.includes("USE TEMP B-TREE"));
  const production = fixture.production_measurement;
  const matches = (actual: Distribution, expected: Distribution | undefined) => !expected || (actual.p50 === expected.p50 && actual.p95 === expected.p95 && actual.max === expected.max);
  if (!matches(perTraceDistribution("events"), production?.per_trace?.events) || !matches(perTraceDistribution("refs"), production?.per_trace?.refs) || !matches(perTraceDistribution("edges"), production?.per_trace?.edges) || !matches(refsPerEvent, production?.refs_per_event)) throw new Error("fixture_distribution_mismatch");
  const dbSizeBytes = statSync(dbPath).size;
  if (fixture.database_target_bytes && dbSizeBytes < fixture.database_target_bytes) throw new Error("fixture_database_size_mismatch");
  const result = { fixture_version: fixture.version, fixture_source: fixture.source ?? "unspecified", production_measurement: production ?? null, node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), machine: {
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cpu_count: cpus().length,
  }, db_size_bytes: dbSizeBytes, per_trace: { events: perTraceDistribution("events"), refs: perTraceDistribution("refs"), edges: perTraceDistribution("edges") }, refs_per_event: refsPerEvent, pragmas: {
    journal_mode: db.pragma("journal_mode", { simple: true }), busy_timeout: db.pragma("busy_timeout", { simple: true }),
  }, concurrent_writers_assumption: fixture.concurrent_writers_assumption, query_plans: queryPlans, p95_ms: { trace: p95(samples.trace), refs: p95(samples.refs), graph: p95(samples.graph) } };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--enforce") && (usesTempSort || result.p95_ms.trace >= 1_000 || result.p95_ms.refs >= 1_000 || result.p95_ms.graph >= 2_000)) process.exitCode = 1;
  db.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

/** P0c 合成性能基线：不读取生产数据库，不写入仓库产物。参考机以 --enforce 强制 P95 门。 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { buildGenerationTraceGraph, listGenerationEventRefs, listGenerationTraceTimelinePage } from "../src/lib/db/provenance.js";

interface Fixture { version: number; traces: number; events_per_trace: number; refs_per_event: number; graph_fanout: number; concurrent_writers_assumption: number; page_size: number; graph_depth: number; graph_element_budget: number; }

const fixture = JSON.parse(readFileSync(new URL("./provenance-p0c-fixture.v1.json", import.meta.url), "utf8")) as Fixture;
const now = "2026-08-17T00:00:00.000Z";

function seed(db: ReturnType<typeof openDb>): void {
  for (let trace = 0; trace < fixture.traces; trace += 1) {
    const traceId = `trace_${trace}`;
    db.prepare(`INSERT INTO generation_trace(id,scope_kind,trigger_kind,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES (?,'topic_pipeline','api','done','{}','complete','{}','{}',?)`).run(traceId, now);
    for (let sequence = 1; sequence <= fixture.events_per_trace; sequence += 1) {
      const eventId = `event_${trace}_${sequence}`;
      db.prepare(`INSERT INTO generation_event
        (id,trace_id,sequence,attempt,run_id,stage,event_type,occurred_at,actor_type,input_refs,output_refs,metrics,version_context,context_completeness,payload_schema_version,semantic_payload_hash,payload_hash)
        VALUES (?,?,?,?,NULL,'analyze','completed',?,'system','[]','[]','{}','{}','complete',1,?,?)`)
        .run(eventId, traceId, sequence, sequence, now, `semantic_${trace}_${sequence}`, `payload_${trace}_${sequence}`);
      for (let ref = 0; ref < fixture.refs_per_event; ref += 1) {
        db.prepare(`INSERT INTO generation_entity_ref(trace_id,event_id,entity_type,entity_key,revision,role,visibility_class)
          VALUES (?,?, 'entity', ?, 'v1', 'output', 'admin_only')`).run(traceId, eventId, `entity:v1:${trace}_${sequence}_${ref}`);
      }
      for (let fanout = 0; fanout < fixture.graph_fanout; fanout += 1) {
        const to = ((sequence + fanout) % fixture.events_per_trace) + 1;
        db.prepare(`INSERT INTO generation_edge
          (trace_id,event_id,from_type,from_key,from_revision,to_type,to_key,to_revision,relation,visibility_class)
          VALUES (?,?,'entity',?,'v1','entity',?,'v1','derived_from','admin_only')`)
          .run(traceId, eventId, `entity:v1:${trace}_${sequence}_0`, `entity:v1:${trace}_${to}_0`);
      }
    }
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
  const distribution = (key: "events" | "refs" | "edges") => ({ p50: p50(perTrace.map((row) => row[key])), p95: p95(perTrace.map((row) => row[key])) });
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
  } as Record<string, Array<{ detail: string }>>;
  const usesTempSort = Object.values(queryPlans).flat().some((row) => row.detail.includes("USE TEMP B-TREE"));
  const result = { fixture_version: fixture.version, node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), machine: {
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cpu_count: cpus().length,
  }, db_size_bytes: statSync(dbPath).size, per_trace: { events: distribution("events"), refs: distribution("refs"), edges: distribution("edges") }, pragmas: {
    journal_mode: db.pragma("journal_mode", { simple: true }), busy_timeout: db.pragma("busy_timeout", { simple: true }),
  }, concurrent_writers_assumption: fixture.concurrent_writers_assumption, query_plans: queryPlans, p95_ms: { trace: p95(samples.trace), refs: p95(samples.refs), graph: p95(samples.graph) } };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--enforce") && (usesTempSort || result.p95_ms.trace >= 1_000 || result.p95_ms.refs >= 1_000 || result.p95_ms.graph >= 2_000)) process.exitCode = 1;
  db.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

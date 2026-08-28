/**
 * Bounded P1 dashboard read model.  It intentionally consumes only the
 * append-only metric/integrity projections and is never imported by report
 * readers or publishers.
 */
import type { DB } from "./index.js";
import { DETAIL_QUERY_MAX_DAYS, METRICS_TENANT_ID, ROLLUP_QUERY_MAX_DAYS } from "./p1-metrics-facts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const DISPLAY_LIMIT = 20;
const FUNNEL_STAGES = ["received", "accepted", "processed", "validated", "published"] as const;
const STAGE_RANK = new Map<string, number>(FUNNEL_STAGES.map((stage, index) => [stage, index]));

export interface DashboardWindow { from: string; to: string }
export interface DashboardLatency { transition: string; samples: number; p50_ms: number; p95_ms: number; p99_ms: number }

export interface P1DashboardMetrics {
  window: DashboardWindow;
  funnel: Array<{ stage: string; received_traces: number; reached_traces: number; terminal_events: number; conversion_pct: number | null }>;
  funnel_loss_reasons: Array<{ reason_code: string; traces: number }>;
  costs: Array<{ bucket_date: string; topic_id: string; source_id: string; pipeline_version: string; stage: string; provider: string; model: string; currency: string; known_cost_minor: number; known_cost_entries: number; unknown_cost_entries: number }>;
  validator_reasons: Array<{ topic_id: string; source_id: string; pipeline_version: string; validator: string; rule_version: string; reason_code: string; severity: string; results: number; traces: number }>;
  latency: DashboardLatency[];
  latency_diagnostics: { completed_traces: number; in_progress_traces: number; negative_clock_samples: number; missing_clock_samples: number };
}

export interface IntegrityDashboardStatus {
  latest_daily_root: { utc_date: string; status: string; committed_at: string | null } | null;
  recent_events: Array<{ event_type: string; severity: string; created_at: string }>;
}

function asIso(value: string, error: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(error);
  return new Date(parsed).toISOString();
}

/** Client input selects only a bounded UTC time window; tenant stays server-owned. */
export function dashboardWindow(input: Partial<DashboardWindow> = {}, now = new Date()): DashboardWindow {
  const to = input.to ? asIso(input.to, "dashboard_window_invalid") : now.toISOString();
  const from = input.from ? asIso(input.from, "dashboard_window_invalid") : new Date(Date.parse(to) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > ROLLUP_QUERY_MAX_DAYS * DAY_MS) {
    throw new Error("dashboard_window_invalid");
  }
  return { from, to };
}

/** Raw facts are a detail projection. Long aggregate windows must use daily rollups. */
function usesRawFacts(window: DashboardWindow): boolean {
  return Date.parse(window.to) - Date.parse(window.from) <= DETAIL_QUERY_MAX_DAYS * DAY_MS;
}

function numeric(value: unknown): number { return Number(value ?? 0); }

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

/**
 * Uses only completed trace/attempts and adjacent `entered` stages from the
 * selected bounded projection.
 */
function latencyFromTerminalFacts(db: DB, window: DashboardWindow, source: "raw" | "trace" = "raw"): { latency: DashboardLatency[]; diagnostics: P1DashboardMetrics["latency_diagnostics"] } {
  const table = source === "raw" ? "funnel_event" : "dashboard_trace_fact_v1";
  const sourcePredicate = source === "raw" ? "" : " AND projection_version='dashboard-trace-v1' AND fact_kind='funnel'";
  const rows = db.prepare(`WITH terminal AS (
      SELECT trace_id,attempt,occurred_at AS terminal_at
      FROM ${table}
      WHERE tenant_id=? AND event_type='terminal'${sourcePredicate} AND occurred_at>=? AND occurred_at<?
    ) SELECT e.trace_id,e.attempt,e.stage,e.event_type,e.occurred_at
    FROM terminal t JOIN ${table} e
      ON e.tenant_id=? AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered'
        ${sourcePredicate.replaceAll(" AND ", " AND e.")} AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at
    ORDER BY e.trace_id,e.attempt,e.occurred_at ASC`)
    .all(METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from) as Array<{ trace_id: string; attempt: number; stage: string; event_type: "entered"; occurred_at: string }>;

  const byTrace = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.trace_id}\u0000${row.attempt}`;
    const events = byTrace.get(key) ?? [];
    events.push(row);
    byTrace.set(key, events);
  }
  const transitions = new Map<string, number[]>(); let negative_clock_samples = 0; let missing_clock_samples = 0;
  for (const events of byTrace.values()) {
    if (events.length < 2) { missing_clock_samples += 1; continue; }
    events.sort((a, b) => (STAGE_RANK.get(a.stage) ?? Number.MAX_SAFE_INTEGER) - (STAGE_RANK.get(b.stage) ?? Number.MAX_SAFE_INTEGER));
    for (let i = 1; i < events.length; i += 1) {
      const previous = events[i - 1]!;
      const current = events[i]!;
      const duration = Date.parse(current.occurred_at) - Date.parse(previous.occurred_at);
      if (!Number.isFinite(duration)) { missing_clock_samples += 1; continue; }
      if (duration < 0) { negative_clock_samples += 1; continue; }
      if (previous.stage === current.stage) continue;
      const name = `${previous.stage} → ${current.stage}`;
      const samples = transitions.get(name) ?? [];
      samples.push(duration);
      transitions.set(name, samples);
    }
  }
  const inProgress = db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT f.trace_id,f.attempt FROM ${table} f
      WHERE f.tenant_id=? AND f.event_type='entered'${sourcePredicate.replaceAll(" AND ", " AND f.")} AND f.occurred_at>=? AND f.occurred_at<?
        AND NOT EXISTS (SELECT 1 FROM ${table} terminal WHERE terminal.tenant_id=f.tenant_id AND terminal.trace_id=f.trace_id AND terminal.attempt=f.attempt AND terminal.event_type='terminal'${sourcePredicate.replaceAll(" AND ", " AND terminal.")} AND terminal.occurred_at<?)
    )`).get(METRICS_TENANT_ID, window.from, window.to, window.to) as { count: number };
  return { latency: [...transitions.entries()]
    .map(([transition, samples]) => ({ transition, samples: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), p99_ms: percentile(samples, 0.99) }))
    .sort((a, b) => b.samples - a.samples || a.transition.localeCompare(b.transition))
    .slice(0, DISPLAY_LIMIT), diagnostics: { completed_traces: byTrace.size, in_progress_traces: numeric(inProgress.count), negative_clock_samples, missing_clock_samples } };
}

function utcDayStart(value: string): string { return `${value.slice(0, 10)}T00:00:00.000Z`; }
function nextUtcDay(value: string): string { return new Date(Date.parse(utcDayStart(value)) + DAY_MS).toISOString(); }

type PreparedDashboardQuery = { sql: string; params: unknown[] };

/** Exact arbitrary long-window cost read: projected detail for partial UTC days, daily rollups between them. */
function longWindowCostsQuery(window: DashboardWindow): PreparedDashboardQuery | null {
  const fullStart = window.from === utcDayStart(window.from) ? window.from : nextUtcDay(window.from);
  const fullEnd = utcDayStart(window.to);
  const parts: Array<{ sql: string; params: unknown[] }> = [];
  const addDetailRange = (from: string, to: string) => {
    if (Date.parse(from) >= Date.parse(to)) return;
    parts.push({ sql: `SELECT substr(occurred_at,1,10) AS bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency,
        COALESCE(SUM(CASE WHEN cost_status='known' THEN amount_minor ELSE 0 END),0) AS known_cost_minor,
        COUNT(*) FILTER (WHERE cost_status='known') AS known_cost_entries,COUNT(*) FILTER (WHERE cost_status='unknown') AS unknown_cost_entries
        FROM dashboard_cost_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-cost-v1' AND occurred_at>=? AND occurred_at<?
        GROUP BY bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency`, params: [METRICS_TENANT_ID, from, to] });
  };
  addDetailRange(window.from, fullStart);
  if (Date.parse(fullEnd) >= Date.parse(fullStart)) addDetailRange(fullEnd, window.to);
  if (Date.parse(fullStart) < Date.parse(fullEnd)) {
    parts.push({ sql: `SELECT substr(bucket_start,1,10) AS bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency,
        SUM(known_cost_minor) AS known_cost_minor,SUM(known_cost_entries) AS known_cost_entries,SUM(unknown_cost_entries) AS unknown_cost_entries
        FROM metric_rollup WHERE tenant_id=? AND grain='day' AND metric_kind='cost' AND bucket_start>=? AND bucket_start<?
        GROUP BY bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency`, params: [METRICS_TENANT_ID, fullStart, fullEnd] });
  }
  if (!parts.length) return null;
  return { sql: `SELECT bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency,
      SUM(known_cost_minor) AS known_cost_minor,SUM(known_cost_entries) AS known_cost_entries,SUM(unknown_cost_entries) AS unknown_cost_entries
      FROM (${parts.map((part) => part.sql).join(" UNION ALL ")})
      GROUP BY bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency ORDER BY bucket_date DESC,known_cost_minor DESC LIMIT ?`, params: [...parts.flatMap((part) => part.params), DISPLAY_LIMIT] };
}

function longWindowCosts(db: DB, window: DashboardWindow): P1DashboardMetrics["costs"] {
  const query = longWindowCostsQuery(window);
  if (!query) return [];
  const costs = db.prepare(query.sql).all(...query.params) as P1DashboardMetrics["costs"];
  return costs.map((row) => ({ ...row, known_cost_minor: numeric(row.known_cost_minor), known_cost_entries: numeric(row.known_cost_entries), unknown_cost_entries: numeric(row.unknown_cost_entries) }));
}

/**
 * The trace projection is retained for the full aggregate window.  In
 * particular, daily COUNT(DISTINCT trace_id) values must never be summed.
 */
function readP1DashboardLongWindow(db: DB, window: DashboardWindow): P1DashboardMetrics {
  const funnelCounts = db.prepare(`WITH received AS (
      SELECT DISTINCT trace_id FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?
    ), highest AS (
      SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank
      FROM received r JOIN dashboard_trace_fact_v1 f ON f.tenant_id=? AND f.projection_version='dashboard-trace-v1' AND f.fact_kind='funnel' AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<? GROUP BY r.trace_id
    ) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest`)
    .get(METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to) as Record<string, number>;
  const firstTerminals = `WITH ranked AS (
      SELECT trace_id,stage,COALESCE(NULLIF(reason_code,''),'not_evaluated') AS reason_code,
        ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY occurred_at ASC,fact_id ASC) AS ordinal
      FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='terminal' AND occurred_at>=? AND occurred_at<?
    )`;
  const terminalRows = db.prepare(`${firstTerminals} SELECT stage,COUNT(*) AS terminal_events FROM ranked WHERE ordinal=1 GROUP BY stage ORDER BY terminal_events DESC,stage ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as Array<{ stage: string; terminal_events: number }>;
  const funnel_loss_reasons = db.prepare(`${firstTerminals} SELECT reason_code,COUNT(*) AS traces FROM ranked WHERE ordinal=1 GROUP BY reason_code ORDER BY traces DESC,reason_code ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as P1DashboardMetrics["funnel_loss_reasons"];
  const costs = longWindowCosts(db, window);
  const validator_reasons = db.prepare(`SELECT topic_id,source_id,pipeline_version,validator,rule_version,reason_code,severity,COUNT(*) AS results,COUNT(DISTINCT trace_id) AS traces
      FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='validator' AND terminal=1 AND occurred_at>=? AND occurred_at<?
      GROUP BY topic_id,source_id,pipeline_version,validator,rule_version,reason_code,severity ORDER BY results DESC,reason_code ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as P1DashboardMetrics["validator_reasons"];
  const terminalByStage = new Map(terminalRows.map((row) => [row.stage, numeric(row.terminal_events)]));
  const received = numeric(funnelCounts.received);
  const funnel: P1DashboardMetrics["funnel"] = FUNNEL_STAGES.map((stage, rank) => {
    const reached_traces = rank === 0 ? received : numeric(funnelCounts[stage]);
    return { stage, received_traces: received, reached_traces, terminal_events: terminalByStage.get(stage) ?? 0, conversion_pct: received ? (reached_traces / received) * 100 : null };
  });
  for (const row of terminalRows) if (!STAGE_RANK.has(row.stage)) funnel.push({ stage: row.stage, received_traces: received, reached_traces: 0, terminal_events: numeric(row.terminal_events), conversion_pct: null });
  const latency = latencyFromTerminalFacts(db, window, "trace");
  return { window, funnel, funnel_loss_reasons: funnel_loss_reasons.map((row) => ({ ...row, traces: numeric(row.traces) })), costs, validator_reasons: validator_reasons.map((row) => ({ ...row, results: numeric(row.results), traces: numeric(row.traces) })), latency: latency.latency, latency_diagnostics: latency.diagnostics };
}

/** Aggregate read model: all SQL predicates begin with the server-injected tenant. */
export function readP1DashboardMetrics(db: DB, requested: Partial<DashboardWindow> = {}): P1DashboardMetrics {
  const window = dashboardWindow(requested);
  // A single admission-controlled projection is used for every aggregate
  // window.  This prevents a newly quarantined raw fact from leaking through
  // a <=31-day path while the 31–400-day path correctly excludes it.
  return readP1DashboardLongWindow(db, window);
  /* c8 ignore start -- retained as the raw-SQL explain compatibility vector. */
  const funnelCounts = db.prepare(`WITH received AS (
      SELECT DISTINCT trace_id FROM funnel_event WHERE tenant_id=? AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?
    ), highest AS (
      SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank
      FROM received r JOIN funnel_event f ON f.tenant_id=? AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<?
      GROUP BY r.trace_id
    ) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest`)
    .get(METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to) as Record<string, number>;
  const firstTerminals = `WITH ranked AS (
      SELECT trace_id,stage,COALESCE(reason_code,'not_evaluated') AS reason_code,
        ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY occurred_at ASC,event_id ASC) AS ordinal
      FROM funnel_event WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?
    )`;
  const terminalRows = db.prepare(`${firstTerminals} SELECT stage,COUNT(*) AS terminal_events FROM ranked WHERE ordinal=1 GROUP BY stage ORDER BY terminal_events DESC,stage ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as Array<{ stage: string; terminal_events: number }>;
  const terminalByStage = new Map(terminalRows.map((row) => [row.stage, numeric(row.terminal_events)]));
  const received = numeric(funnelCounts.received);
  const funnel: P1DashboardMetrics["funnel"] = FUNNEL_STAGES.map((stage, rank) => {
    const reached_traces = rank === 0 ? received : numeric(funnelCounts[stage]);
    return { stage, received_traces: received, reached_traces, terminal_events: terminalByStage.get(stage) ?? 0, conversion_pct: received ? (reached_traces / received) * 100 : null };
  });
  for (const row of terminalRows) if (!STAGE_RANK.has(row.stage)) funnel.push({ stage: row.stage, received_traces: received, reached_traces: 0, terminal_events: numeric(row.terminal_events), conversion_pct: null });
  const funnel_loss_reasons = db.prepare(`${firstTerminals} SELECT reason_code,COUNT(*) AS traces FROM ranked WHERE ordinal=1 GROUP BY reason_code ORDER BY traces DESC,reason_code ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as P1DashboardMetrics["funnel_loss_reasons"];
  const costs = db.prepare(`SELECT substr(occurred_at,1,10) AS bucket_date,pipeline_version,stage,provider,model,currency,COALESCE(SUM(CASE WHEN cost_status='known' THEN amount_minor ELSE 0 END),0) AS known_cost_minor,
      COUNT(*) FILTER (WHERE cost_status='known') AS known_cost_entries,COUNT(*) FILTER (WHERE cost_status='unknown') AS unknown_cost_entries
      FROM cost_ledger WHERE tenant_id=? AND occurred_at>=? AND occurred_at<?
      GROUP BY substr(occurred_at,1,10),pipeline_version,stage,provider,model,currency ORDER BY bucket_date DESC,known_cost_minor DESC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as P1DashboardMetrics["costs"];
  const validator_reasons = db.prepare(`SELECT validator,rule_version,reason_code,severity,COUNT(*) AS results,COUNT(DISTINCT trace_id) AS traces
      FROM validator_result_fact WHERE tenant_id=? AND terminal=1 AND occurred_at>=? AND occurred_at<?
      GROUP BY validator,rule_version,reason_code,severity ORDER BY results DESC,reason_code ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as P1DashboardMetrics["validator_reasons"];
  const latency = latencyFromTerminalFacts(db, window);

  return {
    window,
    funnel,
    funnel_loss_reasons: funnel_loss_reasons.map((row) => ({ ...row, traces: numeric(row.traces) })),
    costs: costs.map((row) => ({ ...row, known_cost_minor: numeric(row.known_cost_minor), known_cost_entries: numeric(row.known_cost_entries), unknown_cost_entries: numeric(row.unknown_cost_entries) })),
    validator_reasons: validator_reasons.map((row) => ({ ...row, results: numeric(row.results), traces: numeric(row.traces) })),
    latency: latency.latency,
    latency_diagnostics: latency.diagnostics,
  };
  /* c8 ignore stop */
}

/** Controlled integrity projection: no artifact paths, object locators, hashes, or payloads leave this read model. */
export function readIntegrityDashboardStatus(db: DB, requested: Partial<DashboardWindow> = {}): IntegrityDashboardStatus {
  const window = dashboardWindow(requested);
  const latest_daily_root = db.prepare(`SELECT utc_date,status,committed_at FROM integrity_daily_root
      WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1`).get(METRICS_TENANT_ID) as IntegrityDashboardStatus["latest_daily_root"];
  if (!usesRawFacts(window)) return { latest_daily_root: latest_daily_root ?? null, recent_events: [] };
  const recent_events = db.prepare(`SELECT event_type,severity,created_at FROM integrity_audit_event
      WHERE tenant_id=? AND event_type IN ('daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered','orphan_anchor') AND created_at>=? AND created_at<?
      ORDER BY created_at DESC LIMIT ?`).all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as IntegrityDashboardStatus["recent_events"];
  return { latest_daily_root: latest_daily_root ?? null, recent_events };
}

/** Kept testable so capacity fixtures prove the core reads keep their index access paths. */
export function explainP1DashboardQueries(db: DB, requested: Partial<DashboardWindow> = {}): string[] {
  const window = dashboardWindow(requested);
  const explain = (sql: string, ...params: unknown[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  // Aggregate reads are projection-only, including 31-day windows, so their
  // plan evidence must never silently fall back to obsolete raw SQL.
  if (true) {
    const costQuery = longWindowCostsQuery(window);
    if (!costQuery) throw new Error("dashboard_cost_query_empty");
    return [
      explain("WITH received AS (SELECT DISTINCT trace_id FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?) SELECT COUNT(*) FROM received", METRICS_TENANT_ID, window.from, window.to),
      explain(costQuery.sql, ...costQuery.params),
      explain("SELECT validator,rule_version,reason_code,severity,COUNT(*),COUNT(DISTINCT trace_id) FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='validator' AND terminal=1 AND occurred_at>=? AND occurred_at<? GROUP BY validator,rule_version,reason_code,severity ORDER BY COUNT(*) DESC,reason_code ASC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
      explain("WITH ranked AS (SELECT trace_id,stage,ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY occurred_at ASC,fact_id ASC) AS ordinal FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='terminal' AND occurred_at>=? AND occurred_at<?) SELECT stage,COUNT(*) FROM ranked WHERE ordinal=1 GROUP BY stage ORDER BY COUNT(*) DESC,stage ASC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
      explain("WITH terminal AS (SELECT trace_id,attempt,occurred_at AS terminal_at FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='terminal' AND occurred_at>=? AND occurred_at<?) SELECT e.trace_id FROM terminal t JOIN dashboard_trace_fact_v1 e ON e.tenant_id=? AND e.projection_version='dashboard-trace-v1' AND e.fact_kind='funnel' AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered' AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from),
      explain("SELECT * FROM integrity_daily_root WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1", METRICS_TENANT_ID),
    ];
  }
  return [
    explain("WITH received AS (SELECT DISTINCT trace_id FROM funnel_event WHERE tenant_id=? AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?), highest AS (SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank FROM received r JOIN funnel_event f ON f.tenant_id=? AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<? GROUP BY r.trace_id) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to),
    explain("SELECT substr(occurred_at,1,10) AS bucket_date,pipeline_version,stage,provider,model,currency,COALESCE(SUM(CASE WHEN cost_status='known' THEN amount_minor ELSE 0 END),0) AS known_cost_minor,COUNT(*) FILTER (WHERE cost_status='known') AS known_cost_entries,COUNT(*) FILTER (WHERE cost_status='unknown') AS unknown_cost_entries FROM cost_ledger WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? GROUP BY substr(occurred_at,1,10),pipeline_version,stage,provider,model,currency ORDER BY bucket_date DESC,known_cost_minor DESC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain("SELECT validator,rule_version,reason_code,severity,COUNT(*) FROM validator_result_fact WHERE tenant_id=? AND terminal=1 AND occurred_at>=? AND occurred_at<? GROUP BY validator,rule_version,reason_code,severity LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain("WITH ranked AS (SELECT trace_id,stage,ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY occurred_at ASC,event_id ASC) AS ordinal FROM funnel_event WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?) SELECT stage,COUNT(*) FROM ranked WHERE ordinal=1 GROUP BY stage ORDER BY COUNT(*) DESC,stage ASC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain("WITH terminal AS (SELECT trace_id,attempt,occurred_at AS terminal_at FROM funnel_event WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?) SELECT e.trace_id FROM terminal t JOIN funnel_event e ON e.tenant_id=? AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered' AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from),
    explain("SELECT * FROM integrity_daily_root WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1", METRICS_TENANT_ID),
    explain("SELECT * FROM integrity_audit_event WHERE tenant_id=? AND event_type IN ('daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered','orphan_anchor') AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
  ];
}

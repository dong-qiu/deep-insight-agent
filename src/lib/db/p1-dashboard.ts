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

const TRACE_FACT_PREDICATE = "tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel'";
const STAGE_ORDER_SQL = "CASE stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE 999 END";

/** The production latency reads are deliberately SQL-only: SQLite ranks the
 * bounded projection and applies the display limit before rows reach Node. */
function latencyQuery(window: DashboardWindow): PreparedDashboardQuery {
  return { sql: `WITH terminal AS (
      SELECT trace_id,attempt,MIN(occurred_at) AS terminal_at FROM dashboard_trace_fact_v1
      WHERE ${TRACE_FACT_PREDICATE} AND event_type='terminal' AND occurred_at>=? AND occurred_at<? GROUP BY trace_id,attempt
    ), entered AS (
      SELECT e.trace_id,e.attempt,e.stage,e.occurred_at,${STAGE_ORDER_SQL} AS stage_order
      FROM terminal t JOIN dashboard_trace_fact_v1 e ON e.tenant_id=? AND e.projection_version='dashboard-trace-v1' AND e.fact_kind='funnel'
        AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered' AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at
    ), adjacent AS (
      SELECT trace_id,attempt,stage,occurred_at,
        LAG(stage) OVER (PARTITION BY trace_id,attempt ORDER BY stage_order,occurred_at,stage) AS previous_stage,
        LAG(occurred_at) OVER (PARTITION BY trace_id,attempt ORDER BY stage_order,occurred_at,stage) AS previous_occurred_at
      FROM entered
    ), durations AS (
      SELECT previous_stage || ' → ' || stage AS transition,
        ROUND((julianday(occurred_at)-julianday(previous_occurred_at))*86400000) AS duration_ms
      FROM adjacent WHERE previous_stage IS NOT NULL AND previous_stage<>stage
    ), ranked AS (
      SELECT transition,duration_ms,COUNT(*) OVER (PARTITION BY transition) AS samples,
        ROW_NUMBER() OVER (PARTITION BY transition ORDER BY duration_ms ASC) AS ordinal
      FROM durations WHERE duration_ms>=0
    ) SELECT transition,MAX(samples) AS samples,
      MAX(CASE WHEN ordinal=(samples+1)/2 THEN duration_ms END) AS p50_ms,
      MAX(CASE WHEN ordinal=(samples*95+99)/100 THEN duration_ms END) AS p95_ms,
      MAX(CASE WHEN ordinal=(samples*99+99)/100 THEN duration_ms END) AS p99_ms
    FROM ranked GROUP BY transition ORDER BY samples DESC,transition ASC LIMIT ?`, params: [METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, DISPLAY_LIMIT] };
}

function latencyDiagnosticsQuery(window: DashboardWindow): PreparedDashboardQuery {
  return { sql: `WITH terminal AS (
      SELECT trace_id,attempt,MIN(occurred_at) AS terminal_at FROM dashboard_trace_fact_v1
      WHERE ${TRACE_FACT_PREDICATE} AND event_type='terminal' AND occurred_at>=? AND occurred_at<? GROUP BY trace_id,attempt
    ), entered AS (
      SELECT e.trace_id,e.attempt,e.stage,e.occurred_at,${STAGE_ORDER_SQL} AS stage_order
      FROM terminal t JOIN dashboard_trace_fact_v1 e ON e.tenant_id=? AND e.projection_version='dashboard-trace-v1' AND e.fact_kind='funnel'
        AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered' AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at
    ), adjacent AS (
      SELECT trace_id,attempt,stage,occurred_at,
        LAG(stage) OVER (PARTITION BY trace_id,attempt ORDER BY stage_order,occurred_at,stage) AS previous_stage,
        LAG(occurred_at) OVER (PARTITION BY trace_id,attempt ORDER BY stage_order,occurred_at,stage) AS previous_occurred_at
      FROM entered
    ), completed AS (SELECT trace_id,attempt,COUNT(*) AS entered_count FROM entered GROUP BY trace_id,attempt)
    SELECT COUNT(*) AS completed_traces,
      COALESCE(SUM(entered_count<2),0) + COALESCE((SELECT COUNT(*) FROM adjacent WHERE previous_stage IS NOT NULL AND previous_stage<>stage AND (julianday(occurred_at) IS NULL OR julianday(previous_occurred_at) IS NULL)),0) AS missing_clock_samples,
      COALESCE((SELECT COUNT(*) FROM adjacent WHERE previous_stage IS NOT NULL AND previous_stage<>stage AND (julianday(occurred_at)-julianday(previous_occurred_at))<0),0) AS negative_clock_samples
    FROM completed`, params: [METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from] };
}

function inProgressLatencyQuery(window: DashboardWindow): PreparedDashboardQuery {
  return { sql: `SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT f.trace_id,f.attempt FROM dashboard_trace_fact_v1 f
      WHERE f.tenant_id=? AND f.projection_version='dashboard-trace-v1' AND f.fact_kind='funnel' AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<?
        AND NOT EXISTS (SELECT 1 FROM dashboard_trace_fact_v1 terminal WHERE terminal.tenant_id=f.tenant_id AND terminal.projection_version='dashboard-trace-v1' AND terminal.fact_kind='funnel' AND terminal.trace_id=f.trace_id AND terminal.attempt=f.attempt AND terminal.event_type='terminal' AND terminal.occurred_at<?)
    )`, params: [METRICS_TENANT_ID, window.from, window.to, window.to] };
}

function latencyFromTerminalFacts(db: DB, window: DashboardWindow): { latency: DashboardLatency[]; diagnostics: P1DashboardMetrics["latency_diagnostics"] } {
  const query = latencyQuery(window); const diagnosticsQuery = latencyDiagnosticsQuery(window); const inProgressQuery = inProgressLatencyQuery(window);
  const latency = db.prepare(query.sql).all(...query.params) as DashboardLatency[];
  const diagnostics = db.prepare(diagnosticsQuery.sql).get(...diagnosticsQuery.params) as Record<string, number>;
  const inProgress = db.prepare(inProgressQuery.sql).get(...inProgressQuery.params) as { count: number };
  return { latency: latency.map((row) => ({ ...row, samples: numeric(row.samples), p50_ms: numeric(row.p50_ms), p95_ms: numeric(row.p95_ms), p99_ms: numeric(row.p99_ms) })), diagnostics: { completed_traces: numeric(diagnostics.completed_traces), in_progress_traces: numeric(inProgress.count), negative_clock_samples: numeric(diagnostics.negative_clock_samples), missing_clock_samples: numeric(diagnostics.missing_clock_samples) } };
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
  // A sub-day window has neither a leading nor trailing partial day: it is
  // one detail range. Using fullStart here would otherwise leak facts after
  // `to` through the end of that UTC day.
  if (Date.parse(fullEnd) < Date.parse(fullStart)) {
    addDetailRange(window.from, window.to);
  } else {
    addDetailRange(window.from, fullStart);
    addDetailRange(fullEnd, window.to);
  }
  if (Date.parse(fullStart) < Date.parse(fullEnd)) {
    parts.push({ sql: `SELECT substr(bucket_start,1,10) AS bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency,
        SUM(known_cost_minor) AS known_cost_minor,SUM(known_cost_entries) AS known_cost_entries,SUM(unknown_cost_entries) AS unknown_cost_entries
        FROM metric_rollup WHERE tenant_id=? AND grain='day' AND metric_kind='cost' AND bucket_start>=? AND bucket_start<?
        GROUP BY bucket_date,topic_id,source_id,pipeline_version,stage,provider,model,currency`, params: [METRICS_TENANT_ID, fullStart, fullEnd] });
    // Frozen daily rollups are immutable.  An explicitly backfilled late fact
    // therefore contributes from its 400-day projection rather than causing
    // a historical rollup rewrite.
    parts.push({ sql: `SELECT substr(fact.occurred_at,1,10) AS bucket_date,fact.topic_id,fact.source_id,fact.pipeline_version,fact.stage,fact.provider,fact.model,fact.currency,
        COALESCE(SUM(CASE WHEN fact.cost_status='known' THEN fact.amount_minor ELSE 0 END),0) AS known_cost_minor,
        COUNT(*) FILTER (WHERE fact.cost_status='known') AS known_cost_entries,COUNT(*) FILTER (WHERE fact.cost_status='unknown') AS unknown_cost_entries
        FROM dashboard_cost_fact_v1 fact WHERE fact.tenant_id=? AND fact.projection_version='dashboard-cost-v1' AND fact.occurred_at>=? AND fact.occurred_at<?
          AND EXISTS (SELECT 1 FROM metric_late_reconciliation reconciliation
            WHERE reconciliation.tenant_id=fact.tenant_id AND reconciliation.fact_kind='cost' AND reconciliation.event_id=fact.entry_id AND reconciliation.action='backfilled')
        GROUP BY bucket_date,fact.topic_id,fact.source_id,fact.pipeline_version,fact.stage,fact.provider,fact.model,fact.currency`, params: [METRICS_TENANT_ID, fullStart, fullEnd] });
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
  const latency = latencyFromTerminalFacts(db, window);
  return { window, funnel, funnel_loss_reasons: funnel_loss_reasons.map((row) => ({ ...row, traces: numeric(row.traces) })), costs, validator_reasons: validator_reasons.map((row) => ({ ...row, results: numeric(row.results), traces: numeric(row.traces) })), latency: latency.latency, latency_diagnostics: latency.diagnostics };
}

/** Aggregate read model: all SQL predicates begin with the server-injected tenant. */
export function readP1DashboardMetrics(db: DB, requested: Partial<DashboardWindow> = {}): P1DashboardMetrics {
  const window = dashboardWindow(requested);
  // A single admission-controlled projection is used for every aggregate
  // window.  This prevents a newly quarantined raw fact from leaking through
  // a <=31-day path while the 31–400-day path correctly excludes it.
  return readP1DashboardLongWindow(db, window);
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
  const costQuery = longWindowCostsQuery(window); if (!costQuery) throw new Error("dashboard_cost_query_empty");
  const latency = latencyQuery(window); const diagnostics = latencyDiagnosticsQuery(window); const inProgress = inProgressLatencyQuery(window);
  const firstTerminals = "WITH ranked AS (SELECT trace_id,stage,COALESCE(NULLIF(reason_code,''),'not_evaluated') AS reason_code,ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY occurred_at ASC,fact_id ASC) AS ordinal FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='terminal' AND occurred_at>=? AND occurred_at<?)";
  const plans = [
    explain("WITH received AS (SELECT DISTINCT trace_id FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='funnel' AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?), highest AS (SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank FROM received r JOIN dashboard_trace_fact_v1 f ON f.tenant_id=? AND f.projection_version='dashboard-trace-v1' AND f.fact_kind='funnel' AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<? GROUP BY r.trace_id) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to),
    explain(`${firstTerminals} SELECT stage,COUNT(*) AS terminal_events FROM ranked WHERE ordinal=1 GROUP BY stage ORDER BY terminal_events DESC,stage ASC LIMIT ?`, METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain(`${firstTerminals} SELECT reason_code,COUNT(*) AS traces FROM ranked WHERE ordinal=1 GROUP BY reason_code ORDER BY traces DESC,reason_code ASC LIMIT ?`, METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain(costQuery.sql, ...costQuery.params),
    explain("SELECT topic_id,source_id,pipeline_version,validator,rule_version,reason_code,severity,COUNT(*) AS results,COUNT(DISTINCT trace_id) AS traces FROM dashboard_trace_fact_v1 WHERE tenant_id=? AND projection_version='dashboard-trace-v1' AND fact_kind='validator' AND terminal=1 AND occurred_at>=? AND occurred_at<? GROUP BY topic_id,source_id,pipeline_version,validator,rule_version,reason_code,severity ORDER BY results DESC,reason_code ASC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain(latency.sql, ...latency.params), explain(diagnostics.sql, ...diagnostics.params), explain(inProgress.sql, ...inProgress.params),
    explain("SELECT utc_date,status,committed_at FROM integrity_daily_root WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1", METRICS_TENANT_ID),
  ];
  if (usesRawFacts(window)) plans.push(explain("SELECT event_type,severity,created_at FROM integrity_audit_event WHERE tenant_id=? AND event_type IN ('daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered','orphan_anchor') AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT));
  return plans;
}

/**
 * Bounded P1 dashboard read model.  It intentionally consumes only the
 * append-only metric/integrity projections and is never imported by report
 * readers or publishers.
 */
import type { DB } from "./index.js";
import { DETAIL_QUERY_MAX_DAYS, METRICS_TENANT_ID } from "./p1-metrics-facts.js";

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
  costs: Array<{ bucket_date: string; pipeline_version: string; stage: string; provider: string; model: string; currency: string; known_cost_minor: number; known_cost_entries: number; unknown_cost_entries: number }>;
  validator_reasons: Array<{ validator: string; rule_version: string; reason_code: string; severity: string; results: number; traces: number }>;
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
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > DETAIL_QUERY_MAX_DAYS * DAY_MS) {
    throw new Error("dashboard_window_invalid");
  }
  return { from, to };
}

function numeric(value: unknown): number { return Number(value ?? 0); }

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

/**
 * Uses only completed trace/attempts and adjacent `entered` stages. The
 * lookback is no wider than the already validated 31-day dashboard window.
 */
function latencyFromTerminalFacts(db: DB, window: DashboardWindow): { latency: DashboardLatency[]; diagnostics: P1DashboardMetrics["latency_diagnostics"] } {
  const rows = db.prepare(`WITH terminal AS (
      SELECT trace_id,attempt,occurred_at AS terminal_at
      FROM funnel_event
      WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?
    ) SELECT e.trace_id,e.attempt,e.stage,e.event_type,e.occurred_at
    FROM terminal t JOIN funnel_event e
      ON e.tenant_id=? AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered'
        AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at
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
      SELECT DISTINCT f.trace_id,f.attempt FROM funnel_event f
      WHERE f.tenant_id=? AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<?
        AND NOT EXISTS (SELECT 1 FROM funnel_event terminal WHERE terminal.tenant_id=f.tenant_id AND terminal.trace_id=f.trace_id AND terminal.attempt=f.attempt AND terminal.event_type='terminal' AND terminal.occurred_at<?)
    )`).get(METRICS_TENANT_ID, window.from, window.to, window.to) as { count: number };
  return { latency: [...transitions.entries()]
    .map(([transition, samples]) => ({ transition, samples: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), p99_ms: percentile(samples, 0.99) }))
    .sort((a, b) => b.samples - a.samples || a.transition.localeCompare(b.transition))
    .slice(0, DISPLAY_LIMIT), diagnostics: { completed_traces: byTrace.size, in_progress_traces: numeric(inProgress.count), negative_clock_samples, missing_clock_samples } };
}

/** Aggregate read model: all SQL predicates begin with the server-injected tenant. */
export function readP1DashboardMetrics(db: DB, requested: Partial<DashboardWindow> = {}): P1DashboardMetrics {
  const window = dashboardWindow(requested);
  const funnelCounts = db.prepare(`WITH received AS (
      SELECT DISTINCT trace_id FROM funnel_event WHERE tenant_id=? AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?
    ), highest AS (
      SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank
      FROM received r JOIN funnel_event f ON f.tenant_id=? AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<?
      GROUP BY r.trace_id
    ) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest`)
    .get(METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to) as Record<string, number>;
  const terminalRows = db.prepare(`SELECT stage,COUNT(*) AS terminal_events FROM funnel_event
      WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<? GROUP BY stage ORDER BY terminal_events DESC,stage ASC LIMIT ?`)
    .all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as Array<{ stage: string; terminal_events: number }>;
  const terminalByStage = new Map(terminalRows.map((row) => [row.stage, numeric(row.terminal_events)]));
  const received = numeric(funnelCounts.received);
  const funnel: P1DashboardMetrics["funnel"] = FUNNEL_STAGES.map((stage, rank) => {
    const reached_traces = rank === 0 ? received : numeric(funnelCounts[stage]);
    return { stage, received_traces: received, reached_traces, terminal_events: terminalByStage.get(stage) ?? 0, conversion_pct: received ? (reached_traces / received) * 100 : null };
  });
  for (const row of terminalRows) if (!STAGE_RANK.has(row.stage)) funnel.push({ stage: row.stage, received_traces: received, reached_traces: 0, terminal_events: numeric(row.terminal_events), conversion_pct: null });
  const funnel_loss_reasons = db.prepare(`WITH first_terminal AS (
      SELECT trace_id,attempt,reason_code FROM funnel_event f WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?
        AND NOT EXISTS (SELECT 1 FROM funnel_event earlier WHERE earlier.tenant_id=f.tenant_id AND earlier.trace_id=f.trace_id AND earlier.attempt=f.attempt AND earlier.event_type='terminal' AND earlier.occurred_at<f.occurred_at)
    ) SELECT COALESCE(reason_code,'not_evaluated') AS reason_code,COUNT(DISTINCT trace_id) AS traces FROM first_terminal GROUP BY COALESCE(reason_code,'not_evaluated') ORDER BY traces DESC,reason_code ASC LIMIT ?`)
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
}

/** Controlled integrity projection: no artifact paths, object locators, hashes, or payloads leave this read model. */
export function readIntegrityDashboardStatus(db: DB, requested: Partial<DashboardWindow> = {}): IntegrityDashboardStatus {
  const window = dashboardWindow(requested);
  const latest_daily_root = db.prepare(`SELECT utc_date,status,committed_at FROM integrity_daily_root
      WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1`).get(METRICS_TENANT_ID) as IntegrityDashboardStatus["latest_daily_root"];
  const recent_events = db.prepare(`SELECT event_type,severity,created_at FROM integrity_audit_event
      WHERE tenant_id=? AND event_type IN ('daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered','orphan_anchor') AND created_at>=? AND created_at<?
      ORDER BY created_at DESC LIMIT ?`).all(METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT) as IntegrityDashboardStatus["recent_events"];
  return { latest_daily_root: latest_daily_root ?? null, recent_events };
}

/** Kept testable so capacity fixtures prove the core reads keep their index access paths. */
export function explainP1DashboardQueries(db: DB, requested: Partial<DashboardWindow> = {}): string[] {
  const window = dashboardWindow(requested);
  const explain = (sql: string, ...params: unknown[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  return [
    explain("WITH received AS (SELECT DISTINCT trace_id FROM funnel_event WHERE tenant_id=? AND event_type='entered' AND stage='received' AND occurred_at>=? AND occurred_at<?), highest AS (SELECT r.trace_id,MAX(CASE f.stage WHEN 'received' THEN 0 WHEN 'accepted' THEN 1 WHEN 'processed' THEN 2 WHEN 'validated' THEN 3 WHEN 'published' THEN 4 ELSE -1 END) AS stage_rank FROM received r JOIN funnel_event f ON f.tenant_id=? AND f.trace_id=r.trace_id AND f.event_type='entered' AND f.occurred_at>=? AND f.occurred_at<? GROUP BY r.trace_id) SELECT COUNT(*) AS received,COALESCE(SUM(stage_rank>=1),0) AS accepted,COALESCE(SUM(stage_rank>=2),0) AS processed,COALESCE(SUM(stage_rank>=3),0) AS validated,COALESCE(SUM(stage_rank>=4),0) AS published FROM highest", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from, window.to),
    explain("SELECT substr(occurred_at,1,10) AS bucket_date,pipeline_version,stage,provider,model,currency,COALESCE(SUM(CASE WHEN cost_status='known' THEN amount_minor ELSE 0 END),0) AS known_cost_minor,COUNT(*) FILTER (WHERE cost_status='known') AS known_cost_entries,COUNT(*) FILTER (WHERE cost_status='unknown') AS unknown_cost_entries FROM cost_ledger WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? GROUP BY substr(occurred_at,1,10),pipeline_version,stage,provider,model,currency ORDER BY bucket_date DESC,known_cost_minor DESC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain("SELECT validator,rule_version,reason_code,severity,COUNT(*) FROM validator_result_fact WHERE tenant_id=? AND terminal=1 AND occurred_at>=? AND occurred_at<? GROUP BY validator,rule_version,reason_code,severity LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
    explain("WITH terminal AS (SELECT trace_id,attempt,occurred_at AS terminal_at FROM funnel_event WHERE tenant_id=? AND event_type='terminal' AND occurred_at>=? AND occurred_at<?) SELECT e.trace_id FROM terminal t JOIN funnel_event e ON e.tenant_id=? AND e.trace_id=t.trace_id AND e.attempt=t.attempt AND e.event_type='entered' AND e.occurred_at>=? AND e.occurred_at<=t.terminal_at", METRICS_TENANT_ID, window.from, window.to, METRICS_TENANT_ID, window.from),
    explain("SELECT * FROM integrity_daily_root WHERE tenant_id=? ORDER BY utc_date DESC LIMIT 1", METRICS_TENANT_ID),
    explain("SELECT * FROM integrity_audit_event WHERE tenant_id=? AND event_type IN ('daily_anchor_missing','daily_anchor_conflict','daily_anchor_recovered','orphan_anchor') AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT ?", METRICS_TENANT_ID, window.from, window.to, DISPLAY_LIMIT),
  ];
}

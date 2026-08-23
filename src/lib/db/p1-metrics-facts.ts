/** P1b-2 append-only dashboard facts and deterministic local rollups. */
import { randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import { canonicalHash } from "./provenance-facts.js";

export const METRICS_TENANT_ID = "default";
export const FUNNEL_SCHEMA_VERSION = "funnel-v1";
export const DETAIL_RETENTION_DAYS = 90;
export const DAILY_ROLLUP_RETENTION_DAYS = 400;
export const DETAIL_QUERY_MAX_DAYS = 31;
export const ROLLUP_QUERY_MAX_DAYS = 400;
const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FUNNEL_STAGES = ["received", "accepted", "processed", "validated", "published"] as const;
const TERMINAL_STAGES = ["failed", "cancelled", "timed_out", "rejected"] as const;
const REASON_CODES = new Set(["source_not_found", "source_unreachable", "quote_not_in_source", "out_of_context", "exaggeration", "misattribution", "uncertain", "not_evaluated", "event_conflict", "authorization_denied", "internal_error"]);
type FunnelStage = (typeof FUNNEL_STAGES)[number] | (typeof TERMINAL_STAGES)[number];
type EventType = "entered" | "terminal";

export interface FunnelEventInput {
  event_id: string; trace_id: string; stage: FunnelStage; attempt?: number; run_id?: string | null; report_id?: string | null; topic_id?: string | null; source_id?: string | null;
  pipeline_version: string; skip_reason_code?: string | null; reason_code?: string | null;
  occurred_at: string; ingested_at?: string; producer_version?: string;
}
export interface CostLedgerInput {
  entry_id: string; trace_id: string; stage: string; attempt?: number; pipeline_version: string; provider: string; model: string; currency: string;
  amount_minor: number | null; cost_status: "known" | "unknown"; input_tokens?: number; output_tokens?: number;
  occurred_at: string; ingested_at?: string; producer_version?: string;
}
export interface ValidatorResultInput {
  result_id: string; trace_id: string; stage: string; attempt?: number; pipeline_version: string; validator: string; rule_version: string;
  reason_code: string; severity: "info" | "warning" | "error" | "critical"; terminal: boolean;
  occurred_at: string; ingested_at?: string; producer_version?: string;
}
type FactKind = "funnel" | "cost" | "validator";

function requireId(value: string, name: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name}_invalid`);
}
function epoch(value: string): number {
  const match = UTC_INSTANT.exec(value); const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("metric_timestamp_invalid");
  return parsed;
}
function instant(value: string): string { epoch(value); return value; }
function defaulted(value: string | undefined, fallback: string): string { const result = value ?? fallback; requireId(result, "metric_version"); return result; }
function dayAt(value: string): string { return `${value.slice(0, 10)}T00:00:00.000Z`; }
function hourAt(value: string): string { return `${value.slice(0, 13)}:00:00.000Z`; }
function after(start: string, hours: number): string { return new Date(Date.parse(start) + hours * 60 * 60 * 1000).toISOString(); }
function eventType(stage: FunnelStage): EventType { return (TERMINAL_STAGES as readonly string[]).includes(stage) ? "terminal" : "entered"; }
function stageRank(stage: FunnelStage): number { const index = FUNNEL_STAGES.indexOf(stage as typeof FUNNEL_STAGES[number]); return index === -1 ? FUNNEL_STAGES.length : index; }

function recordConflict(db: DB, input: { event_id: string; trace_id: string; stage: string; attempt: number; event_type: EventType; existing?: string; received: string; observed_at: string }): void {
  db.prepare(`INSERT INTO funnel_event_conflict(tenant_id,id,event_id,trace_id,stage,attempt,event_type,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(METRICS_TENANT_ID, `fec_${randomUUID().replaceAll("-", "")}`, input.event_id, input.trace_id, input.stage, input.attempt, input.event_type, input.existing ?? null, input.received, input.observed_at);
}

function validateFunnelState(db: DB, candidate: Required<Pick<FunnelEventInput, "trace_id" | "stage" | "attempt" | "skip_reason_code" | "occurred_at">>): void {
  const rows = db.prepare("SELECT stage,event_type,occurred_at FROM funnel_event WHERE tenant_id=? AND trace_id=? AND attempt=?")
    .all(METRICS_TENANT_ID, candidate.trace_id, candidate.attempt) as Array<{ stage: FunnelStage; event_type: EventType; occurred_at: string }>;
  const isTerminal = eventType(candidate.stage) === "terminal";
  if (isTerminal && rows.some((row) => row.event_type === "terminal" && row.stage !== candidate.stage)) throw new Error("funnel_terminal_conflict");
  const all = [...rows, { stage: candidate.stage, event_type: eventType(candidate.stage), occurred_at: candidate.occurred_at }]
    .sort((a, b) => epoch(a.occurred_at) - epoch(b.occurred_at));
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1]; const current = all[index];
    if (previous.event_type === "terminal" || (current.event_type === "entered" && stageRank(current.stage) < stageRank(previous.stage))) throw new Error("funnel_invalid_transition");
  }
  if (!isTerminal && stageRank(candidate.stage) > 1 && !candidate.skip_reason_code && !rows.some((row) => stageRank(row.stage) === stageRank(candidate.stage) - 1)) {
    throw new Error("funnel_skip_reason_required");
  }
}

export function appendFunnelEvent(db: DB, input: FunnelEventInput): { event_id: string; replayed: boolean } {
  [input.event_id, input.trace_id, input.pipeline_version].forEach((value) => requireId(value, "funnel_input"));
  if (!(FUNNEL_STAGES as readonly string[]).includes(input.stage) && !(TERMINAL_STAGES as readonly string[]).includes(input.stage)) throw new Error("funnel_stage_invalid");
  const attempt = input.attempt ?? 1; if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("funnel_attempt_invalid");
  if (input.reason_code && !REASON_CODES.has(input.reason_code)) throw new Error("validator_reason_code_invalid");
  if (input.skip_reason_code) requireId(input.skip_reason_code, "funnel_skip_reason");
  const occurred_at = instant(input.occurred_at); const ingested_at = instant(input.ingested_at ?? new Date().toISOString());
  if (epoch(ingested_at) < epoch(occurred_at)) throw new Error("metric_occurred_after_ingested");
  const type = eventType(input.stage); const producer_version = defaulted(input.producer_version, "p1-metrics-producer-v1");
  if (input.topic_id) requireId(input.topic_id, "funnel_topic"); if (input.source_id) requireId(input.source_id, "funnel_source");
  const payload = { trace_id: input.trace_id, run_id: input.run_id ?? null, report_id: input.report_id ?? null, topic_id: input.topic_id ?? null, source_id: input.source_id ?? null, stage: input.stage, event_type: type, attempt, pipeline_version: input.pipeline_version, skip_reason_code: input.skip_reason_code ?? null, reason_code: input.reason_code ?? null, occurred_at, schema_version: FUNNEL_SCHEMA_VERSION, producer_version };
  const semantic = canonicalHash(payload);
  // Conflicts are facts themselves. Detect and append them outside the rejected write transaction.
  const existingId = db.prepare("SELECT semantic_payload_hash FROM funnel_event WHERE tenant_id=? AND event_id=?").get(METRICS_TENANT_ID, input.event_id) as { semantic_payload_hash: string } | undefined;
  if (existingId) {
    if (existingId.semantic_payload_hash === semantic) return { event_id: input.event_id, replayed: true };
    recordConflict(db, { event_id: input.event_id, trace_id: input.trace_id, stage: input.stage, attempt, event_type: type, existing: existingId.semantic_payload_hash, received: semantic, observed_at: ingested_at });
    throw new Error("funnel_event_conflict");
  }
  const existingLogical = db.prepare("SELECT event_id,semantic_payload_hash FROM funnel_event WHERE tenant_id=? AND trace_id=? AND stage=? AND attempt=? AND event_type=?")
    .get(METRICS_TENANT_ID, input.trace_id, input.stage, attempt, type) as { event_id: string; semantic_payload_hash: string } | undefined;
  if (existingLogical) {
    if (existingLogical.semantic_payload_hash === semantic) return { event_id: existingLogical.event_id, replayed: true };
    recordConflict(db, { event_id: input.event_id, trace_id: input.trace_id, stage: input.stage, attempt, event_type: type, existing: existingLogical.semantic_payload_hash, received: semantic, observed_at: ingested_at });
    throw new Error("funnel_event_conflict");
  }
  try { validateFunnelState(db, { trace_id: input.trace_id, stage: input.stage, attempt, skip_reason_code: input.skip_reason_code ?? null, occurred_at }); }
  catch (error) {
    recordConflict(db, { event_id: input.event_id, trace_id: input.trace_id, stage: input.stage, attempt, event_type: type, received: semantic, observed_at: ingested_at });
    throw error;
  }
  return db.transaction(() => {
    db.prepare(`INSERT INTO funnel_event(tenant_id,event_id,trace_id,run_id,report_id,topic_id,source_id,stage,event_type,attempt,pipeline_version,skip_reason_code,reason_code,occurred_at,ingested_at,schema_version,producer_version,semantic_payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(METRICS_TENANT_ID, input.event_id, input.trace_id, input.run_id ?? null, input.report_id ?? null, input.topic_id ?? null, input.source_id ?? null, input.stage, type, attempt, input.pipeline_version, input.skip_reason_code ?? null, input.reason_code ?? null, occurred_at, ingested_at, FUNNEL_SCHEMA_VERSION, producer_version, semantic);
    materializeForFact(db, "funnel", input.event_id, occurred_at, ingested_at);
    return { event_id: input.event_id, replayed: false };
  })();
}

function appendSimpleFact(db: DB, kind: Exclude<FactKind, "funnel">, id: string, payload: Record<string, unknown>, occurred_at: string, ingested_at: string): { id: string; replayed: boolean } {
  const table = kind === "cost" ? "cost_ledger" : "validator_result_fact"; const column = kind === "cost" ? "entry_id" : "result_id"; const semantic = canonicalHash(payload);
  const existing = db.prepare(`SELECT semantic_payload_hash FROM ${table} WHERE tenant_id=? AND ${column}=?`).get(METRICS_TENANT_ID, id) as { semantic_payload_hash: string } | undefined;
  if (existing) { if (existing.semantic_payload_hash === semantic) return { id, replayed: true }; throw new Error(`${kind}_idempotency_conflict`); }
  return { id, replayed: false };
}

export function appendCostLedger(db: DB, input: CostLedgerInput): { entry_id: string; replayed: boolean } {
  [input.entry_id, input.trace_id, input.stage, input.pipeline_version, input.provider, input.model, input.currency].forEach((value) => requireId(value, "cost_input"));
  const attempt = input.attempt ?? 1; if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("cost_attempt_invalid");
  if (input.cost_status === "known" ? !Number.isSafeInteger(input.amount_minor) || input.amount_minor! < 0 : input.amount_minor !== null) throw new Error("cost_amount_status_invalid");
  const input_tokens = input.input_tokens ?? 0; const output_tokens = input.output_tokens ?? 0;
  if (![input_tokens, output_tokens].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("cost_usage_invalid");
  const occurred_at = instant(input.occurred_at); const ingested_at = instant(input.ingested_at ?? new Date().toISOString()); if (epoch(ingested_at) < epoch(occurred_at)) throw new Error("metric_occurred_after_ingested");
  const producer_version = defaulted(input.producer_version, "p1-metrics-producer-v1");
  const payload = { ...input, attempt, input_tokens, output_tokens, occurred_at, cost_ledger_schema_version: "cost-ledger-v1", producer_version, ingested_at: undefined };
  return db.transaction(() => {
    const result = appendSimpleFact(db, "cost", input.entry_id, payload, occurred_at, ingested_at); if (result.replayed) return { entry_id: result.id, replayed: true };
    db.prepare(`INSERT INTO cost_ledger(tenant_id,entry_id,trace_id,stage,attempt,pipeline_version,provider,model,currency,amount_minor,cost_status,input_tokens,output_tokens,occurred_at,ingested_at,schema_version,producer_version,semantic_payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(METRICS_TENANT_ID,input.entry_id,input.trace_id,input.stage,attempt,input.pipeline_version,input.provider,input.model,input.currency,input.amount_minor,input.cost_status,input_tokens,output_tokens,occurred_at,ingested_at,"cost-ledger-v1",producer_version,canonicalHash(payload));
    materializeForFact(db, "cost", input.entry_id, occurred_at, ingested_at); return { entry_id: input.entry_id, replayed: false };
  })();
}

export function appendValidatorResult(db: DB, input: ValidatorResultInput): { result_id: string; replayed: boolean } {
  [input.result_id, input.trace_id, input.stage, input.pipeline_version, input.validator, input.rule_version].forEach((value) => requireId(value, "validator_input"));
  if (!REASON_CODES.has(input.reason_code)) throw new Error("validator_reason_code_invalid");
  const attempt = input.attempt ?? 1; if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("validator_attempt_invalid");
  const occurred_at = instant(input.occurred_at); const ingested_at = instant(input.ingested_at ?? new Date().toISOString()); if (epoch(ingested_at) < epoch(occurred_at)) throw new Error("metric_occurred_after_ingested");
  const producer_version = defaulted(input.producer_version, "p1-metrics-producer-v1"); const payload = { ...input, attempt, occurred_at, validator_result_schema_version: "validator-result-v1", producer_version, ingested_at: undefined };
  return db.transaction(() => {
    const result = appendSimpleFact(db, "validator", input.result_id, payload, occurred_at, ingested_at); if (result.replayed) return { result_id: result.id, replayed: true };
    db.prepare(`INSERT INTO validator_result_fact(tenant_id,result_id,trace_id,stage,attempt,pipeline_version,validator,rule_version,reason_code,severity,terminal,occurred_at,ingested_at,schema_version,producer_version,semantic_payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(METRICS_TENANT_ID,input.result_id,input.trace_id,input.stage,attempt,input.pipeline_version,input.validator,input.rule_version,input.reason_code,input.severity,input.terminal ? 1 : 0,occurred_at,ingested_at,"validator-result-v1",producer_version,canonicalHash(payload));
    materializeForFact(db, "validator", input.result_id, occurred_at, ingested_at); return { result_id: input.result_id, replayed: false };
  })();
}

function materializeForFact(db: DB, kind: FactKind, id: string, occurredAt: string, ingestedAt: string): void {
  const day = dayAt(occurredAt); const frozenAt = after(day, 26); const tooLate = epoch(ingestedAt) > epoch(frozenAt) + BACKFILL_WINDOW_MS;
  if (tooLate) {
    db.prepare("INSERT OR IGNORE INTO metric_late_event(tenant_id,fact_kind,event_id,occurred_at,ingested_at,reason_code) VALUES (?,?,?,?,?,?)")
      .run(METRICS_TENANT_ID, kind, id, occurredAt, ingestedAt, "late_event_outside_backfill_window");
    return;
  }
  materializeBucket(db, "hour", hourAt(occurredAt), null, ingestedAt);
  materializeBucket(db, "day", day, epoch(ingestedAt) >= epoch(frozenAt) ? frozenAt : null, epoch(ingestedAt) >= epoch(frozenAt) ? ingestedAt : null);
}

function materializeBucket(db: DB, grain: "hour" | "day", start: string, frozenAt: string | null, revisedAt: string | null): void {
  const end = after(start, grain === "hour" ? 1 : 24);
  const prior = db.prepare("SELECT frozen_at FROM metric_rollup WHERE tenant_id=? AND grain=? AND bucket_start=? LIMIT 1").get(METRICS_TENANT_ID, grain, start) as { frozen_at: string | null } | undefined;
  db.prepare("DELETE FROM metric_rollup WHERE tenant_id=? AND grain=? AND bucket_start=?").run(METRICS_TENANT_ID, grain, start);
  const insert = db.prepare(`INSERT INTO metric_rollup(tenant_id,grain,bucket_start,metric_kind,pipeline_version,stage,provider,model,currency,validator,reason_code,severity,rule_version,received_traces,reached_traces,terminal_events,known_cost_minor,known_cost_entries,unknown_cost_entries,validator_results,validator_traces,frozen_at,revised_at)
    VALUES (@tenant_id,@grain,@bucket_start,@metric_kind,@pipeline_version,@stage,@provider,@model,@currency,@validator,@reason_code,@severity,@rule_version,@received_traces,@reached_traces,@terminal_events,@known_cost_minor,@known_cost_entries,@unknown_cost_entries,@validator_results,@validator_traces,@frozen_at,@revised_at)`);
  const base = { tenant_id: METRICS_TENANT_ID, grain, bucket_start: start, stage: "", provider: "", model: "", currency: "", validator: "", reason_code: "", severity: "", rule_version: "", received_traces: 0, reached_traces: 0, terminal_events: 0, known_cost_minor: 0, known_cost_entries: 0, unknown_cost_entries: 0, validator_results: 0, validator_traces: 0, frozen_at: frozenAt ?? prior?.frozen_at ?? null, revised_at: revisedAt };
  const funnel = db.prepare(`SELECT pipeline_version,stage,COUNT(DISTINCT trace_id) AS reached,COUNT(*) FILTER (WHERE event_type='terminal') AS terminal FROM funnel_event WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? GROUP BY pipeline_version,stage`).all(METRICS_TENANT_ID,start,end) as Array<{ pipeline_version: string; stage: string; reached: number; terminal: number }>;
  const received = new Map((db.prepare(`SELECT pipeline_version,COUNT(DISTINCT trace_id) AS count FROM funnel_event WHERE tenant_id=? AND stage='received' AND occurred_at>=? AND occurred_at<? GROUP BY pipeline_version`).all(METRICS_TENANT_ID,start,end) as Array<{ pipeline_version: string; count: number }>).map((row) => [row.pipeline_version, row.count]));
  for (const row of funnel) insert.run({ ...base, metric_kind: "funnel", pipeline_version: row.pipeline_version, stage: row.stage, received_traces: received.get(row.pipeline_version) ?? 0, reached_traces: row.reached, terminal_events: row.terminal });
  const costs = db.prepare(`SELECT pipeline_version,stage,provider,model,currency,COALESCE(SUM(amount_minor),0) AS known_cost,COUNT(*) FILTER (WHERE cost_status='known') AS known_entries,COUNT(*) FILTER (WHERE cost_status='unknown') AS unknown_entries FROM cost_ledger WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? GROUP BY pipeline_version,stage,provider,model,currency`).all(METRICS_TENANT_ID,start,end) as Array<{ pipeline_version: string; stage: string; provider: string; model: string; currency: string; known_cost: number; known_entries: number; unknown_entries: number }>;
  for (const row of costs) insert.run({ ...base, metric_kind: "cost", ...row, known_cost_minor: row.known_cost, known_cost_entries: row.known_entries, unknown_cost_entries: row.unknown_entries });
  const validators = db.prepare(`SELECT pipeline_version,validator,reason_code,severity,rule_version,COUNT(*) AS total,COUNT(DISTINCT trace_id) AS traces FROM validator_result_fact WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? GROUP BY pipeline_version,validator,reason_code,severity,rule_version`).all(METRICS_TENANT_ID,start,end) as Array<{ pipeline_version: string; validator: string; reason_code: string; severity: string; rule_version: string; total: number; traces: number }>;
  for (const row of validators) insert.run({ ...base, metric_kind: "validator", pipeline_version: row.pipeline_version, validator: row.validator, reason_code: row.reason_code, severity: row.severity, rule_version: row.rule_version, validator_results: row.total, validator_traces: row.traces });
}

/** Detail endpoints are intentionally time-bounded and tenant-prefixed; callers never supply a tenant. */
export function listFunnelDetails(db: DB, input: { from: string; to: string; limit?: number }) {
  const from = instant(input.from); const to = instant(input.to); const max = DETAIL_QUERY_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (epoch(to) <= epoch(from) || epoch(to) - epoch(from) > max) throw new Error("metric_detail_window_invalid");
  const limit = input.limit ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("metric_page_limit_invalid");
  return db.prepare("SELECT * FROM funnel_event WHERE tenant_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at DESC LIMIT ?").all(METRICS_TENANT_ID,from,to,limit);
}

export function queryMetricRollups(db: DB, input: { from: string; to: string; grain: "hour" | "day"; limit?: number }) {
  const from = instant(input.from); const to = instant(input.to); const max = ROLLUP_QUERY_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (epoch(to) <= epoch(from) || epoch(to) - epoch(from) > max) throw new Error("metric_rollup_window_invalid");
  const limit = input.limit ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("metric_page_limit_invalid");
  return db.prepare("SELECT * FROM metric_rollup WHERE tenant_id=? AND grain=? AND bucket_start>=? AND bucket_start<? ORDER BY bucket_start DESC LIMIT ?").all(METRICS_TENANT_ID,input.grain,from,to,limit);
}

/** Retention runs locally after data has aged out; it never touches report, anchor, or source-credit facts. */
export function purgeExpiredMetricFacts(db: DB, now = new Date().toISOString()): { details: number; rollups: number } {
  const cutoff = new Date(epoch(now) - DETAIL_RETENTION_DAYS * 86400000).toISOString(); const dailyCutoff = new Date(epoch(now) - DAILY_ROLLUP_RETENTION_DAYS * 86400000).toISOString();
  return db.transaction(() => {
    let details = 0;
    for (const table of ["funnel_event", "cost_ledger", "validator_result_fact", "metric_late_event"]) details += db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND occurred_at<?`).run(METRICS_TENANT_ID,cutoff).changes;
    details += db.prepare("DELETE FROM funnel_event_conflict WHERE tenant_id=? AND observed_at<?").run(METRICS_TENANT_ID,cutoff).changes;
    const rollups = db.prepare("DELETE FROM metric_rollup WHERE tenant_id=? AND ((grain='hour' AND bucket_start<?) OR (grain='day' AND bucket_start<?))").run(METRICS_TENANT_ID,cutoff,dailyCutoff).changes;
    return { details, rollups };
  })();
}

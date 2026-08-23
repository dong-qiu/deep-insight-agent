/** P1b-1 追加式来源 credit：不读取或改变已发布报告、P1a funnel/cost/validator 事实或 rollup。 */
import { randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import { canonicalHash } from "./provenance-facts.js";
import { getSource } from "./repos.js";
import { sourceConfigRevision } from "./provenance-revisions.js";

export const SOURCE_CREDIT_TENANT_ID = "default";
export const SOURCE_CREDIT_TOTAL_MICROS = 1_000_000;
export const SOURCE_CREDIT_SCHEMA_VERSION = "source-credit-v1";
export const SOURCE_CREDIT_ALLOCATION_VERSION = "equal-split-micros-v1";
export const SOURCE_CREDIT_PRODUCER_VERSION = "source-credit-producer-v1";

export interface SourceCreditInput {
  event_id: string;
  trace_id?: string | null;
  occurred_at: string;
  ingested_at?: string;
  /** Source revision is server-derived from the persisted Source configuration. */
  sources: Array<{ source_id: string }>;
}

export interface SourceCreditWriteResult {
  event_id: string;
  replayed: boolean;
  trace_coverage: "complete" | "partial" | "legacy";
  lateness: "timely" | "reconcilable" | "quarantined";
}

type NormalizedSourceId = { source_id: string };
type NormalizedSource = NormalizedSourceId & { source_revision: string };

function validInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function normalizeInput(input: SourceCreditInput): { event_id: string; trace_id: string | null; occurred_at: string; ingested_at: string; sources: NormalizedSourceId[] } {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.event_id)) throw new Error("source_credit_event_id_invalid");
  if (input.trace_id != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.trace_id)) throw new Error("source_credit_trace_id_invalid");
  const ingestedAt = input.ingested_at ?? new Date().toISOString();
  if (!validInstant(input.occurred_at) || !validInstant(ingestedAt)) throw new Error("source_credit_timestamp_invalid");
  if (Date.parse(input.occurred_at) > Date.parse(ingestedAt)) throw new Error("source_credit_occurred_after_ingested");
  if (input.sources.length === 0 || input.sources.length > SOURCE_CREDIT_TOTAL_MICROS) throw new Error("source_credit_sources_invalid");
  const sources = input.sources.map((source) => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(source.source_id)) throw new Error("source_credit_source_id_invalid");
    return { source_id: source.source_id };
  }).sort((left, right) => left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0);
  if (sources.some((source, index) => index > 0 && source.source_id === sources[index - 1].source_id)) {
    throw new Error("source_credit_source_duplicate");
  }
  return { event_id: input.event_id, trace_id: input.trace_id ?? null, occurred_at: input.occurred_at, ingested_at: ingestedAt, sources };
}

/** Only the persisted Source configuration may determine a fact's source revision. */
function controlledSources(db: DB, sources: NormalizedSourceId[]): NormalizedSource[] {
  return sources.map(({ source_id }) => {
    const source = getSource(db, source_id);
    if (!source) throw new Error("source_credit_source_not_found");
    return { source_id, source_revision: sourceConfigRevision(source) };
  });
}

function traceCoverage(db: DB, traceId: string | null): SourceCreditWriteResult["trace_coverage"] {
  if (!traceId) return "legacy";
  const trace = db.prepare("SELECT coverage,started_at FROM generation_trace WHERE id=?").get(traceId) as { coverage: "complete" | "partial"; started_at: string } | undefined;
  if (!trace) return "legacy";
  const cutover = db.prepare("SELECT meta_value FROM provenance_meta WHERE meta_key='provenance_started_at'").get() as { meta_value: string } | undefined;
  if (!cutover || Date.parse(trace.started_at) < Date.parse(cutover.meta_value)) return "legacy";
  return trace.coverage === "complete" ? "complete" : "partial";
}

function lateness(occurredAt: string, ingestedAt: string): SourceCreditWriteResult["lateness"] {
  const elapsed = Date.parse(ingestedAt) - Date.parse(occurredAt);
  if (elapsed < 24 * 60 * 60 * 1000) return "timely";
  return elapsed <= 7 * 24 * 60 * 60 * 1000 ? "reconcilable" : "quarantined";
}

function semanticPayload(input: ReturnType<typeof normalizeInput>) {
  return {
    event_id: input.event_id, trace_id: input.trace_id, occurred_at: input.occurred_at, sources: input.sources,
    schema_version: SOURCE_CREDIT_SCHEMA_VERSION, allocation_version: SOURCE_CREDIT_ALLOCATION_VERSION,
    producer_version: SOURCE_CREDIT_PRODUCER_VERSION,
  };
}

function allocation(sources: NormalizedSource[]): Array<NormalizedSource & { credit_micros: number }> {
  const base = Math.floor(SOURCE_CREDIT_TOTAL_MICROS / sources.length);
  const remainder = SOURCE_CREDIT_TOTAL_MICROS % sources.length;
  return sources.map((source, index) => ({ ...source, credit_micros: base + (index < remainder ? 1 : 0) }));
}

/**
 * A retry with an identical canonical payload returns the original event. A mismatched retry is recorded
 * in source_credit_conflict before the writer fails, preserving observability without mutating the fact.
 */
export function appendSourceCredit(db: DB, input: SourceCreditInput): SourceCreditWriteResult {
  const normalizedInput = normalizeInput(input);
  const normalized = { ...normalizedInput, sources: controlledSources(db, normalizedInput.sources) };
  const semanticPayloadHash = canonicalHash(semanticPayload(normalized));
  const existing = db.prepare("SELECT semantic_payload_hash,trace_coverage,lateness FROM source_credit_event WHERE tenant_id=? AND event_id=?")
    .get(SOURCE_CREDIT_TENANT_ID, normalized.event_id) as { semantic_payload_hash: string; trace_coverage: SourceCreditWriteResult["trace_coverage"]; lateness: SourceCreditWriteResult["lateness"] } | undefined;
  if (existing) {
    if (existing.semantic_payload_hash === semanticPayloadHash) return { event_id: normalized.event_id, replayed: true, trace_coverage: existing.trace_coverage, lateness: existing.lateness };
    db.prepare(`INSERT INTO source_credit_conflict(id,tenant_id,event_id,existing_semantic_payload_hash,received_semantic_payload_hash,observed_at)
      VALUES (?,?,?,?,?,?)`).run(`scc_${randomUUID().replaceAll("-", "")}`, SOURCE_CREDIT_TENANT_ID, normalized.event_id, existing.semantic_payload_hash, semanticPayloadHash, normalized.ingested_at);
    throw new Error("source_credit_idempotency_conflict");
  }
  const coverage = traceCoverage(db, normalized.trace_id);
  const eventLateness = lateness(normalized.occurred_at, normalized.ingested_at);
  const credits = allocation(normalized.sources);
  if (credits.reduce((sum, credit) => sum + credit.credit_micros, 0) !== SOURCE_CREDIT_TOTAL_MICROS) throw new Error("source_credit_conservation_failed");
  db.transaction(() => {
    db.prepare(`INSERT INTO source_credit_event
      (tenant_id,event_id,trace_id,occurred_at,ingested_at,schema_version,allocation_version,producer_version,trace_coverage,lateness,semantic_payload_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      SOURCE_CREDIT_TENANT_ID, normalized.event_id, normalized.trace_id, normalized.occurred_at, normalized.ingested_at,
      SOURCE_CREDIT_SCHEMA_VERSION, SOURCE_CREDIT_ALLOCATION_VERSION, SOURCE_CREDIT_PRODUCER_VERSION, coverage, eventLateness,
      semanticPayloadHash, normalized.ingested_at,
    );
    const insert = db.prepare(`INSERT INTO source_credit_fact(tenant_id,event_id,source_id,source_revision,credit_micros)
      VALUES (?,?,?,?,?)`);
    for (const credit of credits) insert.run(SOURCE_CREDIT_TENANT_ID, normalized.event_id, credit.source_id, credit.source_revision, credit.credit_micros);
    if (eventLateness !== "timely") {
      db.prepare("INSERT INTO source_credit_late_event(tenant_id,event_id,lateness,recorded_at) VALUES (?,?,?,?)")
        .run(SOURCE_CREDIT_TENANT_ID, normalized.event_id, eventLateness, normalized.ingested_at);
    }
  })();
  return { event_id: normalized.event_id, replayed: false, trace_coverage: coverage, lateness: eventLateness };
}

/** Records an explicit reconciliation decision for a late event; the original event and credits remain immutable. */
export function reconcileLateSourceCredit(db: DB, input: { event_id: string; action: "reconciled" | "declined"; actor_id: string; recorded_at?: string }): { id: string } {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.event_id) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.actor_id)) throw new Error("source_credit_reconciliation_input_invalid");
  const recordedAt = input.recorded_at ?? new Date().toISOString();
  if (!validInstant(recordedAt)) throw new Error("source_credit_timestamp_invalid");
  const late = db.prepare("SELECT 1 FROM source_credit_late_event WHERE tenant_id=? AND event_id=?").get(SOURCE_CREDIT_TENANT_ID, input.event_id);
  if (!late) throw new Error("source_credit_late_event_not_found");
  const id = `scr_${randomUUID().replaceAll("-", "")}`;
  db.prepare(`INSERT INTO source_credit_late_reconciliation(id,tenant_id,event_id,action,actor_id,recorded_at)
    VALUES (?,?,?,?,?,?)`).run(id, SOURCE_CREDIT_TENANT_ID, input.event_id, input.action, input.actor_id, recordedAt);
  return { id };
}

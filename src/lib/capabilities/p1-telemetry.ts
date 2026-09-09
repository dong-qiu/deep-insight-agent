/**
 * P1 telemetry is an optional observer of committed P0 work.
 *
 * The P0 pipeline may depend on these contracts, but it must never depend on
 * the SQLite metrics implementation, a P1 schema, or a P1 runtime flag.
 * Production's dormant profile injects the no-op implementation below.
 */
import type { DB } from "../db/index.js";
import type { AnalysisBatch, ContentItem, Cost, ValidationResult } from "../types.js";

export interface P1TelemetrySink {
  recordCollector(db: DB, input: { run_id: string; item: ContentItem }): void;
  recordAnalysis(db: DB, input: { batch: AnalysisBatch; items: ContentItem[]; run_id: string; costs: Cost[] }): void;
  recordValidation(db: DB, input: { batch: AnalysisBatch; validation: ValidationResult; items: ContentItem[]; run_id: string; costs: Cost[] }): void;
  freezeDueDay(db: DB, now: string): boolean;
}

/** The default is deliberately side-effect free: P0 must be usable without P1. */
export const NOOP_P1_TELEMETRY_SINK: P1TelemetrySink = {
  recordCollector: () => undefined,
  recordAnalysis: () => undefined,
  recordValidation: () => undefined,
  freezeDueDay: () => false,
};

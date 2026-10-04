/** C3 request observations. Never add these estimates to Run.cost or P1 projections. */
import type { DB } from "./index.js";
import { canonicalHash } from "./provenance-facts.js";
import { PRICING, costUSD } from "../runtime/cost.js";

export interface UsageNumbers {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}
export interface UsageIdentity {
  attempt_id: string; logical_call_id: string; attempt_number: number;
  run_id: string; trace_id: string | null;
  role: "analyzer" | "validator" | "coverage" | "followup";
  provider: "anthropic" | "volcengine-responses"; model: string; started_at: string;
}
export interface UsageObservation {
  observation_number: number; final: boolean; usage: UsageNumbers;
}
export interface ModelUsageAttempt extends UsageIdentity, UsageNumbers {
  observation_number: number; observed_at: string | null;
  usage_status: "unknown" | "partial" | "reported";
  estimate_status: "unknown" | "estimated"; estimate_usd: number | null;
  price_source: string | null; price_snapshot: string | null; semantic_hash: string | null;
}
function hasSchema(db: DB): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_usage_attempt'").get());
}
function validateIdentity(input: UsageIdentity): void {
  for (const value of [input.attempt_id, input.logical_call_id, input.run_id, input.trace_id ?? "none", input.model]) {
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value) || value.includes("://")) throw new Error("usage_identity_invalid");
  }
  if (!Number.isSafeInteger(input.attempt_number) || input.attempt_number < 1
    || !["analyzer", "validator", "coverage", "followup"].includes(input.role)
    || !["anthropic", "volcengine-responses"].includes(input.provider)
    || !Number.isFinite(Date.parse(input.started_at))) throw new Error("usage_identity_invalid");
}
const IDENTITY_FIELDS = ["attempt_id", "logical_call_id", "attempt_number", "run_id", "trace_id", "role", "provider", "model", "started_at"] as const;
export function beginModelUsageAttempt(db: DB, input: UsageIdentity, assertWrite?: () => void): { replayed: boolean } {
  validateIdentity(input);
  return db.transaction(() => {
    assertWrite?.();
    if (!hasSchema(db)) throw new Error("usage_schema_unavailable");
    const previous = db.prepare("SELECT * FROM model_usage_attempt WHERE attempt_id=? OR (logical_call_id=? AND attempt_number=?)")
      .get(input.attempt_id, input.logical_call_id, input.attempt_number) as ModelUsageAttempt | undefined;
    if (previous) {
      if (!IDENTITY_FIELDS.every((key) => previous[key] === input[key])) throw new Error("usage_identity_conflict");
      return { replayed: true };
    }
    db.prepare(`INSERT INTO model_usage_attempt(attempt_id,logical_call_id,attempt_number,run_id,trace_id,role,provider,model,started_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(...IDENTITY_FIELDS.map((key) => input[key]));
    return { replayed: false };
  })();
}
export function observeModelUsage(db: DB, attemptId: string, input: UsageObservation, assertWrite?: () => void): { replayed: boolean } {
  if (!Number.isSafeInteger(input.observation_number) || input.observation_number < 1 || typeof input.final !== "boolean") throw new Error("usage_observation_invalid");
  const usage: UsageNumbers = {
    input_tokens: input.usage.input_tokens, output_tokens: input.usage.output_tokens,
    cache_creation_input_tokens: input.usage.cache_creation_input_tokens, cache_read_input_tokens: input.usage.cache_read_input_tokens,
  };
  if (!Object.values(usage).every((value) => value === null || (Number.isSafeInteger(value) && value >= 0))) throw new Error("usage_count_invalid");
  return db.transaction(() => {
    assertWrite?.();
    const previous = db.prepare("SELECT * FROM model_usage_attempt WHERE attempt_id=?").get(attemptId) as ModelUsageAttempt | undefined;
    if (!previous) throw new Error("usage_attempt_missing");
    for (const key of Object.keys(usage) as Array<keyof UsageNumbers>) {
      if (usage[key] === null && previous[key] !== null) usage[key] = previous[key];
    }
    const usage_status = input.final && usage.input_tokens !== null && usage.output_tokens !== null ? "reported"
      : Object.values(usage).some((value) => value !== null) ? "partial" : "unknown";
    if (previous.observation_number > input.observation_number) throw new Error("usage_observation_stale");
    // A completed observation carries its original price snapshot across process/code restarts.
    // Replay must never reprice the same provider usage against a newer local price table.
    if (previous.usage_status === "reported") {
      if (usage_status === "reported" && (Object.keys(usage) as Array<keyof UsageNumbers>).every((key) => previous[key] === usage[key])) return { replayed: true };
      throw new Error("usage_observation_conflict");
    }
    const pricing = PRICING[previous.model];
    const priced = previous.provider === "anthropic" && pricing && usage_status === "reported" && Object.values(usage).every((value) => value !== null);
    const price_snapshot = priced ? JSON.stringify({ currency: "USD", input_per_million: pricing.input, output_per_million: pricing.output, cache_write_multiplier: 1.25, cache_read_multiplier: 0.1 }) : null;
    const estimate = {
      estimate_status: priced ? "estimated" : "unknown", price_source: priced ? "local-pricing-table" : null, price_snapshot,
      estimate_usd: priced ? costUSD(previous.model, { input_tokens: usage.input_tokens!, output_tokens: usage.output_tokens!, cache_creation_input_tokens: usage.cache_creation_input_tokens!, cache_read_input_tokens: usage.cache_read_input_tokens! }) : null,
    };
    const semantic_hash = canonicalHash({ usage, usage_status, ...estimate, estimate_usd: estimate.estimate_usd === null ? null : String(estimate.estimate_usd) });
    if (previous.observation_number === input.observation_number) {
      if (previous.semantic_hash === semantic_hash) return { replayed: true };
      throw new Error("usage_observation_conflict");
    }
    db.prepare(`UPDATE model_usage_attempt SET observation_number=?,observed_at=?,usage_status=?,input_tokens=?,output_tokens=?,
      cache_creation_input_tokens=?,cache_read_input_tokens=?,estimate_status=?,estimate_usd=?,price_source=?,price_snapshot=?,semantic_hash=? WHERE attempt_id=?`)
      .run(input.observation_number, new Date().toISOString(), usage_status, usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens, estimate.estimate_status, estimate.estimate_usd, estimate.price_source, estimate.price_snapshot, semantic_hash, attemptId);
    return { replayed: false };
  })();
}
/** Accept an already-open connection (including readonly). No bootstrap, repair or global DB. */
export function listModelUsageAttempts(db: DB, runId: string, offset = 0): { available: boolean; attempts: ModelUsageAttempt[]; nextOffset?: number } {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("usage_reader_invalid_offset");
  if (!hasSchema(db)) return { available: false, attempts: [] };
  const attempts = db.prepare("SELECT * FROM model_usage_attempt WHERE run_id=? ORDER BY started_at,logical_call_id,attempt_number LIMIT 1001 OFFSET ?")
    .all(runId, offset) as ModelUsageAttempt[];
  const hasMore = attempts.length > 1000;
  return { available: true, attempts: attempts.slice(0, 1000), ...(hasMore ? { nextOffset: offset + 1000 } : {}) };
}

import { z } from "zod";
import { canonicalHash } from "../../src/lib/db/provenance-facts.js";
import { requiredRuntimeRoles, type FreezeProtocol } from "../rich-brief-stage0/data.js";
import { digest, nonempty, resourceSchema, utc } from "./common.js";

const knownCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenUsage = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), input_tokens: knownCount, output_tokens: knownCount, cache_read_tokens: knownCount, cache_write_tokens: knownCount, evidence_resource: resourceSchema }).strict(),
  z.object({ status: z.literal("unknown"), reason: nonempty }).strict(),
]);
const billedCost = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), currency: z.literal("USD"), amount_micros: z.string().regex(/^\d{1,30}$/), evidence_resource: resourceSchema }).strict(),
  z.object({ status: z.literal("unknown"), reason: nonempty }).strict(),
]);
export const ledgerEntrySchema = z.object({
  schema_version: z.literal("rich-brief-c1-call-ledger-v1"), execution_scope: z.literal("shadow"), frozen_protocol_sha256: digest,
  arm_id: nonempty, run_id: nonempty, source_attempt_id: nonempty, call_id: nonempty, retry_of: nonempty.nullable(), attempt: z.number().int().positive(),
  operation: z.enum(requiredRuntimeRoles), machine_input_sha256: digest, operation_input_sha256: digest,
  model: nonempty, model_revision: nonempty, provider: nonempty, transport_revision: nonempty, prompt_sha256: digest, policy_sha256: digest,
  cache_config_sha256: digest, thinking_config_sha256: digest, output_token_cap: z.number().int().positive(),
  started_at: utc, ended_at: utc, elapsed_ms: knownCount, terminal: z.enum(["completed", "failed", "timeout", "cancelled"]), failure_reason: z.string().nullable(),
  output_sha256: digest.nullable(), tokens: tokenUsage, cost: billedCost,
}).strict();
export type CallLedgerEntry = z.infer<typeof ledgerEntrySchema>;
/** This exact JSON Schema resource is what each arm's ledger_schema_sha256 must bind. */
export const callLedgerContract = { schema_version: "rich-brief-c1-ledger-contract-v1", encoding: "UTF-8 JSONL", cost_unit: "integer USD micros as decimal string",
  policy: "append terminal records once; preserve failed/timeout/cancelled attempts and unknown costs; retry_of never replaces prior records; keep arms independent",
  entry: z.toJSONSchema(ledgerEntrySchema), schema_semantics: "input/output token usage is separate from cache read/write; sum provider-billed USD micros without guessing prices" };

export function validateLedger(rawEntries: unknown[], arm: FreezeProtocol["arms"][number], expected: { frozen_sha256: string; machine_sha256: string; registered: { run_id: string; attempt_id: string }[] }): CallLedgerEntry[] {
  const entries = rawEntries.map((raw) => ledgerEntrySchema.parse(raw)), ids = new Map<string, CallLedgerEntry>();
  for (const entry of entries) {
    if (ids.has(entry.call_id)) throw new Error("duplicate_or_rewritten_terminal_call");
    if (entry.arm_id !== arm.arm_id || entry.frozen_protocol_sha256 !== expected.frozen_sha256 || entry.machine_input_sha256 !== expected.machine_sha256) throw new Error("ledger_arm_or_frozen_input_mismatch");
    if (!expected.registered.some((r) => r.run_id === entry.run_id && r.attempt_id === entry.source_attempt_id)) throw new Error("ledger_unregistered_input_attempt");
    const role = arm.runtime_roles.find((r) => r.role === entry.operation); if (!role) throw new Error("ledger_runtime_role_missing");
    if (entry.model !== role.model || entry.model_revision !== role.model_revision || entry.provider !== role.provider || entry.transport_revision !== role.transport_revision
      || entry.prompt_sha256 !== role.prompt_resource.sha256 || entry.policy_sha256 !== role.policy_resource.sha256 || entry.cache_config_sha256 !== canonicalHash(role.cache)
      || entry.thinking_config_sha256 !== canonicalHash(role.thinking) || entry.output_token_cap !== role.max_output_tokens) throw new Error("ledger_runtime_version_mismatch");
    if (entry.ended_at < entry.started_at || entry.elapsed_ms !== Date.parse(entry.ended_at) - Date.parse(entry.started_at)) throw new Error("ledger_call_clock_mismatch");
    if (entry.terminal === "completed" ? !entry.output_sha256 || entry.failure_reason !== null : !entry.failure_reason?.trim()) throw new Error("ledger_terminal_evidence_missing");
    if (entry.attempt > arm.max_attempts) throw new Error("ledger_attempt_budget_exceeded");
    if (entry.retry_of) {
      const prior = ids.get(entry.retry_of);
      if (!prior || prior.terminal === "completed" || prior.arm_id !== entry.arm_id || prior.source_attempt_id !== entry.source_attempt_id || prior.operation !== entry.operation
        || prior.operation_input_sha256 !== entry.operation_input_sha256 || prior.attempt + 1 !== entry.attempt || prior.ended_at > entry.started_at) throw new Error("ledger_retry_does_not_preserve_failed_attempt");
    } else if (entry.attempt !== 1) throw new Error("ledger_retry_parent_missing");
    ids.set(entry.call_id, entry);
  }
  return entries;
}

/** Unexecuted runs and unknown billing remain visible; an empty ledger is not a zero-cost success. */
export function summarizeLedger(entries: CallLedgerEntry[], registered: { run_id: string; attempt_id: string }[]) {
  const byArm: Record<string, { calls: number; failed: number; timeout: number; cancelled: number; completed: number; known_usd_micros: string; unknown_cost_calls: number; unknown_token_calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }> = {};
  for (const entry of entries) {
    ledgerEntrySchema.parse(entry);
    const summary = byArm[entry.arm_id] ??= { calls: 0, failed: 0, timeout: 0, cancelled: 0, completed: 0, known_usd_micros: "0", unknown_cost_calls: 0, unknown_token_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    summary.calls++; summary[entry.terminal]++;
    if (entry.cost.status === "known") summary.known_usd_micros = (BigInt(summary.known_usd_micros) + BigInt(entry.cost.amount_micros)).toString(); else summary.unknown_cost_calls++;
    if (entry.tokens.status === "unknown") summary.unknown_token_calls++;
    else for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
      summary[field] += entry.tokens[field]; if (!Number.isSafeInteger(summary[field])) throw new Error("ledger_token_total_overflow");
    }
  }
  return { status: entries.length ? "observed_calls_not_quality_approval" : "not_executed", registered_input_attempts: registered.length, by_arm: byArm };
}

/** P0 溯源不可变事实：canonical hash、revision、event/ref/edge 的事务写入原语。 */
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "./index.js";

export type EntityRefRole = "input" | "output" | "evidence" | "filtered" | "superseded";
export type VisibilityClass = "public_evidence" | "admin_only" | "redacted_at_write";
export interface EntityRef {
  type: string;
  locator: { kind: "id"; id: string } | { kind: "composite"; key: Record<string, string | number> };
  revision: string;
  hash?: string;
  role: EntityRefRole;
  visibility_class?: VisibilityClass;
}
export interface GenerationEventInput {
  trace_id: string; stage: string; event_type: string; attempt?: number; run_id?: string | null;
  actor_type?: "system" | "user" | "scheduler"; actor_id?: string | null; reason_code?: string | null;
  input_refs?: EntityRef[]; output_refs?: EntityRef[]; metrics?: Record<string, unknown>; version_context?: Record<string, unknown>;
  context_completeness?: "complete" | "partial"; error?: { reason_code: string; message?: string; retryable?: boolean } | null;
  occurred_at?: string;
}

function compareUnicode(left: string, right: string): number {
  const a = Array.from(left); const b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** v1 canonical JSON：key 按 Unicode code point 排序、对象缺失值省略、数组顺序保持。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("canonical_json_non_integer_number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareUnicode(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("canonical_json_unsupported_value");
}
export const canonicalHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
export function entityKey(ref: Pick<EntityRef, "type" | "locator">): string {
  return `${ref.type}:v1:${Buffer.from(canonicalJson(ref.locator), "utf8").toString("base64url")}`;
}

export function captureRevision(db: DB, input: { entity_type: string; entity_key: string; revision: string; snapshot: Record<string, unknown>; captured_at?: string }): void {
  const capturedAt = input.captured_at ?? new Date().toISOString();
  const snapshot = canonicalJson(input.snapshot);
  const hash = createHash("sha256").update(snapshot, "utf8").digest("hex");
  const row = db.prepare("SELECT snapshot_hash FROM provenance_revision WHERE entity_type=? AND entity_key=? AND revision=?")
    .get(input.entity_type, input.entity_key, input.revision) as { snapshot_hash: string } | undefined;
  if (row) {
    if (row.snapshot_hash !== hash) throw new Error("provenance_revision_conflict");
    return;
  }
  db.prepare(`INSERT INTO provenance_revision(entity_type,entity_key,revision,captured_at,snapshot,snapshot_hash)
    VALUES (?,?,?,?,?,?)`).run(input.entity_type, input.entity_key, input.revision, capturedAt, snapshot, hash);
}

function semanticPayload(input: GenerationEventInput): Record<string, unknown> {
  return {
    trace_id: input.trace_id, stage: input.stage, event_type: input.event_type, attempt: input.attempt ?? 1,
    run_id: input.run_id ?? null, actor_type: input.actor_type ?? "system", actor_id: input.actor_id ?? null,
    reason_code: input.reason_code ?? null, input_refs: input.input_refs ?? [], output_refs: input.output_refs ?? [],
    version_context: input.version_context ?? {}, context_completeness: input.context_completeness ?? "partial",
    error: input.error ? { reason_code: input.error.reason_code, retryable: input.error.retryable ?? false } : null,
  };
}

/** 同一 stage/attempt/event_type 重放只在语义 hash 相等时返回旧事件；否则拒绝覆盖。 */
export function appendGenerationEvent(db: DB, input: GenerationEventInput): { id: string; sequence: number; replayed: boolean } {
  const attempt = input.attempt ?? 1;
  const semanticHash = canonicalHash(semanticPayload(input));
  return db.transaction(() => {
    const existing = (db.prepare(`SELECT id,sequence,semantic_payload_hash FROM generation_event
      WHERE trace_id=? AND stage=? AND attempt=? AND event_type=?`).get(input.trace_id, input.stage, attempt, input.event_type) as { id: string; sequence: number; semantic_payload_hash: string } | undefined);
    if (existing) {
      if (existing.semantic_payload_hash !== semanticHash) throw new Error("generation_event_idempotency_conflict");
      return { id: existing.id, sequence: existing.sequence, replayed: true };
    }
    const trace = db.prepare("SELECT next_sequence FROM generation_trace WHERE id=?").get(input.trace_id) as { next_sequence: number } | undefined;
    if (!trace) throw new Error("generation_trace_not_found");
    const sequence = trace.next_sequence + 1;
    db.prepare("UPDATE generation_trace SET next_sequence=? WHERE id=? AND next_sequence=?").run(sequence, input.trace_id, trace.next_sequence);
    const id = `evt_${randomUUID().replaceAll("-", "")}`;
    const occurredAt = input.occurred_at ?? new Date().toISOString();
    const refs = { input_refs: input.input_refs ?? [], output_refs: input.output_refs ?? [] };
    const payload = {
      id, trace_id: input.trace_id, sequence, attempt, run_id: input.run_id ?? null, stage: input.stage, event_type: input.event_type,
      occurred_at: occurredAt, actor_type: input.actor_type ?? "system", actor_id: input.actor_id ?? null,
      reason_code: input.reason_code ?? null, ...refs, metrics: input.metrics ?? {}, version_context: input.version_context ?? {},
      context_completeness: input.context_completeness ?? "partial", error: input.error ?? null, payload_schema_version: 1,
    };
    const payloadHash = canonicalHash(payload);
    db.prepare(`INSERT INTO generation_event
      (id,trace_id,sequence,attempt,run_id,stage,event_type,occurred_at,actor_type,actor_id,reason_code,input_refs,output_refs,metrics,version_context,context_completeness,error,payload_schema_version,semantic_payload_hash,payload_hash)
      VALUES (@id,@trace_id,@sequence,@attempt,@run_id,@stage,@event_type,@occurred_at,@actor_type,@actor_id,@reason_code,@input_refs,@output_refs,@metrics,@version_context,@context_completeness,@error,1,@semantic_payload_hash,@payload_hash)`).run({
      ...payload, input_refs: canonicalJson(refs.input_refs), output_refs: canonicalJson(refs.output_refs), metrics: canonicalJson(payload.metrics),
      version_context: canonicalJson(payload.version_context), error: payload.error ? canonicalJson(payload.error) : null, semantic_payload_hash: semanticHash, payload_hash: payloadHash,
    });
    for (const ref of [...refs.input_refs, ...refs.output_refs]) {
      db.prepare(`INSERT INTO generation_entity_ref(trace_id,event_id,entity_type,entity_key,revision,role,visibility_class)
        VALUES (?,?,?,?,?,?,?)`).run(input.trace_id, id, ref.type, entityKey(ref), ref.revision, ref.role, ref.visibility_class ?? "admin_only");
    }
    projectTrace(db, input.trace_id);
    return { id, sequence, replayed: false };
  })();
}

/** P0a 冻结 policy 的最小 projector；只从 append-only event 重建，不把 summary 当状态事实。 */
export function projectTrace(db: DB, traceId: string): "running" | "done" | "failed" | "partial" {
  const rows = db.prepare("SELECT stage,event_type FROM generation_event WHERE trace_id=? ORDER BY sequence").all(traceId) as { stage: string; event_type: string }[];
  const required = ["analyze", "validate", "generate_report"];
  const state = new Map<string, Set<string>>();
  for (const row of rows) (state.get(row.stage) ?? state.set(row.stage, new Set()).get(row.stage)!).add(row.event_type);
  const terminal = (stage: string) => state.get(stage) ?? new Set<string>();
  let result: "running" | "done" | "failed" | "partial" = "running";
  if (required.some((stage) => terminal(stage).has("failed"))) result = "failed";
  else if (required.every((stage) => terminal(stage).has("completed") || terminal(stage).has("skipped"))) {
    result = ["derive_lead", "map_direction", "derive_opportunity", "deliver"].some((stage) => terminal(stage).has("failed")) ? "partial" : "done";
  }
  db.prepare("UPDATE generation_trace SET status=? WHERE id=? AND status <> ?").run(result, traceId, result);
  return result;
}

export function initializeProvenanceMeta(db: DB, startedAt = new Date().toISOString()): void {
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO provenance_meta(meta_key,meta_value,created_at) VALUES ('provenance_started_at',?,?)").run(startedAt, startedAt);
    db.prepare("INSERT OR IGNORE INTO provenance_meta(meta_key,meta_value,created_at) VALUES ('provenance_schema_version','20260803_06_provenance_facts',?)").run(startedAt);
  })();
}

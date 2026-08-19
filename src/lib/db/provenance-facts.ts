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
  actor_type?: "system" | "user" | "scheduler"; actor_id?: string | null; audit_log_id?: number | null; reason_code?: string | null;
  input_refs?: EntityRef[]; output_refs?: EntityRef[]; metrics?: Record<string, unknown>; version_context?: Record<string, unknown>;
  context_completeness?: "complete" | "partial"; error?: { reason_code: string; message?: string; retryable?: boolean } | null;
  occurred_at?: string;
}

export type TraceStatus = "running" | "done" | "failed" | "partial" | "cancelled";
type TerminalOutcome = "completed" | "skipped" | "failed" | "cancelled";
export interface CompletionPolicyStage {
  stage: string;
  execution_kind: "run" | "event_only" | "omitted";
  criticality: "required" | "non_blocking";
  allowed_terminal_events: TerminalOutcome[];
  skip_is_success: boolean;
}
export interface CompletionPolicy {
  schema_version: 1;
  stages: CompletionPolicyStage[];
}

const policyStage = (
  stage: string,
  execution_kind: CompletionPolicyStage["execution_kind"],
  criticality: CompletionPolicyStage["criticality"],
  allowed_terminal_events: TerminalOutcome[],
  skip_is_success = false,
): CompletionPolicyStage => ({ stage, execution_kind, criticality, allowed_terminal_events, skip_is_success });

export function topicPipelineCompletionPolicy(input: { planning: boolean; selection: boolean }): CompletionPolicy {
  return {
    schema_version: 1,
    stages: [
      policyStage("select", input.selection ? "event_only" : "omitted", "required", ["completed", "skipped"], true),
      policyStage("analyze", "run", "required", ["completed", "failed", "cancelled"]),
      policyStage("validate", "run", "required", ["completed", "failed", "cancelled"]),
      policyStage("generate_report", "run", "required", ["completed", "failed", "cancelled"]),
      policyStage("derive_lead", input.planning ? "event_only" : "omitted", "non_blocking", ["completed", "failed", "cancelled"]),
      policyStage("map_direction", input.planning ? "event_only" : "omitted", "non_blocking", ["completed", "failed", "cancelled"]),
      policyStage("derive_opportunity", input.planning ? "event_only" : "omitted", "non_blocking", ["completed", "failed", "cancelled"]),
      // deliver 是 side effect 观测，不参与主链路失败：只允许 attempted / skipped，二者均归一为成功。
      policyStage("deliver", "event_only", "non_blocking", ["completed", "skipped"], true),
    ],
  };
}

export function sourceCollectCompletionPolicy(): CompletionPolicy {
  return {
    schema_version: 1,
    stages: [
      policyStage("collect", "run", "required", ["completed", "failed", "cancelled"]),
      policyStage("normalize", "run", "required", ["completed", "failed", "cancelled"]),
    ],
  };
}

export function manualDecisionCompletionPolicy(stage: "human_review" | "direction_change"): CompletionPolicy {
  return { schema_version: 1, stages: [policyStage(stage, "event_only", "required", ["completed", "failed", "cancelled"])] };
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
    run_id: input.run_id ?? null, actor_type: input.actor_type ?? "system", actor_id: input.actor_id ?? null, audit_log_id: input.audit_log_id ?? null,
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
      occurred_at: occurredAt, actor_type: input.actor_type ?? "system", actor_id: input.actor_id ?? null, audit_log_id: input.audit_log_id ?? null,
      reason_code: input.reason_code ?? null, ...refs, metrics: input.metrics ?? {}, version_context: input.version_context ?? {},
      context_completeness: input.context_completeness ?? "partial", error: input.error ?? null, payload_schema_version: 1,
    };
    const payloadHash = canonicalHash(payload);
    db.prepare(`INSERT INTO generation_event
      (id,trace_id,sequence,attempt,run_id,stage,event_type,occurred_at,actor_type,actor_id,audit_log_id,reason_code,input_refs,output_refs,metrics,version_context,context_completeness,error,payload_schema_version,semantic_payload_hash,payload_hash)
      VALUES (@id,@trace_id,@sequence,@attempt,@run_id,@stage,@event_type,@occurred_at,@actor_type,@actor_id,@audit_log_id,@reason_code,@input_refs,@output_refs,@metrics,@version_context,@context_completeness,@error,1,@semantic_payload_hash,@payload_hash)`).run({
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

function legacyCompletionPolicy(scopeKind: string): CompletionPolicy {
  if (scopeKind === "source_collect") return sourceCollectCompletionPolicy();
  if (scopeKind === "manual_decision") {
    return { schema_version: 1, stages: [
      policyStage("human_review", "event_only", "required", ["completed", "failed", "cancelled"]),
      policyStage("direction_change", "event_only", "required", ["completed", "failed", "cancelled"]),
    ] };
  }
  return topicPipelineCompletionPolicy({ planning: true, selection: false });
}

function parseCompletionPolicy(value: string, scopeKind: string): CompletionPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid_completion_policy"); }
  if (!parsed || typeof parsed !== "object") throw new Error("invalid_completion_policy");
  const policy = parsed as Partial<CompletionPolicy> & { planning?: unknown; selection?: unknown };
  // Pre-P0d traces are immutable historical facts: keep them readable with a deterministic legacy shape.
  if (Object.keys(policy).length === 0) return legacyCompletionPolicy(scopeKind);
  // P0a 已发布的 topic snapshot 只有 schema_version / planning（以及部分 trace 的 selection），
  // 没有 P0d 的 stages 数组。投影时将其只读地解释成相同的 legacy policy，绝不回写事实快照。
  const legacyP0aKeys = Object.keys(policy).every((key) => ["schema_version", "planning", "selection"].includes(key));
  if (scopeKind === "topic_pipeline" && legacyP0aKeys && policy.schema_version === 1
    && (policy.planning === undefined || typeof policy.planning === "boolean")
    && (policy.selection === undefined || typeof policy.selection === "boolean") && policy.stages === undefined) {
    return topicPipelineCompletionPolicy({ planning: policy.planning ?? true, selection: policy.selection ?? false });
  }
  if (policy.schema_version !== 1 || !Array.isArray(policy.stages) || policy.stages.length === 0) throw new Error("invalid_completion_policy");
  for (const stage of policy.stages) {
    if (!stage || typeof stage.stage !== "string" || !["run", "event_only", "omitted"].includes(stage.execution_kind ?? "")
      || !["required", "non_blocking"].includes(stage.criticality ?? "") || !Array.isArray(stage.allowed_terminal_events)
      || typeof stage.skip_is_success !== "boolean") throw new Error("invalid_completion_policy");
  }
  return policy as CompletionPolicy;
}

function eventOutcome(row: { event_type: string; error: string | null }): TerminalOutcome | null {
  if (row.event_type === "completed" || row.event_type === "manual_decided" || row.event_type === "config_changed" || row.event_type === "published" || row.event_type === "attempted") return "completed";
  if (row.event_type === "skipped") return "skipped";
  if (row.event_type !== "failed") return null;
  try {
    const error = row.error ? JSON.parse(row.error) as { reason_code?: unknown; type?: unknown } : {};
    if (error.reason_code === "cancelled" || error.type === "cancelled") return "cancelled";
  } catch { /* malformed legacy error remains a failure */ }
  return "failed";
}

function runOutcome(row: { status: string; error: string | null }): TerminalOutcome | null {
  if (row.status === "running") return null;
  if (row.status === "done") return "completed";
  if (row.status === "failed") {
    try {
      const error = row.error ? JSON.parse(row.error) as { type?: unknown; reason_code?: unknown } : {};
      if (error.type === "cancelled" || error.reason_code === "cancelled") return "cancelled";
    } catch { /* malformed legacy error remains a failure */ }
    return "failed";
  }
  return null;
}

function runKindForStage(stage: string): string | null {
  return ({ analyze: "analyze", validate: "validate", generate_report: "report-gen", collect: "ingest", normalize: "ingest" } as Record<string, string>)[stage] ?? null;
}

function eventOutcomeForStage(stage: CompletionPolicyStage, event: { event_type: string; error: string | null }): TerminalOutcome | null {
  const outcome = eventOutcome(event);
  // The policy stores normalized outcomes, while deliver's public contract names raw events.
  // A direct completed/failed/cancelled delivery event is therefore an invalid terminal outcome.
  if (stage.stage === "deliver" && outcome && !["attempted", "skipped"].includes(event.event_type)) return "failed";
  return outcome;
}

/** 唯一的 trace 状态写入点：只读取冻结 policy、Run 聚合与 append-only 终态 event。 */
export function projectTrace(db: DB, traceId: string): TraceStatus {
  const trace = db.prepare("SELECT scope_kind,completion_policy FROM generation_trace WHERE id=?").get(traceId) as { scope_kind: string; completion_policy: string } | undefined;
  if (!trace) throw new Error("generation_trace_not_found");
  const policy = parseCompletionPolicy(trace.completion_policy, trace.scope_kind);
  const events = db.prepare("SELECT sequence,stage,attempt,run_id,event_type,error FROM generation_event WHERE trace_id=? ORDER BY sequence")
    .all(traceId) as { sequence: number; stage: string; attempt: number; run_id: string | null; event_type: string; error: string | null }[];
  const runs = db.prepare("SELECT id,kind,status,error,retry_of,started_at FROM run WHERE trace_id=? ORDER BY started_at,id")
    .all(traceId) as { id: string; kind: string; status: string; error: string | null; retry_of: string | null; started_at: string }[];
  const runById = new Map(runs.map((run) => [run.id, run]));
  const runAttempt = new Map<string, number>();
  const attemptForRun = (run: typeof runs[number], seen = new Set<string>()): number => {
    const cached = runAttempt.get(run.id);
    if (cached) return cached;
    if (!run.retry_of || seen.has(run.id)) return 1;
    seen.add(run.id);
    const parent = runById.get(run.retry_of);
    const attempt = parent && parent.kind === run.kind ? attemptForRun(parent, seen) + 1 : 1;
    runAttempt.set(run.id, attempt);
    return attempt;
  };
  // A source-collect ingest Run legitimately spans collect and normalize, so retain every
  // explicit stage binding instead of letting the latest event overwrite the earlier one.
  const eventRunStages = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (!event.run_id) continue;
    const stages = eventRunStages.get(event.run_id) ?? new Map<string, number>();
    stages.set(event.stage, Math.max(stages.get(event.stage) ?? 0, event.attempt));
    eventRunStages.set(event.run_id, stages);
  }
  const runsWithAttempt = runs.map((run) => {
    const stages = eventRunStages.get(run.id);
    return { ...run, fallbackAttempt: attemptForRun(run), stages: stages ?? null };
  });
  const stageOutcome = (stage: CompletionPolicyStage): TerminalOutcome | null => {
    if (stage.execution_kind === "omitted") return "completed";
    const stageEvents = events.filter((event) => event.stage === stage.stage);
    const kind = runKindForStage(stage.stage);
    // Prefer explicit event → Run bindings. Legacy rows without any binding retain the kind fallback.
    const stageRuns = kind ? runsWithAttempt.flatMap((run) => {
      const linkedAttempt = run.stages?.get(stage.stage);
      if (linkedAttempt) return [{ ...run, attempt: linkedAttempt }];
      return run.stages === null && run.kind === kind ? [{ ...run, attempt: run.fallbackAttempt }] : [];
    }) : [];
    const attempt = Math.max(0, ...stageEvents.map((event) => event.attempt), ...stageRuns.map((run) => run.attempt));
    if (attempt === 0) return null;
    const latestEvent = stageEvents.filter((event) => event.attempt === attempt)
      .reduce<TerminalOutcome | null>((outcome, event) => eventOutcomeForStage(stage, event) ?? outcome, null);
    if (stage.execution_kind === "event_only") {
      if (!latestEvent) return null;
      return stage.allowed_terminal_events.includes(latestEvent) && (latestEvent !== "skipped" || stage.skip_is_success) ? latestEvent : "failed";
    }
    const currentRuns = stageRuns.filter((run) => run.attempt === attempt);
    // A retry that has started (or whose Run is still running) must hide terminal facts from older attempts.
    if (currentRuns.some((run) => run.status === "running")) return null;
    // A terminal infrastructure/recovery failure may be recorded before a stage event is available.
    // Success still requires both sides, so a lone completed Run/event remains running.
    if (!latestEvent) {
      const run = currentRuns.length ? runOutcome(currentRuns[currentRuns.length - 1]) : null;
      return run === "failed" || run === "cancelled" ? run : null;
    }
    if (currentRuns.length === 0) return latestEvent === "failed" || latestEvent === "cancelled" ? latestEvent : null;
    const latestRun = currentRuns[currentRuns.length - 1];
    const run = runOutcome(latestRun);
    if (!run) return null;
    const result = run === "cancelled" || latestEvent === "cancelled" ? "cancelled"
      : run === "failed" || latestEvent === "failed" ? "failed"
        : run === "completed" && latestEvent === "completed" ? "completed"
          : latestEvent === "skipped" && stage.skip_is_success && run === "completed" ? "skipped" : null;
    if (!result) return null;
    return stage.allowed_terminal_events.includes(result) && (result !== "skipped" || stage.skip_is_success) ? result : "failed";
  };
  const stages = policy.stages.map((stage) => ({ policy: stage, outcome: stageOutcome(stage) }));
  const required = stages.filter(({ policy }) => policy.criticality === "required");
  const requiredCancelled = required.some(({ outcome }) => outcome === "cancelled");
  const requiredFailed = required.some(({ outcome, policy }) => outcome === "failed" || (outcome === "skipped" && !policy.skip_is_success));
  // 零输入 cron 在 select 处以允许的 skip 收口；后续 run stages 本轮被 policy 明确省略执行。
  const zeroInputCompleted = required.some(({ policy, outcome }) => policy.stage === "select" && outcome === "skipped" && policy.skip_is_success);
  const requiredRunning = required.some(({ outcome }) => outcome === null);
  const requiredDone = required.every(({ outcome, policy }) => outcome === "completed" || (outcome === "skipped" && policy.skip_is_success));
  const nonBlockingFailed = stages.some(({ policy, outcome }) => policy.criticality === "non_blocking" && (outcome === "failed" || outcome === "cancelled"));
  const result: TraceStatus = requiredCancelled ? "cancelled"
    : requiredFailed ? "failed"
      : zeroInputCompleted ? "done"
      : requiredRunning ? "running"
        : requiredDone && nonBlockingFailed ? "partial"
          : requiredDone ? "done" : "running";
  const endedAt = result === "running" ? null : new Date().toISOString();
  db.prepare("UPDATE generation_trace SET status=@status,ended_at=CASE WHEN @ended_at IS NULL THEN NULL WHEN status <> @status THEN @ended_at ELSE COALESCE(ended_at,@ended_at) END WHERE id=@trace_id")
    .run({ trace_id: traceId, status: result, ended_at: endedAt });
  return result;
}

export function initializeProvenanceMeta(db: DB, startedAt = new Date().toISOString()): void {
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO provenance_meta(meta_key,meta_value,created_at) VALUES ('provenance_started_at',?,?)").run(startedAt, startedAt);
    db.prepare("INSERT OR IGNORE INTO provenance_meta(meta_key,meta_value,created_at) VALUES ('provenance_schema_version','20260803_06_provenance_facts',?)").run(startedAt);
  })();
}

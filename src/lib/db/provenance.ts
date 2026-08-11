/** P0a generation provenance 的持久编排原语。
 *
 * 路由只负责写 request/trace/reservation/dispatch；任何实际执行都必须先经 worker claim。
 * 这里故意不调用 agent 或网络，确保 202 的可靠性边界仅依赖一个 SQLite 事务。 */
import { createHmac, randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import { appendGenerationEvent, captureRevision, entityKey, type EntityRef } from "./provenance-facts.js";
import { appendAudit } from "./audit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_RETENTION_MS = 100 * DAY_MS;
const LEASE_TTL_MS = 120_000;

/** 生成请求受理时冻结的、可公开给管理员的运行事实。来自不可变 deployment record 与 schema 元数据，
 * 不读取环境变量、密钥或任意模型配置；这样 trace 不会随之后的发布而漂移。 */
function runtimeVersionAt(db: DB, startedAt: string): string {
  const deployment = db.prepare(`SELECT image_digest,git_sha FROM deployment_record
    WHERE deployed_at <= ? ORDER BY deployed_at DESC,id DESC LIMIT 1`).get(startedAt) as
    | { image_digest: string; git_sha: string }
    | undefined;
  const schema = db.prepare("SELECT meta_value FROM provenance_meta WHERE meta_key='provenance_schema_version'").get() as
    | { meta_value: string }
    | undefined;
  return JSON.stringify({
    schema_version: 1,
    ...(deployment ? { image_digest: deployment.image_digest, git_sha: deployment.git_sha } : {}),
    ...(schema ? { provenance_schema_version: schema.meta_value } : {}),
  });
}

export type TraceRequestResult =
  | { kind: "accepted"; traceId: string; requestId: string }
  | { kind: "replayed"; traceId: string; requestId: string }
  | { kind: "conflict"; activeTraceId: string };

/** 完整重跑只接受失败且已终态的 trace；不修改原 request / trace / dispatch。 */
export type RetryTraceRequestResult = TraceRequestResult
  | { kind: "not_found" }
  | { kind: "not_retryable"; status: string; requestState: string };

export type SourceCollectTraceRequestResult =
  | { kind: "accepted"; traceId: string }
  | { kind: "replayed"; traceId: string }
  | { kind: "conflict"; activeTraceId: string };

/** 同步 source_collect 不经过 dispatch worker，但仍先取 owned lease，所有业务写入均可 fencing。 */
export interface SourceCollectClaim {
  traceId: string;
  ownerToken: string;
  fencingEpoch: number;
}

export interface DispatchClaim {
  dispatchId: string;
  traceId: string;
  ownerToken: string;
  claimEpoch: number;
  fencingEpoch: number;
  rootRunId: string;
  payload: {
    topic_id: string;
    planning: boolean;
    report_type: "brief" | "deep_dive" | "initial_digest";
    window_hours?: number;
    /** 定时任务受理时冻结的窗口右边界；重试不能漂移到当前时间。 */
    window_end?: string;
    items?: number;
    schema_version: 1;
  };
}

/** 在每次异步外部调用返回后的业务写入前复验。旧 owner 即使仍持有内存中的 claim，
 * 也无法在 dispatch/lease 已被接管或到期后提交任何事实。 */
export function assertGenerationDispatchClaim(db: DB, claim: Pick<DispatchClaim, "dispatchId" | "traceId" | "ownerToken" | "claimEpoch" | "fencingEpoch">, now = new Date()): void {
  const nowIso = now.toISOString();
  const row = db.prepare(`SELECT 1 FROM generation_dispatch d JOIN generation_lease l ON l.trace_id=d.trace_id
    WHERE d.id=? AND d.trace_id=? AND d.state='claimed' AND d.owner_token=? AND d.claim_epoch=? AND d.lease_expires_at >= ?
      AND l.state='owned' AND l.owner_token=? AND l.fencing_epoch=? AND l.expires_at >= ?`).get(
    claim.dispatchId, claim.traceId, claim.ownerToken, claim.claimEpoch, nowIso,
    claim.ownerToken, claim.fencingEpoch, nowIso,
  );
  if (!row) throw new Error("generation_fence_lost");
}

const isoAfter = (now: Date, ms: number): string => new Date(now.getTime() + ms).toISOString();
const id = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** 手动 Idempotency-Key 只以 HMAC 形式持久化；调用方必须从受控 secret 提供 key。 */
export function hashIdempotencyKey(key: string, secret: string): string {
  return createHmac("sha256", secret).update(key, "utf8").digest("hex");
}

export type ManualDecisionResult =
  | { kind: "accepted"; traceId: string; requestId: string }
  | { kind: "replayed"; traceId: string; requestId: string }
  | { kind: "conflict"; activeTraceId: string }
  | { kind: "not_found" };

/**
 * 将一次人工规划决定与业务改动、audit_log、不可变 revision 及 trace event 一起提交。
 *
 * 人工操作是同步且短暂的，不进入 dispatch worker；但仍保留 request / lease，从而使同一
 * Idempotency-Key 的网络重放返回原 trace，而不是覆盖一次已经审计过的决定。
 */
export function recordManualDecision(
  db: DB,
  input: {
    entity: Pick<EntityRef, "type" | "locator">;
    output: () => EntityRef | null;
    previous?: EntityRef;
    topicId?: string | null;
    stage: "human_review" | "direction_change";
    terminalEvent: "manual_decided" | "config_changed";
    action: string;
    actorId: string;
    detail: Record<string, unknown>;
    snapshot: () => Record<string, unknown> | null;
    mutate: () => boolean;
    idempotencyKeyHash: string;
    now?: Date;
  },
): ManualDecisionResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const replaySince = isoAfter(now, -DAY_MS);
  const entity = entityKey(input.entity);
  const activeKey = `manual_decision:${entity}`;
  const notFound = Symbol("manual_decision_not_found");

  try {
  return db.transaction((): ManualDecisionResult => {
    const replay = db.prepare(`SELECT id,trace_id FROM generation_trace_request
      WHERE idempotency_key_hash=? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
      .get(input.idempotencyKeyHash, replaySince) as { id: string; trace_id: string } | undefined;
    if (replay) return { kind: "replayed", traceId: replay.trace_id, requestId: replay.id };

    const active = db.prepare("SELECT trace_id FROM generation_lease WHERE active_key=? AND state IN ('reserved','owned') LIMIT 1")
      .get(activeKey) as { trace_id: string } | undefined;
    if (active) return { kind: "conflict", activeTraceId: active.trace_id };

    const sequence = (db.prepare("SELECT COUNT(*) AS count FROM generation_trace_request WHERE idempotency_key_hash=?")
      .get(input.idempotencyKeyHash) as { count: number }).count + 1;
    const traceId = id("trace");
    const requestId = id("trace_req");
    const leaseId = id("lease");
    const scopeKey = `manual_decision:${entity}:${input.idempotencyKeyHash}:${sequence}`;
    db.prepare(`INSERT INTO generation_trace
      (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES (@id,'manual_decision','api',@topic_id,'running',@completion_policy,'complete',@runtime_version,'{}',@started_at)`).run({
      id: traceId, topic_id: input.topicId ?? null,
      completion_policy: JSON.stringify({ schema_version: 1, execution_kind: "event_only", required_stages: [input.stage] }),
      runtime_version: runtimeVersionAt(db, nowIso), started_at: nowIso,
    });
    db.prepare(`INSERT INTO generation_trace_request
      (id,scope_key,active_key,idempotency_key_hash,request_sequence,trace_id,state,retained_until,created_at)
      VALUES (@id,@scope_key,@active_key,@hash,@sequence,@trace_id,'accepted',@retained_until,@created_at)`).run({
      id: requestId, scope_key: scopeKey, active_key: activeKey, hash: input.idempotencyKeyHash,
      sequence, trace_id: traceId, retained_until: isoAfter(now, REQUEST_RETENTION_MS), created_at: nowIso,
    });
    db.prepare("UPDATE generation_trace SET request_id=? WHERE id=?").run(requestId, traceId);
    db.prepare(`INSERT INTO generation_lease (id,active_key,scope_key,trace_id,state,fencing_epoch,created_at)
      VALUES (@id,@active_key,@scope_key,@trace_id,'reserved',0,@created_at)`).run({
      id: leaseId, active_key: activeKey, scope_key: scopeKey, trace_id: traceId, created_at: nowIso,
    });

    appendGenerationEvent(db, {
      trace_id: traceId, stage: input.stage, event_type: "started", actor_type: "user", actor_id: input.actorId,
      input_refs: input.previous ? [input.previous] : [], context_completeness: "complete", occurred_at: nowIso,
    });
    if (!input.mutate()) throw notFound;
    const snapshot = input.snapshot();
    const output = input.output();
    if (!snapshot || !output) throw notFound;
    const auditLogId = appendAudit(db, { actor: input.actorId, action: input.action, target: entity, detail: input.detail });
    captureRevision(db, { entity_type: output.type, entity_key: entity, revision: output.revision, snapshot, captured_at: nowIso });
    appendGenerationEvent(db, {
      trace_id: traceId, stage: input.stage, event_type: input.terminalEvent, actor_type: "user", actor_id: input.actorId,
      audit_log_id: auditLogId, input_refs: input.previous ? [input.previous] : [], output_refs: [output],
      context_completeness: "complete", occurred_at: nowIso,
    });
    db.prepare("UPDATE generation_trace SET status='done',ended_at=?,summary=? WHERE id=?").run(nowIso, JSON.stringify({ action: input.action }), traceId);
    db.prepare("UPDATE generation_trace_request SET state='terminal' WHERE id=?").run(requestId);
    db.prepare("UPDATE generation_lease SET state='released',released_at=? WHERE id=?").run(nowIso, leaseId);
    return { kind: "accepted", traceId, requestId };
  })();
  } catch (error) {
    if (error === notFound) return { kind: "not_found" };
    throw error;
  }
}

/** Deep Dive 的 202 原子受理。 */
export function createDeepDiveTraceRequest(
  db: DB,
  input: { topicId: string; idempotencyKeyHash: string; planning: boolean; now?: Date },
): TraceRequestResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const replaySince = isoAfter(now, -DAY_MS);

  return db.transaction((): TraceRequestResult => {
    const replay = db.prepare(
      `SELECT id, trace_id FROM generation_trace_request
       WHERE idempotency_key_hash=@hash AND created_at >= @replay_since
       ORDER BY created_at DESC LIMIT 1`,
    ).get({ hash: input.idempotencyKeyHash, replay_since: replaySince }) as { id: string; trace_id: string } | undefined;
    if (replay) return { kind: "replayed", requestId: replay.id, traceId: replay.trace_id };

    const activeKey = `topic_pipeline:${input.topicId}:deep_dive`;
    const active = db.prepare(
      "SELECT trace_id FROM generation_lease WHERE active_key=? AND state IN ('reserved','owned') LIMIT 1",
    ).get(activeKey) as { trace_id: string } | undefined;
    if (active) return { kind: "conflict", activeTraceId: active.trace_id };

    const sequence = (db.prepare(
      "SELECT COUNT(*) AS count FROM generation_trace_request WHERE idempotency_key_hash=?",
    ).get(input.idempotencyKeyHash) as { count: number }).count + 1;
    const traceId = id("trace");
    const requestId = id("trace_req");
    const dispatchId = id("dispatch");
    const leaseId = id("lease");
    const scopeKey = `report:${input.topicId}:deep_dive:manual:${input.idempotencyKeyHash}:${sequence}`;
    const runtimeVersion = runtimeVersionAt(db, nowIso);

    db.prepare(
      `INSERT INTO generation_trace
       (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at)
      VALUES (@id,'topic_pipeline','api',@topic_id,'running',@completion_policy,'complete',@runtime_version,'{}',@started_at)`,
    ).run({
      id: traceId,
      topic_id: input.topicId,
      completion_policy: JSON.stringify({ schema_version: 1, planning: input.planning }),
      runtime_version: runtimeVersion,
      started_at: nowIso,
    });
    db.prepare(
      `INSERT INTO generation_trace_request
       (id,scope_key,active_key,idempotency_key_hash,request_sequence,trace_id,state,retained_until,created_at)
       VALUES (@id,@scope_key,@active_key,@hash,@sequence,@trace_id,'accepted',@retained_until,@created_at)`,
    ).run({
      id: requestId, scope_key: scopeKey, active_key: activeKey, hash: input.idempotencyKeyHash,
      sequence, trace_id: traceId, retained_until: isoAfter(now, REQUEST_RETENTION_MS), created_at: nowIso,
    });
    db.prepare("UPDATE generation_trace SET request_id=? WHERE id=?").run(requestId, traceId);
    db.prepare(
      `INSERT INTO generation_lease
       (id,active_key,scope_key,trace_id,state,fencing_epoch,created_at)
       VALUES (@id,@active_key,@scope_key,@trace_id,'reserved',0,@created_at)`,
    ).run({ id: leaseId, active_key: activeKey, scope_key: scopeKey, trace_id: traceId, created_at: nowIso });
    db.prepare(
      `INSERT INTO generation_dispatch
       (id,request_id,trace_id,kind,payload,state,attempt,claim_epoch,created_at,updated_at)
       VALUES (@id,@request_id,@trace_id,'topic_pipeline',@payload,'queued',0,0,@created_at,@updated_at)`,
    ).run({
      id: dispatchId, request_id: requestId, trace_id: traceId,
      payload: JSON.stringify({ topic_id: input.topicId, planning: input.planning, report_type: "deep_dive", schema_version: 1 }),
      created_at: nowIso, updated_at: nowIso,
    });
    return { kind: "accepted", traceId, requestId };
  })();
}

/** Cron 的主题日报也必须先持久登记再由 worker 领取。scope_key 按 UTC 周期去重，
 * 避免同一日的重试或重复 cron 触发产生多份 Brief。 */
export function createScheduledTraceRequest(
  db: DB,
  input: {
    topicId: string;
    reportType: "brief" | "deep_dive" | "initial_digest";
    period: string;
    windowHours: number;
    items: number;
    now?: Date;
  },
): TraceRequestResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const scopeKey = `topic_pipeline:${input.topicId}:${input.reportType}:${input.period}`;
  const activeKey = `topic_pipeline:${input.topicId}:${input.reportType}`;

  return db.transaction((): TraceRequestResult => {
    const existing = db.prepare("SELECT id,trace_id FROM generation_trace_request WHERE scope_key=?").get(scopeKey) as { id: string; trace_id: string } | undefined;
    if (existing) return { kind: "replayed", traceId: existing.trace_id, requestId: existing.id };
    const active = db.prepare(
      "SELECT trace_id FROM generation_lease WHERE active_key=? AND state IN ('reserved','owned') LIMIT 1",
    ).get(activeKey) as { trace_id: string } | undefined;
    if (active) return { kind: "conflict", activeTraceId: active.trace_id };

    const traceId = id("trace");
    const requestId = id("trace_req");
    const dispatchId = id("dispatch");
    const leaseId = id("lease");
    const payload = {
      topic_id: input.topicId, planning: true, report_type: input.reportType,
      window_hours: input.windowHours, window_end: nowIso, items: input.items, schema_version: 1 as const,
    };
    const runtimeVersion = runtimeVersionAt(db, nowIso);
    db.prepare(
      `INSERT INTO generation_trace
       (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at)
       VALUES (@id,'topic_pipeline','cron',@topic_id,'running',@completion_policy,'complete',@runtime_version,'{}',@started_at)`,
    ).run({
      id: traceId, topic_id: input.topicId,
      completion_policy: JSON.stringify({ schema_version: 1, planning: true, report_type: input.reportType }),
      runtime_version: runtimeVersion,
      started_at: nowIso,
    });
    db.prepare(
      `INSERT INTO generation_trace_request
       (id,scope_key,active_key,request_sequence,trace_id,state,retained_until,created_at)
       VALUES (@id,@scope_key,@active_key,1,@trace_id,'accepted',@retained_until,@created_at)`,
    ).run({ id: requestId, scope_key: scopeKey, active_key: activeKey, trace_id: traceId, retained_until: isoAfter(now, REQUEST_RETENTION_MS), created_at: nowIso });
    db.prepare("UPDATE generation_trace SET request_id=? WHERE id=?").run(requestId, traceId);
    db.prepare(
      `INSERT INTO generation_lease (id,active_key,scope_key,trace_id,state,fencing_epoch,created_at)
       VALUES (@id,@active_key,@scope_key,@trace_id,'reserved',0,@created_at)`,
    ).run({ id: leaseId, active_key: activeKey, scope_key: scopeKey, trace_id: traceId, created_at: nowIso });
    db.prepare(
      `INSERT INTO generation_dispatch
       (id,request_id,trace_id,kind,payload,state,attempt,claim_epoch,created_at,updated_at)
       VALUES (@id,@request_id,@trace_id,'topic_pipeline',@payload,'queued',0,0,@created_at,@updated_at)`,
    ).run({ id: dispatchId, request_id: requestId, trace_id: traceId, payload: JSON.stringify(payload), created_at: nowIso, updated_at: nowIso });
    return { kind: "accepted", traceId, requestId };
  })();
}

function sourceCollectScopeKey(sourceId: string, now: Date): string {
  return `source_collect:${sourceId}:${now.toISOString().slice(0, 13)}`;
}

/**
 * 定时来源采集的同步 trace factory。
 *
 * 每来源、每 UTC 小时只登记一个 logical request；执行前由 claimSourceCollectTrace 取得 owned lease，
 * 因此重入 cron 不会把同一来源的 Content 更新伪装成两条独立采集事实。
 */
export function createScheduledSourceCollectTrace(
  db: DB,
  input: { sourceId: string; now?: Date },
): SourceCollectTraceRequestResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const scopeKey = sourceCollectScopeKey(input.sourceId, now);
  const activeKey = `source_collect:${input.sourceId}`;

  return db.transaction((): SourceCollectTraceRequestResult => {
    const existing = db.prepare("SELECT trace_id FROM generation_trace_request WHERE scope_key=?").get(scopeKey) as { trace_id: string } | undefined;
    if (existing) return { kind: "replayed", traceId: existing.trace_id };
    // source_collect 是同步路径，没有 queued worker 在重启后自动领走 reserved lease。
    // 因此先终结已过期的源 trace，既保留失败事实，又不会让一次进程中断永久封死该来源。
    const stale = db.prepare(`SELECT trace_id FROM generation_lease
      WHERE active_key=? AND state IN ('reserved','owned') AND expires_at IS NOT NULL AND expires_at < ?`).all(activeKey, nowIso) as { trace_id: string }[];
    for (const row of stale) {
      db.prepare("UPDATE generation_trace SET status='failed',ended_at=?,summary=? WHERE id=? AND status='running'").run(
        nowIso, JSON.stringify({ reason_code: "source_collect_lease_expired" }), row.trace_id,
      );
      db.prepare("UPDATE generation_trace_request SET state='terminal' WHERE trace_id=?").run(row.trace_id);
      db.prepare("UPDATE generation_lease SET state='released',released_at=?,expires_at=NULL WHERE trace_id=? AND state IN ('reserved','owned')").run(nowIso, row.trace_id);
    }
    const active = db.prepare(
      "SELECT trace_id FROM generation_lease WHERE active_key=? AND state IN ('reserved','owned') LIMIT 1",
    ).get(activeKey) as { trace_id: string } | undefined;
    if (active) return { kind: "conflict", activeTraceId: active.trace_id };

    const traceId = id("trace");
    const requestId = id("trace_req");
    const leaseId = id("lease");
    db.prepare(
      `INSERT INTO generation_trace
       (id,scope_kind,trigger_kind,source_id,status,completion_policy,coverage,runtime_version,summary,started_at)
       VALUES (@id,'source_collect','cron',@source_id,'running',@completion_policy,'complete',@runtime_version,'{}',@started_at)`,
    ).run({
      id: traceId,
      source_id: input.sourceId,
      completion_policy: JSON.stringify({ schema_version: 1, execution_kind: "sync", required_stages: ["collect", "normalize"] }),
      runtime_version: runtimeVersionAt(db, nowIso),
      started_at: nowIso,
    });
    db.prepare(
      `INSERT INTO generation_trace_request
       (id,scope_key,active_key,request_sequence,trace_id,state,retained_until,created_at)
       VALUES (@id,@scope_key,@active_key,1,@trace_id,'accepted',@retained_until,@created_at)`,
    ).run({ id: requestId, scope_key: scopeKey, active_key: activeKey, trace_id: traceId, retained_until: isoAfter(now, REQUEST_RETENTION_MS), created_at: nowIso });
    db.prepare("UPDATE generation_trace SET request_id=? WHERE id=?").run(requestId, traceId);
    db.prepare(
      `INSERT INTO generation_lease (id,active_key,scope_key,trace_id,state,fencing_epoch,expires_at,created_at)
       VALUES (@id,@active_key,@scope_key,@trace_id,'reserved',0,@expires_at,@created_at)`,
    ).run({ id: leaseId, active_key: activeKey, scope_key: scopeKey, trace_id: traceId, expires_at: isoAfter(now, LEASE_TTL_MS), created_at: nowIso });
    return { kind: "accepted", traceId };
  })();
}

/** 本地旧库/未执行 migration runner 的兼容探针。生产 writer 由 PROVENANCE_SCHEMA_REQUIRED fail-closed，
 * 此处只让历史单测与明确的非严格本地开发保留原有采集行为，绝不把“缺表”伪装成采集失败。 */
export function sourceCollectTracingAvailable(db: DB): boolean {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('generation_trace_request','generation_lease','generation_event','provenance_revision')`).all() as { name: string }[];
  if (tables.length !== 4) return false;
  return (db.prepare("PRAGMA table_info(generation_trace)").all() as { name: string }[])
    .some((column) => column.name === "source_id");
}

/** 同步采集取得 lease 后才允许创建 root ingest Run 或写任何 provenance/business fact。 */
export function claimSourceCollectTrace(db: DB, traceId: string, now: Date = new Date()): SourceCollectClaim | null {
  const nowIso = now.toISOString();
  return db.transaction((): SourceCollectClaim | null => {
    const lease = db.prepare(`SELECT fencing_epoch FROM generation_lease l
      JOIN generation_trace t ON t.id=l.trace_id
      WHERE l.trace_id=? AND t.scope_kind='source_collect' AND l.state='reserved' AND l.expires_at >= ?`).get(traceId, nowIso) as { fencing_epoch: number } | undefined;
    if (!lease) return null;
    const ownerToken = id("owner");
    const fencingEpoch = lease.fencing_epoch + 1;
    const expiresAt = isoAfter(now, LEASE_TTL_MS);
    const updated = db.prepare(`UPDATE generation_lease
      SET state='owned',owner_token=@owner_token,fencing_epoch=@fencing_epoch,heartbeat_at=@now,expires_at=@expires_at
      WHERE trace_id=@trace_id AND state='reserved' AND expires_at >= @now`).run({ trace_id: traceId, owner_token: ownerToken, fencing_epoch: fencingEpoch, now: nowIso, expires_at: expiresAt });
    if (updated.changes !== 1) return null;
    return { traceId, ownerToken, fencingEpoch };
  })();
}

export function assertSourceCollectClaim(db: DB, claim: SourceCollectClaim, now: Date = new Date()): void {
  const owned = db.prepare(`SELECT 1 FROM generation_lease
    WHERE trace_id=? AND state='owned' AND owner_token=? AND fencing_epoch=? AND expires_at >= ?`).get(
    claim.traceId, claim.ownerToken, claim.fencingEpoch, now.toISOString(),
  );
  if (!owned) throw new Error("source_collect_fence_lost");
}

export function heartbeatSourceCollectTrace(db: DB, claim: SourceCollectClaim, now: Date = new Date()): boolean {
  const nowIso = now.toISOString();
  return db.prepare(`UPDATE generation_lease SET heartbeat_at=@now,expires_at=@expires_at
    WHERE trace_id=@trace_id AND state='owned' AND owner_token=@owner_token AND fencing_epoch=@fencing_epoch AND expires_at >= @now`).run({
    trace_id: claim.traceId, owner_token: claim.ownerToken, fencing_epoch: claim.fencingEpoch,
    now: nowIso, expires_at: isoAfter(now, LEASE_TTL_MS),
  }).changes === 1;
}

/** root_run_id 一经绑定不得替换；防止重入或失联 owner 把另一个 ingest Run 伪装成同一采集根。 */
export function bindSourceCollectRootRun(db: DB, claim: SourceCollectClaim, runId: string): void {
  assertSourceCollectClaim(db, claim);
  const updated = db.prepare("UPDATE generation_trace SET root_run_id=? WHERE id=? AND root_run_id IS NULL").run(runId, claim.traceId);
  if (updated.changes === 0) {
    const row = db.prepare("SELECT root_run_id FROM generation_trace WHERE id=?").get(claim.traceId) as { root_run_id: string | null } | undefined;
    if (row?.root_run_id !== runId) throw new Error("source_collect_root_run_already_bound");
  }
}

/** 同步 trace 的终态与 request/lease 一起提交；失败摘要不含 URL、正文或原始错误栈。 */
export function finishSourceCollectTrace(
  db: DB,
  claim: SourceCollectClaim,
  outcome: { status: "done" | "failed"; summary: Record<string, unknown> },
  now: Date = new Date(),
): boolean {
  const nowIso = now.toISOString();
  return db.transaction(() => {
    const owned = db.prepare(`SELECT 1 FROM generation_lease
      WHERE trace_id=? AND state='owned' AND owner_token=? AND fencing_epoch=? AND expires_at >= ?`).get(
      claim.traceId, claim.ownerToken, claim.fencingEpoch, nowIso,
    );
    if (!owned) return false;
    db.prepare("UPDATE generation_trace SET status=?,ended_at=?,summary=? WHERE id=?").run(
      outcome.status, nowIso, JSON.stringify(outcome.summary), claim.traceId,
    );
    db.prepare("UPDATE generation_trace_request SET state='terminal' WHERE trace_id=?").run(claim.traceId);
    db.prepare(`UPDATE generation_lease SET state='released',released_at=@now,expires_at=NULL
      WHERE trace_id=@trace_id AND state='owned' AND owner_token=@owner_token AND fencing_epoch=@fencing_epoch`).run({
      trace_id: claim.traceId, owner_token: claim.ownerToken, fencing_epoch: claim.fencingEpoch, now: nowIso,
    });
    return true;
  })();
}

/**
 * 对失败的 durable topic pipeline 新建一条完整重跑 trace。
 *
 * 原 trace 保持 terminal，新的 request/lease/dispatch 通过 retry_of_trace_id 建立审计链；
 * 绝不把失败的 dispatch 改回 queued，以免覆盖既有失败事实或绕过当日 cron 去重。
 */
export function retryFailedTraceRequest(
  db: DB,
  input: { traceId: string; idempotencyKeyHash: string; now?: Date },
): RetryTraceRequestResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const replaySince = isoAfter(now, -DAY_MS);

  return db.transaction((): RetryTraceRequestResult => {
    const original = db.prepare(`SELECT t.id,t.scope_kind,t.topic_id,t.status,t.completion_policy,t.coverage,t.started_at,
        r.state AS request_state,r.active_key,d.payload
      FROM generation_trace t
      JOIN generation_trace_request r ON r.trace_id=t.id
      JOIN generation_dispatch d ON d.trace_id=t.id
      WHERE t.id=?`).get(input.traceId) as
      | { id: string; scope_kind: string; topic_id: string | null; status: string; completion_policy: string; coverage: string; started_at: string; request_state: string; active_key: string; payload: string }
      | undefined;
    if (!original) return { kind: "not_found" };
    if (original.status !== "failed" || original.request_state !== "terminal" || !original.topic_id || original.scope_kind !== "topic_pipeline") {
      return { kind: "not_retryable", status: original.status, requestState: original.request_state };
    }

    const replay = db.prepare(`SELECT r.id,r.trace_id FROM generation_trace_request r
      JOIN generation_trace t ON t.id=r.trace_id
      WHERE t.retry_of_trace_id=@retry_of AND r.idempotency_key_hash=@hash AND r.created_at >= @replay_since
      ORDER BY r.created_at DESC LIMIT 1`).get({ retry_of: original.id, hash: input.idempotencyKeyHash, replay_since: replaySince }) as { id: string; trace_id: string } | undefined;
    if (replay) return { kind: "replayed", requestId: replay.id, traceId: replay.trace_id };

    const active = db.prepare(
      "SELECT trace_id FROM generation_lease WHERE active_key=? AND state IN ('reserved','owned') LIMIT 1",
    ).get(original.active_key) as { trace_id: string } | undefined;
    if (active) return { kind: "conflict", activeTraceId: active.trace_id };

    const sequence = (db.prepare(`SELECT COUNT(*) AS count FROM generation_trace_request r
      JOIN generation_trace t ON t.id=r.trace_id
      WHERE t.retry_of_trace_id=? AND r.idempotency_key_hash=?`).get(original.id, input.idempotencyKeyHash) as { count: number }).count + 1;
    const traceId = id("trace");
    const requestId = id("trace_req");
    const dispatchId = id("dispatch");
    const leaseId = id("lease");
    const scopeKey = `retry:${original.id}:${input.idempotencyKeyHash}:${sequence}`;
    const runtimeVersion = runtimeVersionAt(db, nowIso);
    const retryPayload = JSON.parse(original.payload) as Record<string, unknown>;
    // 为上线前的 payload 补回冻结窗口：其 trace.started_at 正是原调度受理的时间点。
    if (typeof retryPayload.window_hours === "number" && typeof retryPayload.window_end !== "string") {
      retryPayload.window_end = original.started_at;
    }

    db.prepare(`INSERT INTO generation_trace
      (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at,retry_of_trace_id)
      VALUES (@id,@scope_kind,'retry',@topic_id,'running',@completion_policy,@coverage,@runtime_version,'{}',@started_at,@retry_of_trace_id)`).run({
      id: traceId, scope_kind: original.scope_kind, topic_id: original.topic_id,
      completion_policy: original.completion_policy, coverage: original.coverage,
      runtime_version: runtimeVersion, started_at: nowIso, retry_of_trace_id: original.id,
    });
    db.prepare(`INSERT INTO generation_trace_request
      (id,scope_key,active_key,idempotency_key_hash,request_sequence,trace_id,state,retained_until,created_at)
      VALUES (@id,@scope_key,@active_key,@hash,@sequence,@trace_id,'accepted',@retained_until,@created_at)`).run({
      id: requestId, scope_key: scopeKey, active_key: original.active_key, hash: input.idempotencyKeyHash,
      sequence, trace_id: traceId, retained_until: isoAfter(now, REQUEST_RETENTION_MS), created_at: nowIso,
    });
    db.prepare("UPDATE generation_trace SET request_id=? WHERE id=?").run(requestId, traceId);
    db.prepare(`INSERT INTO generation_lease
      (id,active_key,scope_key,trace_id,state,fencing_epoch,created_at)
      VALUES (@id,@active_key,@scope_key,@trace_id,'reserved',0,@created_at)`).run({
      id: leaseId, active_key: original.active_key, scope_key: scopeKey, trace_id: traceId, created_at: nowIso,
    });
    db.prepare(`INSERT INTO generation_dispatch
      (id,request_id,trace_id,kind,payload,state,attempt,claim_epoch,created_at,updated_at)
      VALUES (@id,@request_id,@trace_id,'topic_pipeline',@payload,'queued',0,0,@created_at,@updated_at)`).run({
      id: dispatchId, request_id: requestId, trace_id: traceId, payload: JSON.stringify(retryPayload),
      created_at: nowIso, updated_at: nowIso,
    });
    return { kind: "accepted", traceId, requestId };
  })();
}

/** 领取一个 queued 或失联的 dispatch；外部调用必须在返回 claim 后才可开始。 */
export function claimNextGenerationDispatch(db: DB, now: Date = new Date()): DispatchClaim | null {
  const nowIso = now.toISOString();
  return db.transaction((): DispatchClaim | null => {
    const candidate = db.prepare(
      `SELECT d.id, d.trace_id, d.payload, d.claim_epoch, l.fencing_epoch, t.root_run_id
       FROM generation_dispatch d JOIN generation_lease l ON l.trace_id=d.trace_id JOIN generation_trace t ON t.id=d.trace_id
       WHERE (d.state='queued' OR (d.state='claimed' AND d.lease_expires_at < @now))
         AND (l.state='reserved' OR (l.state='owned' AND l.expires_at < @now))
       ORDER BY d.created_at ASC LIMIT 1`,
    ).get({ now: nowIso }) as { id: string; trace_id: string; payload: string; claim_epoch: number; fencing_epoch: number; root_run_id: string | null } | undefined;
    if (!candidate) return null;
    const ownerToken = id("owner");
    const claimEpoch = candidate.claim_epoch + 1;
    const fencingEpoch = candidate.fencing_epoch + 1;
    const expiresAt = isoAfter(now, LEASE_TTL_MS);
    const dispatch = db.prepare(
      `UPDATE generation_dispatch
       SET state='claimed',attempt=attempt+1,claim_epoch=@claim_epoch,owner_token=@owner_token,
           claimed_at=@now,heartbeat_at=@now,lease_expires_at=@expires_at,updated_at=@now
       WHERE id=@id AND (state='queued' OR (state='claimed' AND lease_expires_at < @now))`,
    ).run({ id: candidate.id, claim_epoch: claimEpoch, owner_token: ownerToken, now: nowIso, expires_at: expiresAt });
    if (dispatch.changes !== 1) return null;
    const lease = db.prepare(
      `UPDATE generation_lease SET state='owned',owner_token=@owner_token,fencing_epoch=@fencing_epoch,
       heartbeat_at=@now,expires_at=@expires_at
       WHERE trace_id=@trace_id AND (state='reserved' OR (state='owned' AND expires_at < @now))`,
    ).run({ trace_id: candidate.trace_id, owner_token: ownerToken, fencing_epoch: fencingEpoch, now: nowIso, expires_at: expiresAt });
    if (lease.changes !== 1) throw new Error("dispatch claim lost its lease atomically");
    const rootRunId = candidate.root_run_id ?? id("run");
    if (!candidate.root_run_id) {
      const payload = JSON.parse(candidate.payload) as DispatchClaim["payload"];
      db.prepare(
        `INSERT INTO run(id,kind,target,status,started_at,trace_id) VALUES (@id,'analyze',@target,'running',@started_at,@trace_id)`,
      ).run({ id: rootRunId, target: JSON.stringify({ topic_id: payload.topic_id }), started_at: nowIso, trace_id: candidate.trace_id });
      db.prepare("UPDATE generation_trace SET root_run_id=? WHERE id=? AND root_run_id IS NULL").run(rootRunId, candidate.trace_id);
    }
    return {
      dispatchId: candidate.id, traceId: candidate.trace_id, ownerToken, claimEpoch, fencingEpoch,
      rootRunId,
      payload: JSON.parse(candidate.payload) as DispatchClaim["payload"],
    };
  })();
}

/** worker 每 30 秒续租；返回 false 表示该 owner 已被接管，调用方必须停止提交。 */
export function heartbeatGenerationDispatch(db: DB, claim: DispatchClaim, now: Date = new Date()): boolean {
  const nowIso = now.toISOString();
  const expiresAt = isoAfter(now, LEASE_TTL_MS);
  return db.transaction(() => {
    const dispatch = db.prepare(
      `UPDATE generation_dispatch SET heartbeat_at=@now,lease_expires_at=@expires_at,updated_at=@now
       WHERE id=@id AND state='claimed' AND owner_token=@owner AND claim_epoch=@claim_epoch AND lease_expires_at >= @now`,
    ).run({ id: claim.dispatchId, owner: claim.ownerToken, claim_epoch: claim.claimEpoch, now: nowIso, expires_at: expiresAt });
    const lease = db.prepare(
      `UPDATE generation_lease SET heartbeat_at=@now,expires_at=@expires_at
       WHERE trace_id=@trace_id AND state='owned' AND owner_token=@owner AND fencing_epoch=@fencing_epoch AND expires_at >= @now`,
    ).run({ trace_id: claim.traceId, owner: claim.ownerToken, fencing_epoch: claim.fencingEpoch, now: nowIso, expires_at: expiresAt });
    return dispatch.changes === 1 && lease.changes === 1;
  })();
}

/** 仅当前 claim 可结束 dispatch/trace 并释放 reservation。 */
export function finishGenerationDispatch(
  db: DB,
  claim: DispatchClaim,
  outcome: { status: "done" | "failed"; error?: { reason_code: string; message: string } },
  now: Date = new Date(),
): boolean {
  const nowIso = now.toISOString();
  return db.transaction(() => {
    const claimed = db.prepare(
      `SELECT 1 FROM generation_dispatch WHERE id=? AND state='claimed' AND owner_token=? AND claim_epoch=? AND lease_expires_at >= ?`,
    ).get(claim.dispatchId, claim.ownerToken, claim.claimEpoch, nowIso);
    if (!claimed) return false;
    const state = outcome.status === "done" ? "done" : "failed";
    db.prepare(
      `UPDATE generation_dispatch SET state=@state,last_error=@error,updated_at=@now WHERE id=@id`,
    ).run({ id: claim.dispatchId, state, error: outcome.error ? JSON.stringify(outcome.error) : null, now: nowIso });
    db.prepare(
      `UPDATE generation_trace SET status=@status,ended_at=@now,summary=@summary WHERE id=@trace_id`,
    ).run({ trace_id: claim.traceId, status: outcome.status, now: nowIso, summary: JSON.stringify(outcome.error ?? {}) });
    if (outcome.status === "failed") {
      db.prepare(
        `UPDATE run SET status='failed',ended_at=@now,error=@error
         WHERE id=@id AND status='running'`,
      ).run({ id: claim.rootRunId, now: nowIso, error: JSON.stringify(outcome.error ?? {}) });
    }
    db.prepare("UPDATE generation_trace_request SET state='terminal' WHERE trace_id=?").run(claim.traceId);
    db.prepare(
      `UPDATE generation_lease SET state='released',released_at=@now,expires_at=NULL
       WHERE trace_id=@trace_id AND state='owned' AND owner_token=@owner AND fencing_epoch=@fencing_epoch`,
    ).run({ trace_id: claim.traceId, owner: claim.ownerToken, fencing_epoch: claim.fencingEpoch, now: nowIso });
    return true;
  })();
}

export function getGenerationTraceStatus(db: DB, traceId: string): Record<string, unknown> | null {
  return db.prepare(
    `SELECT t.id AS trace_id,t.request_id,t.status,t.root_run_id,t.topic_id,t.source_id,t.scope_kind,t.trigger_kind,t.started_at,t.ended_at,t.coverage,t.runtime_version,
      d.state AS dispatch_state,d.attempt,d.claimed_at,d.lease_expires_at,d.last_error,
      (SELECT image_digest FROM deployment_record dr WHERE dr.deployed_at <= t.started_at ORDER BY dr.deployed_at DESC,dr.id DESC LIMIT 1) AS deployment_image_digest,
      (SELECT git_sha FROM deployment_record dr WHERE dr.deployed_at <= t.started_at ORDER BY dr.deployed_at DESC,dr.id DESC LIMIT 1) AS deployment_git_sha
     FROM generation_trace t LEFT JOIN generation_dispatch d ON d.trace_id=t.id WHERE t.id=?`,
  ).get(traceId) as Record<string, unknown> | undefined ?? null;
}

/** 管理员时间线的最小安全读模型：只给阶段、稳定原因码及实体定位键，绝不展开正文、URL、错误消息或 snapshot。 */
export function listGenerationTraceTimeline(db: DB, traceId: string): Array<Record<string, unknown>> {
  const events = db.prepare(`SELECT id,sequence,stage,event_type,attempt,occurred_at,reason_code,error,metrics,context_completeness
    FROM generation_event WHERE trace_id=? ORDER BY sequence`).all(traceId) as Array<Record<string, unknown>>;
  return events.map((event) => {
    const refs = db.prepare(`SELECT entity_type,entity_key,revision,role,visibility_class FROM generation_entity_ref
      WHERE event_id=? ORDER BY role,entity_type,entity_key`).all(event.id) as Record<string, unknown>[];
    let errorReason: string | null = null;
    if (typeof event.error === "string") {
      try { const parsed = JSON.parse(event.error) as { reason_code?: unknown }; errorReason = typeof parsed.reason_code === "string" ? parsed.reason_code : "stage_failed"; }
      catch { errorReason = "stage_failed"; }
    }
    let metrics: Record<string, number> = {};
    if (typeof event.metrics === "string") {
      try {
        const parsed = JSON.parse(event.metrics) as Record<string, unknown>;
        // Timeline 是 admin read model，但仍只投影已登记的整数计数，避免把任意未来 metrics 外泄。
        const allowed = new Set(["input_content_count", "analysis_insight_count", "no_significant_event", "citation_total", "citation_pass", "citation_blocked", "citation_flagged", "citation_errored", "includable_insight_count", "releasable", "freshness_filtered_insight_count", "already_published_filtered_insight_count", "supplemental_candidate_count", "supplemental_published_insight_count", "published_insight_count", "published_citation_count", "candidate_count", "opportunity_count"]);
        for (const [key, value] of Object.entries(parsed)) {
          if (allowed.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) metrics[key] = value;
        }
      } catch { /* malformed legacy metric payload is intentionally hidden */ }
    }
    return {
      sequence: event.sequence, stage: event.stage, event_type: event.event_type, attempt: event.attempt,
      occurred_at: event.occurred_at, reason_code: event.reason_code ?? errorReason, context_completeness: event.context_completeness,
      metrics,
      refs: refs.map((ref) => ({ type: ref.entity_type, entity_key: ref.entity_key, revision: ref.revision, role: ref.role, visibility_class: ref.visibility_class })),
    };
  });
}

/** 已发布报告只通过 output ref 反查 trace；历史/未接入溯源的报告返回 null。 */
export function findGenerationTraceForReport(db: DB, reportId: string): string | null {
  return findGenerationTraceForEntity(db, { type: "report", locator: { kind: "id", id: reportId } });
}

/** 仅从 append-only output ref 定位某个实体最近一次产出或人工变更 trace。 */
export function findGenerationTraceForEntity(db: DB, ref: Pick<EntityRef, "type" | "locator">): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_entity_ref'").get()) return null;
  const key = entityKey(ref);
  const row = db.prepare(`SELECT trace_id FROM generation_entity_ref
    WHERE entity_type=? AND entity_key=? AND role='output' ORDER BY rowid DESC LIMIT 1`).get(ref.type, key) as { trace_id: string } | undefined;
  return row?.trace_id ?? null;
}

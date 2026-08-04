/** P0a generation provenance 的持久编排原语。
 *
 * 路由只负责写 request/trace/reservation/dispatch；任何实际执行都必须先经 worker claim。
 * 这里故意不调用 agent 或网络，确保 202 的可靠性边界仅依赖一个 SQLite 事务。 */
import { createHmac, randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import { entityKey } from "./provenance-facts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_RETENTION_MS = 100 * DAY_MS;
const LEASE_TTL_MS = 120_000;

export type TraceRequestResult =
  | { kind: "accepted"; traceId: string; requestId: string }
  | { kind: "replayed"; traceId: string; requestId: string }
  | { kind: "conflict"; activeTraceId: string };

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

    db.prepare(
      `INSERT INTO generation_trace
       (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at)
       VALUES (@id,'topic_pipeline','api',@topic_id,'running',@completion_policy,'complete','{}','{}',@started_at)`,
    ).run({
      id: traceId,
      topic_id: input.topicId,
      completion_policy: JSON.stringify({ schema_version: 1, planning: input.planning }),
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
      window_hours: input.windowHours, items: input.items, schema_version: 1 as const,
    };
    db.prepare(
      `INSERT INTO generation_trace
       (id,scope_kind,trigger_kind,topic_id,status,completion_policy,coverage,runtime_version,summary,started_at)
       VALUES (@id,'topic_pipeline','cron',@topic_id,'running',@completion_policy,'complete','{}','{}',@started_at)`,
    ).run({
      id: traceId, topic_id: input.topicId,
      completion_policy: JSON.stringify({ schema_version: 1, planning: true, report_type: input.reportType }),
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
    `SELECT t.id AS trace_id,t.request_id,t.status,t.root_run_id,t.started_at,t.ended_at,t.coverage,
      d.state AS dispatch_state,d.attempt,d.claimed_at,d.lease_expires_at,d.last_error
     FROM generation_trace t LEFT JOIN generation_dispatch d ON d.trace_id=t.id WHERE t.id=?`,
  ).get(traceId) as Record<string, unknown> | undefined ?? null;
}

/** 管理员时间线的最小安全读模型：只给阶段、稳定原因码及实体定位键，绝不展开正文、URL、错误消息或 snapshot。 */
export function listGenerationTraceTimeline(db: DB, traceId: string): Array<Record<string, unknown>> {
  const events = db.prepare(`SELECT id,sequence,stage,event_type,attempt,occurred_at,reason_code,error,context_completeness
    FROM generation_event WHERE trace_id=? ORDER BY sequence`).all(traceId) as Array<Record<string, unknown>>;
  return events.map((event) => {
    const refs = db.prepare(`SELECT entity_type,entity_key,revision,role,visibility_class FROM generation_entity_ref
      WHERE event_id=? ORDER BY role,entity_type,entity_key`).all(event.id) as Record<string, unknown>[];
    let errorReason: string | null = null;
    if (typeof event.error === "string") {
      try { const parsed = JSON.parse(event.error) as { reason_code?: unknown }; errorReason = typeof parsed.reason_code === "string" ? parsed.reason_code : "stage_failed"; }
      catch { errorReason = "stage_failed"; }
    }
    return {
      sequence: event.sequence, stage: event.stage, event_type: event.event_type, attempt: event.attempt,
      occurred_at: event.occurred_at, reason_code: event.reason_code ?? errorReason, context_completeness: event.context_completeness,
      refs: refs.map((ref) => ({ type: ref.entity_type, entity_key: ref.entity_key, revision: ref.revision, role: ref.role, visibility_class: ref.visibility_class })),
    };
  });
}

/** 已发布报告只通过 output ref 反查 trace；历史/未接入溯源的报告返回 null。 */
export function findGenerationTraceForReport(db: DB, reportId: string): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_entity_ref'").get()) return null;
  const key = entityKey({ type: "report", locator: { kind: "id", id: reportId } });
  const row = db.prepare(`SELECT trace_id FROM generation_entity_ref
    WHERE entity_type='report' AND entity_key=? AND role='output' ORDER BY rowid DESC LIMIT 1`).get(key) as { trace_id: string } | undefined;
  return row?.trace_id ?? null;
}

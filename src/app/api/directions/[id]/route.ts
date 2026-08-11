/** POST /api/directions/:id —— 方向状态由管理员显式校准；不会重新解释历史事实。 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { hashIdempotencyKey, recordManualDecision } from "../../../../lib/db/provenance.js";
import { topicDirectionRef, topicDirectionRevisionSnapshot } from "../../../../lib/db/provenance-revisions.js";
import { getTopicDirection, setTopicDirectionStatus, updateTopicDirection } from "../../../../lib/db/planning.js";
import { parseTopicDirectionInput } from "../../../../lib/planning/direction-input.js";
import type { TopicDirectionStatus } from "../../../../lib/types.js";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TopicDirectionStatus>(["active", "watching", "retired"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TopicDirectionStatus)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  const before = getTopicDirection(db, id);
  if (!before) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  let changed = null as ReturnType<typeof getTopicDirection>;
  const result = recordManualDecision(db, {
    entity: { type: "topic_direction", locator: { kind: "id", id } }, previous: topicDirectionRef(before), topicId: before.topic_id,
    stage: "direction_change", terminalEvent: "manual_decided", action: "topic_direction_status", actorId: actor.id,
    detail: { from_status: before.status, to_status: status },
    mutate: () => { if (!setTopicDirectionStatus(db, id, status as TopicDirectionStatus)) return false; changed = getTopicDirection(db, id); return !!changed; },
    snapshot: () => changed ? topicDirectionRevisionSnapshot(changed) : null,
    output: () => changed ? topicDirectionRef(changed, "output") : null,
    idempotencyKeyHash: hashIdempotencyKey(`topic_direction_status:${id}:${key}`, secret),
  });
  if (result.kind === "not_found") return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  if (result.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  return NextResponse.json({ ok: true, status, trace_id: result.traceId, replayed: result.kind === "replayed" });
}

/** PUT 完整编辑方向。前端必须带上读取时的 version，避免两个管理员静默覆盖彼此词表。 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null) as { direction?: unknown; expected_version?: unknown } | null;
  const direction = parseTopicDirectionInput(body?.direction);
  const expectedVersion = body?.expected_version;
  if (!direction || direction.id !== id || !Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) return NextResponse.json({ error: "invalid_direction_update" }, { status: 422 });
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  const before = getTopicDirection(db, id);
  if (!before) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  let changed = null as ReturnType<typeof getTopicDirection>;
  let conflictCurrent = null as ReturnType<typeof getTopicDirection>;
  const trace = recordManualDecision(db, {
    entity: { type: "topic_direction", locator: { kind: "id", id } }, previous: topicDirectionRef(before), topicId: before.topic_id,
    stage: "direction_change", terminalEvent: "config_changed", action: "topic_direction_update", actorId: actor.id,
    detail: { from_version: before.version, to_version: before.version + 1 },
    mutate: () => {
      const updated = updateTopicDirection(db, direction, expectedVersion as number);
      if (updated.kind !== "updated") { if (updated.kind === "conflict") conflictCurrent = updated.current; return false; }
      changed = updated.direction;
      return true;
    },
    snapshot: () => changed ? topicDirectionRevisionSnapshot(changed) : null,
    output: () => changed ? topicDirectionRef(changed, "output") : null,
    idempotencyKeyHash: hashIdempotencyKey(`topic_direction_update:${id}:${key}`, secret),
  });
  if (trace.kind === "not_found") {
    if (conflictCurrent) return NextResponse.json({ error: "direction_version_conflict", current: conflictCurrent }, { status: 409 });
    return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  }
  if (trace.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: trace.activeTraceId }, { status: 409 });
  const rulesChanged = !!before && ["match_terms", "adjacent_terms", "challenge_terms"].some((key) => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(direction[key as keyof typeof direction]));
  return NextResponse.json({ ok: true, direction: changed ?? getTopicDirection(db, id), rules_changed: rulesChanged, trace_id: trace.traceId, replayed: trace.kind === "replayed" });
}

/** POST /api/directions/:id/reproject —— 显式刷新已有线索映射，不触碰事实证据或人工状态。 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../lib/db/index.js";
import { getTopicDirection, reprojectTopicDirection } from "../../../../../lib/db/planning.js";
import { hashIdempotencyKey, recordManualDecision } from "../../../../../lib/db/provenance.js";
import { topicDirectionRef, topicDirectionRevisionSnapshot } from "../../../../../lib/db/provenance-revisions.js";

export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  const direction = getTopicDirection(db, id);
  if (!direction) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  let refreshed = 0;
  let stale = 0;
  const trace = recordManualDecision(db, {
    entity: { type: "topic_direction", locator: { kind: "id", id } }, previous: topicDirectionRef(direction), topicId: direction.topic_id,
    stage: "direction_change", terminalEvent: "manual_decided", action: "topic_direction_reproject", actorId: actor.id,
    detail: { version: direction.version },
    mutate: () => { const projected = reprojectTopicDirection(db, id); if (projected.kind !== "done") return false; refreshed = projected.refreshed; stale = projected.stale; return true; },
    snapshot: () => { const current = getTopicDirection(db, id); return current ? topicDirectionRevisionSnapshot(current) : null; },
    output: () => { const current = getTopicDirection(db, id); return current ? topicDirectionRef(current, "output") : null; },
    idempotencyKeyHash: hashIdempotencyKey(`topic_direction_reproject:${id}:${key}`, secret),
  });
  if (trace.kind === "not_found") return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  if (trace.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: trace.activeTraceId }, { status: 409 });
  return NextResponse.json({ ok: true, kind: "done", direction: getTopicDirection(db, id) ?? direction, refreshed, stale, trace_id: trace.traceId, replayed: trace.kind === "replayed" });
}

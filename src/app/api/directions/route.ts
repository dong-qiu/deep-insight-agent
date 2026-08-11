/** GET/POST /api/directions —— 方向档案的读接口与管理员创建接口。 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../lib/auth-guard.js";
import { getDb } from "../../../lib/db/index.js";
import { hashIdempotencyKey, recordManualDecision } from "../../../lib/db/provenance.js";
import { topicDirectionRef, topicDirectionRevisionSnapshot } from "../../../lib/db/provenance-revisions.js";
import { createTopicDirection, getTopicDirection, listTopicDirections } from "../../../lib/db/planning.js";
import { getTopic } from "../../../lib/db/repos.js";
import { parseTopicDirectionInput } from "../../../lib/planning/direction-input.js";

export const dynamic = "force-dynamic";

export function GET(req: Request): NextResponse {
  const sp = new URL(req.url).searchParams;
  return NextResponse.json({ items: listTopicDirections(getDb(), { topic: sp.get("topic") ?? undefined, includeRetired: sp.get("all") === "1" }) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const input = parseTopicDirectionInput(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "invalid_direction" }, { status: 422 });
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  if (!getTopic(db, input.topic_id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  if (getTopicDirection(db, input.id)) return NextResponse.json({ error: "direction_id_exists" }, { status: 409 });
  let direction = null as ReturnType<typeof getTopicDirection>;
  const result = recordManualDecision(db, {
    entity: { type: "topic_direction", locator: { kind: "id", id: input.id } }, topicId: input.topic_id,
    stage: "direction_change", terminalEvent: "config_changed", action: "topic_direction_create", actorId: actor.id,
    detail: { topic_id: input.topic_id },
    mutate: () => { direction = createTopicDirection(db, input); return !!direction; },
    snapshot: () => direction ? topicDirectionRevisionSnapshot(direction) : null,
    output: () => direction ? topicDirectionRef(direction, "output") : null,
    idempotencyKeyHash: hashIdempotencyKey(`topic_direction_create:${input.id}:${key}`, secret),
  });
  if (result.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  if (result.kind === "not_found") return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  if (result.kind === "replayed") return NextResponse.json({ status: "created", direction: getTopicDirection(db, input.id), trace_id: result.traceId, replayed: true });
  return NextResponse.json({ status: "created", direction, trace_id: result.traceId, replayed: false }, { status: 201 });
}

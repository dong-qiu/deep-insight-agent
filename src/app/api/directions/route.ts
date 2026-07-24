/** GET/POST /api/directions —— 方向档案的读接口与管理员创建接口。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../lib/auth-guard.js";
import { appendAudit } from "../../../lib/db/audit.js";
import { getDb } from "../../../lib/db/index.js";
import { createTopicDirection, getTopicDirection, listTopicDirections } from "../../../lib/db/planning.js";
import { getTopic } from "../../../lib/db/repos.js";
import { parseTopicDirectionInput } from "../../../lib/planning/direction-input.js";

export const dynamic = "force-dynamic";

export function GET(req: Request): NextResponse {
  const sp = new URL(req.url).searchParams;
  return NextResponse.json({ items: listTopicDirections(getDb(), { topic: sp.get("topic") ?? undefined, includeRetired: sp.get("all") === "1" }) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const input = parseTopicDirectionInput(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "invalid_direction" }, { status: 422 });
  const db = getDb();
  if (!getTopic(db, input.topic_id)) return NextResponse.json({ error: "topic_not_found" }, { status: 404 });
  if (getTopicDirection(db, input.id)) return NextResponse.json({ error: "direction_id_exists" }, { status: 409 });
  const direction = createTopicDirection(db, input);
  appendAudit(db, { action: "topic_direction_create", target: input.id, detail: { topic_id: input.topic_id } });
  return NextResponse.json({ status: "created", direction }, { status: 201 });
}

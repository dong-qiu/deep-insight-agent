/** POST /api/directions/preview —— 管理员在保存前预览近期线索的通道变化，不写数据库。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { getTopicDirection, previewTopicDirectionMapping } from "../../../../lib/db/planning.js";
import { listTechLeads } from "../../../../lib/db/tech-leads.js";
import { parseTopicDirectionInput } from "../../../../lib/planning/direction-input.js";

export const dynamic = "force-dynamic";
export async function POST(req: Request): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const direction = parseTopicDirectionInput((await req.json().catch(() => null) as { direction?: unknown } | null)?.direction);
  if (!direction) return NextResponse.json({ error: "invalid_direction" }, { status: 422 });
  const db = getDb();
  const current = getTopicDirection(db, direction.id);
  if (!current) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  if (current.topic_id !== direction.topic_id) return NextResponse.json({ error: "direction_topic_immutable" }, { status: 422 });
  const leads = listTechLeads(db, { topic: direction.topic_id, limit: 100 });
  const changes = previewTopicDirectionMapping(leads, current, direction);
  return NextResponse.json({ changes, scanned_leads: leads.length });
}

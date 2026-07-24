/** POST /api/directions/:id —— 方向状态由管理员显式校准；不会重新解释历史事实。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../lib/db/audit.js";
import { getDb } from "../../../../lib/db/index.js";
import { setTopicDirectionStatus } from "../../../../lib/db/planning.js";
import type { TopicDirectionStatus } from "../../../../lib/types.js";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TopicDirectionStatus>(["active", "watching", "retired"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TopicDirectionStatus)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const db = getDb();
  if (!setTopicDirectionStatus(db, id, status as TopicDirectionStatus)) return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  appendAudit(db, { action: "topic_direction_status", target: id, detail: { status } });
  return NextResponse.json({ ok: true, status });
}

/** POST /api/directions/:id/reproject —— 显式刷新已有线索映射，不触碰事实证据或人工状态。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../../lib/db/audit.js";
import { getDb } from "../../../../../lib/db/index.js";
import { reprojectTopicDirection } from "../../../../../lib/db/planning.js";

export const dynamic = "force-dynamic";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const db = getDb();
  const result = reprojectTopicDirection(db, id);
  if (result.kind === "not_found") return NextResponse.json({ error: "direction_not_found" }, { status: 404 });
  appendAudit(db, { action: "topic_direction_reproject", target: id, detail: { version: result.direction.version, refreshed: result.refreshed, stale: result.stale } });
  return NextResponse.json({ ok: true, ...result });
}

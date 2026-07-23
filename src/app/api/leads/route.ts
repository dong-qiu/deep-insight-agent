/** GET /api/leads —— 可溯源技术线索只读查询。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";
import { listTechLeads } from "../../../lib/db/tech-leads.js";

export const dynamic = "force-dynamic";

export function GET(req: Request): NextResponse {
  const sp = new URL(req.url).searchParams;
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
  return NextResponse.json({
    items: listTechLeads(getDb(), { topic: sp.get("topic") ?? undefined, includeDismissed: sp.get("all") === "1", since }),
  });
}

/** GET /api/opportunities —— 技术机会候选查询；事实证据仍需沿 lead 端点下钻。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";
import { listTechnologyOpportunities } from "../../../lib/db/planning.js";
import type { OpportunityLane } from "../../../lib/types.js";

export const dynamic = "force-dynamic";
const LANES = new Set<OpportunityLane>(["core", "adjacent", "horizon", "challenge"]);

export function GET(req: Request): NextResponse {
  const sp = new URL(req.url).searchParams;
  const lane = sp.get("lane");
  return NextResponse.json({
    items: listTechnologyOpportunities(getDb(), {
      topic: sp.get("topic") ?? undefined,
      direction: sp.get("direction") ?? undefined,
      lane: lane && LANES.has(lane as OpportunityLane) ? lane as OpportunityLane : undefined,
      includeClosed: sp.get("all") === "1",
    }),
  });
}

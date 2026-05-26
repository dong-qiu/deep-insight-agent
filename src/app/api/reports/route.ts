import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";
import { listReportIndex, searchReports } from "../../../lib/db/reports.js";

export const dynamic = "force-dynamic";

/** GET /api/reports?q=keyword —— 列出报告索引；带 q 则走 FTS5 检索。 */
export function GET(req: Request) {
  const db = getDb();
  const q = new URL(req.url).searchParams.get("q");
  const all = listReportIndex(db);
  const items = q ? all.filter((r) => searchReports(db, q).includes(r.report_id)) : all;
  return NextResponse.json({ count: items.length, items });
}

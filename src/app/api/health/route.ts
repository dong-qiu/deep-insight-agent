/** GET /api/health —— 存活探针（Docker HEALTHCHECK / 反向代理用）。
 *  轻量查一次库以确认 DB 可达，不触发任何 LLM 调用。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb();
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM report").get() as { c: number };
    return NextResponse.json({ status: "ok", reports: c });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}

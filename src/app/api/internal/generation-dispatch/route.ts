import { NextResponse } from "next/server";
import { runGenerationDispatchOnce } from "../../../../lib/agents/generation-dispatch.js";
import { getDb } from "../../../../lib/db/index.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 仅 docker 内独立 worker 调用；不使用用户 session 作为机器间认证。 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.DISPATCH_WORKER_SECRET;
  if (!secret) return NextResponse.json({ error: "dispatch_worker_not_configured" }, { status: 503 });
  if (req.headers.get("x-dispatch-worker-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await runGenerationDispatchOnce(getDb());
  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db/index.js";
import { getGenerationDispatchHealth } from "../../../../../lib/db/provenance.js";
import { hasDispatchWorkerSecret } from "../../../../../lib/runtime/dispatch-auth.js";
import { maybeAlertGenerationDispatchHealth } from "../../../../../lib/runtime/generation-dispatch-health.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Worker-only readiness endpoint.  Public /api/health remains an app/DB
 * liveness probe so dispatch backlog does not restart the web process. */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.DISPATCH_WORKER_SECRET;
  if (!secret) return NextResponse.json({ error: "dispatch_worker_not_configured" }, { status: 503 });
  if (!hasDispatchWorkerSecret(req.headers.get("x-dispatch-worker-secret"), secret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const health = getGenerationDispatchHealth(getDb());
    maybeAlertGenerationDispatchHealth(health);
    return NextResponse.json(health, { status: health.status === "not_ready" ? 503 : 200 });
  } catch {
    return NextResponse.json({ status: "not_ready", error: "dispatch_health_unavailable" }, { status: 503 });
  }
}

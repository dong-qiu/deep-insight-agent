/** GET /api/admin/metrics — bounded, read-only P1 dashboard projection. */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAdminActor } from "../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../lib/db/audit.js";
import { getDb } from "../../../../lib/db/index.js";
import { dashboardWindow, readIntegrityDashboardStatus, readP1DashboardMetrics } from "../../../../lib/db/p1-dashboard.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = (): Response => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) {
    // Never include a requested range or resource identity in a denied audit.
    try { appendAudit(getDb(), { actor: "anonymous", action: "dashboard_read_denied", target: "dashboard", detail: { allowed: false, target_type: "dashboard", tenant: "default", request_id: randomUUID(), reason_code: "authorization_denied" } }); } catch { /* 404 is authoritative */ }
    return notFound();
  }

  let window;
  try {
    const url = new URL(request.url);
    window = dashboardWindow({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined });
  } catch {
    return NextResponse.json({ error: "invalid_dashboard_window" }, { status: 400 });
  }

  const db = getDb();
  appendAudit(db, { actor: actor.id, action: "dashboard_read", target: "dashboard", detail: { allowed: true, target_type: "dashboard", tenant: "default", request_id: randomUUID(), reason_code: "authorized" } });
  let metrics = null;
  let integrity = null;
  const diagnostics: { metrics: "available" | "unavailable"; integrity: "available" | "unavailable" } = { metrics: "available", integrity: "available" };
  try { metrics = readP1DashboardMetrics(db, window); } catch { diagnostics.metrics = "unavailable"; }
  try { integrity = readIntegrityDashboardStatus(db, window); } catch { diagnostics.integrity = "unavailable"; }
  return NextResponse.json({ window, metrics, integrity, diagnostics });
}

/** POST /api/admin/metrics/late-events/:factKind/:eventId/reconcile — explicit P1b-2 late-data decision. */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../../../lib/db/index.js";
import { reconcileLateMetricEvent } from "../../../../../../../../lib/db/p1-metrics-facts.js";
import { notifyMetricLateReconciliation } from "../../../../../../../../lib/runtime/metric-alert.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function validFactKind(value: string): value is "funnel" | "cost" | "validator" { return value === "funnel" || value === "cost" || value === "validator"; }
function validAction(value: unknown): value is "backfilled" | "declined" { return value === "backfilled" || value === "declined"; }

export async function POST(req: Request, { params }: { params: Promise<{ factKind: string; eventId: string }> }): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { factKind, eventId } = await params;
  const body = await req.json().catch(() => null) as { action?: unknown } | null;
  if (!validFactKind(factKind) || !validId(eventId) || !validAction(body?.action)) return NextResponse.json({ error: "invalid_metric_reconciliation" }, { status: 400 });
  try {
    const result = reconcileLateMetricEvent(getDb(), { fact_kind: factKind, event_id: eventId, action: body.action, actor_id: actor.id });
    notifyMetricLateReconciliation({ eventId, action: body.action, actorId: actor.id });
    return NextResponse.json({ ok: true, reconciliation_id: result.id, action: body.action });
  } catch (error) {
    if (error instanceof Error && error.message === "metric_late_event_not_found") return NextResponse.json({ error: "metric_late_event_not_found" }, { status: 404 });
    return NextResponse.json({ error: "metric_reconciliation_failed" }, { status: 409 });
  }
}

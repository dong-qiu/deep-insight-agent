/** Controlled lifecycle surface. Completion and physical destruction remain
 * worker-only: they require verified backup evidence and signing authority. */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { recordLegalHold, requestReportDeletion, retentionConclusionForAdmin } from "../../../../../../lib/db/integrity-lifecycle.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const validReason = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value);
const validInstant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const notFound = (): Response => NextResponse.json({ error: "not_found" }, { status: 404 });

/** The current deployment is single-tenant. Keep this explicit at the public
 * boundary so adding tenants cannot accidentally turn a request field into an
 * unscoped database lookup. */
function tenantAllowed(value: unknown): boolean {
  return value === undefined || value === "default";
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!await requireAdminActor()) return notFound();
  const { id } = await params;
  if (!validId(id)) return notFound();
  const conclusion = retentionConclusionForAdmin(getDb(), id);
  return conclusion ? NextResponse.json({ conclusion }) : notFound();
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) return notFound();
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!validId(id) || !body || !tenantAllowed(body.tenant_id)) return notFound();

  if (body.action === "place_hold" || body.action === "release_hold") {
    if (!validId(body.hold_id) || !validReason(body.reason_code)) return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
    const recorded = recordLegalHold(getDb(), {
      report_id: id, hold_id: body.hold_id, action: body.action === "place_hold" ? "placed" : "released",
      actor_id: actor.id, reason_code: body.reason_code,
    });
    return recorded ? NextResponse.json({ ok: true }) : notFound();
  }

  if (body.action === "request_deletion") {
    if (!validInstant(body.readable_until) || !validInstant(body.archive_until)) return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
    const result = requestReportDeletion(getDb(), {
      report_id: id, actor_id: actor.id, readable_until: body.readable_until, archive_until: body.archive_until,
    });
    return result.kind === "not_found" ? notFound() : NextResponse.json({ ok: true, result: result.kind });
  }

  return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
}

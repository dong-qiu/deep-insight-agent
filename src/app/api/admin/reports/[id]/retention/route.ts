/** Controlled lifecycle surface. Completion and physical destruction remain
 * worker-only: they require verified backup evidence and signing authority. */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../../../lib/db/audit.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { recordLegalHold, requestReportDeletion, retentionConclusionForAdmin } from "../../../../../../lib/db/integrity-lifecycle.js";
import { deploymentAnchorLegalHold } from "../../../../../../lib/runtime/integrity-anchor-runtime.js";

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
  return value === undefined;
}

function denied(): Response {
  try { appendAudit(getDb(), { action: "retention_lifecycle_denied", target: "retention_lifecycle", detail: { reason_code: "authorization_denied", target_type: "report", tenant: "default" } }); } catch { /* 404 remains authoritative */ }
  return notFound();
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!await requireAdminActor()) return denied();
  const { id } = await params;
  if (!validId(id)) return notFound();
  const conclusion = retentionConclusionForAdmin(getDb(), id);
  return conclusion ? NextResponse.json({ conclusion }) : notFound();
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) return denied();
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!validId(id) || !body || !tenantAllowed(body.tenant_id)) return denied();

  if (body.action === "place_hold" || body.action === "release_hold") {
    if (!validId(body.hold_id) || !validReason(body.reason_code)) return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
    let recorded: boolean;
    try {
      const external = body.action === "place_hold" ? deploymentAnchorLegalHold() : undefined;
      recorded = await recordLegalHold(getDb(), {
      report_id: id, hold_id: body.hold_id, action: body.action === "place_hold" ? "placed" : "released",
      actor_id: actor.id, reason_code: body.reason_code, store: external?.store, retain_until: external?.retainUntil,
      });
    } catch { return NextResponse.json({ error: "legal_hold_unavailable" }, { status: 503 }); }
    if (!recorded) return notFound();
    appendAudit(getDb(), { actor: actor.id, action: "retention_legal_hold_recorded", target: "retention_lifecycle", detail: { allowed: true, target_type: "report", tenant: "default", action: body.action } });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "request_deletion") {
    if (!validInstant(body.readable_until) || !validInstant(body.archive_until)) return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
    const result = requestReportDeletion(getDb(), {
      report_id: id, actor_id: actor.id, readable_until: body.readable_until, archive_until: body.archive_until,
    });
    if (result.kind === "not_found") return notFound();
    appendAudit(getDb(), { actor: actor.id, action: "retention_deletion_requested", target: "retention_lifecycle", detail: { allowed: true, target_type: "report", tenant: "default", result: result.kind } });
    return NextResponse.json({ ok: true, result: result.kind });
  }

  return NextResponse.json({ error: "invalid_retention_request" }, { status: 400 });
}

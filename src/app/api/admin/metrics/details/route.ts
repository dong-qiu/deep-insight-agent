/** GET /api/admin/metrics/details — protected, cursor-stable operational detail. */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../../lib/db/audit.js";
import { getDb } from "../../../../../lib/db/index.js";
import { listMetricDetailsPage, type FactKind } from "../../../../../lib/db/p1-metrics-facts.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const notFound = (): Response => NextResponse.json({ error: "not_found" }, { status: 404 });
type Cursor = { cursor_version: 1; kind: FactKind; from: string; to: string; as_of: string; occurred_at: string; id: string };

function kind(value: string | null): FactKind | null { return value === "funnel" || value === "cost" || value === "validator" ? value : null; }
function decode(value: string | null): Cursor | null {
  if (!value || value.length > 2048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    return parsed.cursor_version === 1 && typeof parsed.kind === "string" && typeof parsed.from === "string" && typeof parsed.to === "string" && typeof parsed.as_of === "string" && typeof parsed.occurred_at === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch { return null; }
}
function encode(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

export async function GET(request: Request): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) {
    try { appendAudit(getDb(), { actor: "anonymous", action: "dashboard_detail_read_denied", target: "dashboard_detail", detail: { allowed: false, target_type: "dashboard_detail", tenant: "default", request_id: randomUUID(), reason_code: "authorization_denied" } }); } catch { /* the uniform 404 is authoritative */ }
    return notFound();
  }
  const url = new URL(request.url); const requestedKind = kind(url.searchParams.get("kind"));
  const cursor = decode(url.searchParams.get("cursor"));
  const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
  const parsedLimit = url.searchParams.get("limit"); const limit = parsedLimit === null ? 100 : Number(parsedLimit);
  if (!requestedKind || !from || !to || (url.searchParams.has("cursor") && !cursor) || (cursor && (cursor.kind !== requestedKind || cursor.from !== from || cursor.to !== to))) return NextResponse.json({ error: "invalid_metric_detail_request" }, { status: 400 });
  const asOf = cursor?.as_of ?? new Date().toISOString();
  try {
    const db = getDb();
    const page = listMetricDetailsPage(db, { kind: requestedKind, from, to, as_of: asOf, limit, cursor: cursor ? { occurred_at: cursor.occurred_at, id: cursor.id } : null });
    appendAudit(db, { actor: actor.id, action: "dashboard_detail_read", target: "dashboard_detail", detail: { allowed: true, target_type: "dashboard_detail", tenant: "default", request_id: randomUUID(), reason_code: "authorized" } });
    return NextResponse.json({ window: { from, to }, kind: requestedKind, items: page.items, next_cursor: page.next ? encode({ cursor_version: 1, kind: requestedKind, from, to, as_of: asOf, ...page.next }) : null });
  } catch {
    return NextResponse.json({ error: "invalid_metric_detail_request" }, { status: 400 });
  }
}

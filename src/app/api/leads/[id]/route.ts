/** GET/POST /api/leads/:id —— 线索证据下钻与全局（单用户）反馈状态。 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { hashIdempotencyKey, recordManualDecision } from "../../../../lib/db/provenance.js";
import { techLeadRef, techLeadRevisionSnapshot } from "../../../../lib/db/provenance-revisions.js";
import { getTechLead, listTechLeadEvidence, setTechLeadStatus } from "../../../../lib/db/tech-leads.js";
import type { TechLeadStatus } from "../../../../lib/types.js";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TechLeadStatus>(["recommended", "watching", "dismissed"]);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const db = getDb();
  const { id } = await params;
  const lead = getTechLead(db, id);
  return lead
    ? NextResponse.json({ lead, evidence: listTechLeadEvidence(db, id) })
    : NextResponse.json({ error: "lead_not_found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TechLeadStatus)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  const before = getTechLead(db, id);
  if (!before) return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  let changed = null as ReturnType<typeof getTechLead>;
  const result = recordManualDecision(db, {
    entity: { type: "tech_lead", locator: { kind: "id", id } }, previous: techLeadRef(before), topicId: before.topic_id,
    stage: "human_review", terminalEvent: "manual_decided", action: "tech_lead_status", actorId: actor.id,
    detail: { from_status: before.status, to_status: status },
    mutate: () => {
      if (!setTechLeadStatus(db, id, status as TechLeadStatus)) return false;
      changed = getTechLead(db, id);
      return !!changed;
    },
    snapshot: () => changed ? techLeadRevisionSnapshot(changed) : null,
    output: () => changed ? techLeadRef(changed, "output") : null,
    idempotencyKeyHash: hashIdempotencyKey(`tech_lead_status:${id}:${key}`, secret),
  });
  if (result.kind === "not_found") return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  if (result.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  return NextResponse.json({ ok: true, status, trace_id: result.traceId, replayed: result.kind === "replayed" });
}

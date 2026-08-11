/** GET/POST /api/opportunities/:id —— 机会与其可追溯证据链；状态决策仅管理员可写。 */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { hashIdempotencyKey, recordManualDecision } from "../../../../lib/db/provenance.js";
import { technologyOpportunityRef, technologyOpportunityRevisionSnapshot } from "../../../../lib/db/provenance-revisions.js";
import { getTechnologyOpportunity, listOpportunityLeads, setTechnologyOpportunityStatus } from "../../../../lib/db/planning.js";
import { listTechLeadEvidence } from "../../../../lib/db/tech-leads.js";
import type { TechnologyOpportunityStatus } from "../../../../lib/types.js";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TechnologyOpportunityStatus>([
  "observed", "watching", "research_candidate", "poc_ready", "project_candidate", "adopted", "rejected", "archived",
]);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const db = getDb();
  const opportunity = getTechnologyOpportunity(db, id);
  if (!opportunity) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
  const leads = listOpportunityLeads(db, id);
  return NextResponse.json({ opportunity, leads: leads.map((lead) => ({ ...lead, evidence: listTechLeadEvidence(db, lead.id) })) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TechnologyOpportunityStatus)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  const db = getDb();
  const before = getTechnologyOpportunity(db, id);
  if (!before) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
  let changed = null as ReturnType<typeof getTechnologyOpportunity>;
  const result = recordManualDecision(db, {
    entity: { type: "technology_opportunity", locator: { kind: "id", id } }, previous: technologyOpportunityRef(before), topicId: before.topic_id,
    stage: "human_review", terminalEvent: "manual_decided", action: "technology_opportunity_status", actorId: actor.id,
    detail: { from_status: before.status, to_status: status },
    mutate: () => {
      if (!setTechnologyOpportunityStatus(db, id, status as TechnologyOpportunityStatus)) return false;
      changed = getTechnologyOpportunity(db, id);
      return !!changed;
    },
    snapshot: () => changed ? technologyOpportunityRevisionSnapshot(changed) : null,
    output: () => changed ? technologyOpportunityRef(changed, "output") : null,
    idempotencyKeyHash: hashIdempotencyKey(`technology_opportunity_status:${id}:${key}`, secret),
  });
  if (result.kind === "not_found") return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
  if (result.kind === "conflict") return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  return NextResponse.json({ ok: true, status, trace_id: result.traceId, replayed: result.kind === "replayed" });
}

/** GET/POST /api/opportunities/:id —— 机会与其可追溯证据链；状态决策仅管理员可写。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../lib/db/audit.js";
import { getDb } from "../../../../lib/db/index.js";
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
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TechnologyOpportunityStatus)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const db = getDb();
  if (!setTechnologyOpportunityStatus(db, id, status as TechnologyOpportunityStatus)) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
  appendAudit(db, { action: "technology_opportunity_status", target: id, detail: { status } });
  return NextResponse.json({ ok: true, status });
}

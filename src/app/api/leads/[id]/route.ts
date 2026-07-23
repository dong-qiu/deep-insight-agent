/** GET/POST /api/leads/:id —— 线索证据下钻与全局（单用户）反馈状态。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { appendAudit } from "../../../../lib/db/audit.js";
import { getDb } from "../../../../lib/db/index.js";
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
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const status = (await req.json().catch(() => ({})) as { status?: string }).status;
  if (!status || !STATUSES.has(status as TechLeadStatus)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  const db = getDb();
  if (!setTechLeadStatus(db, id, status as TechLeadStatus)) return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  appendAudit(db, { action: "tech_lead_status", target: id, detail: { status } });
  return NextResponse.json({ ok: true, status });
}

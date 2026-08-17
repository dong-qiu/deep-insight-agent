import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../lib/db/index.js";
import { buildGenerationTraceGraph, getGenerationTraceStatus } from "../../../../../lib/db/provenance.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function boundedPositive(value: string | null, fallback: number, max: number): number | null {
  if (value == null) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const url = new URL(req.url);
  const depth = boundedPositive(url.searchParams.get("depth"), 2, 4);
  const maxElements = boundedPositive(url.searchParams.get("max_elements"), 200, 500);
  const rootSequence = url.searchParams.get("root_sequence") == null ? undefined : boundedPositive(url.searchParams.get("root_sequence"), 0, Number.MAX_SAFE_INTEGER);
  if (depth == null || maxElements == null || rootSequence === null) return NextResponse.json({ error: "invalid_graph_budget" }, { status: 400 });
  const db = getDb();
  if (!getGenerationTraceStatus(db, id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const graph = buildGenerationTraceGraph(db, id, { depth, maxElements, rootSequence });
  if (!graph) return NextResponse.json({ error: "root_event_not_found" }, { status: 404 });
  return NextResponse.json({ graph, budget: { depth, max_elements: maxElements } });
}

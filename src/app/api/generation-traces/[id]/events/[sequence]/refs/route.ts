import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../../lib/db/index.js";
import { getGenerationTraceStatus, listGenerationEventRefs } from "../../../../../../../lib/db/provenance.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function boundedPositive(value: string | null, fallback: number, max: number): number | null {
  if (value == null) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string; sequence: string }> }): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id, sequence: rawSequence } = await params;
  const url = new URL(req.url);
  const sequence = boundedPositive(rawSequence, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedPositive(url.searchParams.get("limit"), 50, 100);
  const afterRowId = url.searchParams.get("cursor") == null ? 0 : boundedPositive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
  if (sequence == null || limit == null || afterRowId == null) return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
  const db = getDb();
  if (!getGenerationTraceStatus(db, id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const refs = listGenerationEventRefs(db, id, sequence, { limit, afterRowId });
  if (!refs) return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  return NextResponse.json({ sequence, refs });
}

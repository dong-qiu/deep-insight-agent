import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getDb } from "../../../../lib/db/index.js";
import { getGenerationTraceStatus, listGenerationTraceTimeline } from "../../../../lib/db/provenance.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function stableErrorReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { reason_code?: unknown };
    return typeof parsed.reason_code === "string" && /^[a-z0-9_]{1,64}$/.test(parsed.reason_code)
      ? parsed.reason_code
      : "dispatch_failed";
  } catch {
    return "dispatch_failed";
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const { id } = await params;
  const db = getDb();
  const trace = getGenerationTraceStatus(db, id);
  if (!trace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const terminal = ["done", "failed", "partial", "cancelled"].includes(trace.status as string);
  const lastErrorReason = stableErrorReason(trace.last_error);
  return NextResponse.json({
    trace_id: trace.trace_id, request_id: trace.request_id, status: trace.status, root_run_id: trace.root_run_id,
    started_at: trace.started_at, ended_at: trace.ended_at, coverage: trace.coverage,
    dispatch: {
      state: trace.dispatch_state, attempt: trace.attempt, claimed_at: trace.claimed_at,
      lease_expires_at: trace.lease_expires_at,
      ...(lastErrorReason ? { last_error_reason: lastErrorReason } : {}),
    },
    timeline: listGenerationTraceTimeline(db, id),
  }, { headers: terminal ? {} : { "Cache-Control": "no-store" } });
}

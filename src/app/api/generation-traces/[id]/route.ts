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

function stableRuntimeFacts(trace: Record<string, unknown>): Record<string, string | number> | undefined {
  let parsed: Record<string, unknown> = {};
  if (typeof trace.runtime_version === "string") {
    try { parsed = JSON.parse(trace.runtime_version) as Record<string, unknown>; } catch { /* legacy malformed data stays hidden */ }
  }
  const imageDigest = typeof parsed.image_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(parsed.image_digest)
    ? parsed.image_digest
    : typeof trace.deployment_image_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(trace.deployment_image_digest)
      ? trace.deployment_image_digest
      : undefined;
  const gitSha = typeof parsed.git_sha === "string" && /^[a-f0-9]{7,64}$/i.test(parsed.git_sha)
    ? parsed.git_sha
    : typeof trace.deployment_git_sha === "string" && /^[a-f0-9]{7,64}$/i.test(trace.deployment_git_sha)
      ? trace.deployment_git_sha
      : undefined;
  const provenanceSchemaVersion = typeof parsed.provenance_schema_version === "string" && /^[a-z0-9_]{1,64}$/i.test(parsed.provenance_schema_version)
    ? parsed.provenance_schema_version
    : undefined;
  const schemaVersion = typeof parsed.schema_version === "number" && Number.isSafeInteger(parsed.schema_version) && parsed.schema_version > 0
    ? parsed.schema_version
    : undefined;
  const facts = { ...(imageDigest ? { image_digest: imageDigest } : {}), ...(gitSha ? { git_sha: gitSha } : {}), ...(provenanceSchemaVersion ? { provenance_schema_version: provenanceSchemaVersion } : {}), ...(schemaVersion ? { schema_version: schemaVersion } : {}) };
  return Object.keys(facts).length ? facts : undefined;
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
  const runtime = stableRuntimeFacts(trace);
  return NextResponse.json({
    trace_id: trace.trace_id, request_id: trace.request_id, status: trace.status, root_run_id: trace.root_run_id,
    started_at: trace.started_at, ended_at: trace.ended_at, coverage: trace.coverage,
    dispatch: {
      state: trace.dispatch_state, attempt: trace.attempt, claimed_at: trace.claimed_at,
      lease_expires_at: trace.lease_expires_at,
      ...(lastErrorReason ? { last_error_reason: lastErrorReason } : {}),
    },
    ...(runtime ? { runtime } : {}),
    timeline: listGenerationTraceTimeline(db, id),
  }, { headers: terminal ? {} : { "Cache-Control": "no-store" } });
}

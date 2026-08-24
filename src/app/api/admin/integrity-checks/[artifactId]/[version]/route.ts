/** POST: authorized, on-demand revalidation of one immutable artifact version. */
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { appendAudit } from "../../../../../../lib/db/audit.js";
import { notifyIntegrityFailureOnce, verifyArtifactIntegrity } from "../../../../../../lib/db/integrity-checks.js";
import { deploymentAnchorVerificationStore } from "../../../../../../lib/runtime/integrity-anchor-runtime.js";
import { notifyIntegrityFailure } from "../../../../../../lib/runtime/integrity-alert.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const validId = (value: string): boolean => /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export async function POST(_request: Request, { params }: { params: Promise<{ artifactId: string; version: string }> }): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) {
    // Deliberately omit the requested identifiers: a denied check must not
    // create a second channel that reveals whether an artifact exists.
    try { appendAudit(getDb(), { action: "integrity_check_denied", target: "integrity_check", detail: { reason_code: "authorization_denied" } }); } catch { /* 404 remains authoritative */ }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { artifactId, version } = await params;
  if (!validId(artifactId) || !validId(version)) return NextResponse.json({ error: "invalid_integrity_check" }, { status: 400 });
  try {
    const db = getDb();
    const checked = await verifyArtifactIntegrity(db, deploymentAnchorVerificationStore(), { artifact_id: artifactId, artifact_version: version });
    appendAudit(db, { actor: actor.id, action: "integrity_check_requested", target: `${artifactId}@${version}`, detail: { outcome: checked.outcome, failure_step: checked.failure_step, checked_at: checked.checked_at } });
    notifyIntegrityFailureOnce(db, checked, notifyIntegrityFailure);
    return NextResponse.json({ ok: true, check: checked });
  } catch (error) {
    if (error instanceof Error && error.message === "integrity_artifact_not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
  }
}

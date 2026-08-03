/** POST /api/admin/reports/:id/redaction —— 管理员逻辑删除；registry 未就绪时 fail-closed。 */
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { requireAdminActor } from "../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { redactReport } from "../../../../../../lib/services/report-redaction.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function registryConfig(): { bucket: string; kms_key_id: string; hmac_secret_arn: string; hmac_key_version: string } | null {
  const bucket = process.env.REDACTION_REGISTRY_BUCKET?.trim();
  const kms_key_id = process.env.REDACTION_REGISTRY_KMS_KEY_ID?.trim();
  const hmac_secret_arn = process.env.REDACTION_HMAC_SECRET_ARN?.trim();
  const hmac_key_version = process.env.REDACTION_HMAC_KEY_VERSION?.trim();
  return bucket && kms_key_id && hmac_secret_arn && hmac_key_version ? { bucket, kms_key_id, hmac_secret_arn, hmac_key_version } : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}
function validReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value);
}
function validFutureIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Date.parse(value) > Date.now();
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = await requireAdminActor();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const config = registryConfig();
  if (!config) return NextResponse.json({ error: "redaction_registry_unavailable" }, { status: 503 });
  const body = await req.json().catch(() => null) as { deletion_request_id?: unknown; reason_code?: unknown; expiry_at?: unknown } | null;
  if (!validId(body?.deletion_request_id) || !validReason(body?.reason_code) || !validFutureIso(body?.expiry_at)) {
    return NextResponse.json({ error: "invalid_redaction_request" }, { status: 400 });
  }
  const { id } = await params;
  try {
    const result = await redactReport(getDb(), {
      report_id: id,
      deletion_request_id: body.deletion_request_id,
      reason_code: body.reason_code,
      expiry_at: body.expiry_at,
      actor_id: actor.id,
    }, config, { s3: new S3Client({}), kms: new KMSClient({}), secrets: new SecretsManagerClient({}) });
    if (result.kind === "not_found") return NextResponse.json({ error: "report_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, record_id: result.record_id, already_redacted: result.already_redacted });
  } catch (error) {
    const code = error instanceof Error ? error.message : "redaction_failed";
    if (code === "redaction_request_conflict" || code === "report_redaction_state_conflict") {
      return NextResponse.json({ error: code }, { status: 409 });
    }
    // 绝不向调用方泄露 AWS、KMS、registry object 或数据库错误细节。
    return NextResponse.json({ error: "redaction_registry_unavailable" }, { status: 503 });
  }
}

/** 管理员完整重跑失败的 durable trace；新 trace 链接旧 trace，绝不改写历史事实。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { hashIdempotencyKey, retryFailedTraceRequest } from "../../../../../../lib/db/provenance.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await forbidNonAdmin();
  if (denied) return denied;
  const key = req.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }
  const secret = process.env.PROVENANCE_IDEMPOTENCY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret || !process.env.DISPATCH_WORKER_SECRET) {
    return NextResponse.json({ error: "provenance_not_configured" }, { status: 503 });
  }

  const { id } = await params;
  let result;
  try {
    result = retryFailedTraceRequest(getDb(), {
      traceId: id,
      idempotencyKeyHash: hashIdempotencyKey(key, secret),
    });
  } catch {
    // 只有受理事务未提交时才报 unavailable；不泄露 DB 或历史 payload 的内部错误。
    return NextResponse.json({ error: "dispatch_unavailable" }, { status: 503 });
  }
  if (result.kind === "not_found") return NextResponse.json({ error: "trace_not_found" }, { status: 404 });
  if (result.kind === "not_retryable") {
    return NextResponse.json({ error: "trace_not_retryable", status: result.status }, { status: 409 });
  }
  if (result.kind === "conflict") {
    return NextResponse.json({ code: "active_generation", active_trace_id: result.activeTraceId }, { status: 409 });
  }
  return NextResponse.json(
    { trace_id: result.traceId, request_id: result.requestId, status: "accepted", replayed: result.kind === "replayed", retry_of_trace_id: id },
    { status: result.kind === "accepted" ? 202 : 200 },
  );
}
